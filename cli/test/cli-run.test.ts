import { spawnSync } from "node:child_process";

import { Effect, Exit, Terminal } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { runCli } from "@/cli/run";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import type { runCommand } from "@/process";
import { TerminalSession, withTerminalInput, type TerminalSessionControls } from "@/terminal-alert";
import { withActivity, withProgress } from "@/ui/progress";
import { activateNixSystem } from "@/update/nix/activate";

const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});

function output() {
  const chunks: string[] = [];
  return {
    chunks,
    options: {
      stream: { isTTY: true, write: (chunk: string) => chunks.push(chunk) },
      env: {},
    },
  };
}

test("canonical command titles precede the handler and preserve grouped aliases and shared flags", async () => {
  const captured = output();
  const family = Command.make("nix").pipe(
    Command.withSharedFlags({ profile: Flag.String("profile") }),
  );
  const values: string[] = [];
  const child = Command.make("switch", { token: Argument.String("token") }, ({ token }) =>
    Effect.gen(function* () {
      const parent = yield* family;
      values.push(`${parent.profile}:${token}`);
      expect(captured.chunks).toContain("\u001b]2;Outfitting: Working\u001b\\");
    }),
  ).pipe(Command.withAlias("s"));
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([
      { group: "Maintenance", commands: [family.pipe(Command.withSubcommands([child]))] },
    ]),
  );

  await Effect.runPromise(
    runCli(
      root,
      "1.0.0",
      ["nix", "s", "secret-token", "--profile", "private-profile"],
      captured.options,
    ),
  );

  expect(values).toEqual(["private-profile:secret-token"]);
  expect(captured.chunks.join("")).not.toContain("secret-token");
  expect(captured.chunks.join("")).not.toContain("private-profile");
  expect(captured.chunks.at(-1)).toContain("state=done");
  expect(process.exitCode).toBeUndefined();
});

test.each(
  [
    [],
    ["--help"],
    ["--version"],
    ["nix"],
    ["nix", "switch", "--help"],
    ["nix", "switch"],
    ["nix", "switch", "target", "--bad-flag"],
  ].map((args) => ({ args })),
)("help/version/parse errors ($args) never start terminal reporting", async ({ args }) => {
  const captured = output();
  const handler = vi.fn(() => Effect.void);
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([
      Command.make("nix").pipe(
        Command.withSubcommands([
          Command.make("switch", { target: Argument.String("target") }, handler),
        ]),
      ),
    ]),
  );

  await Effect.runPromise(runCli(root, "1.0.0", args, captured.options));

  expect(captured.chunks).toEqual([]);
  expect(handler).not.toHaveBeenCalled();
});

test.each(["failure", "defect"])("%s retains the error and preserves exit code", async (kind) => {
  const captured = output();
  const failed =
    kind === "failure"
      ? Effect.fail(new CliFailure({ message: "token=SECRET" }))
      : Effect.die(new Error("token=SECRET"));
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([Command.make("update", {}, () => failed)]),
  );

  await Effect.runPromise(runCli(root, "1.0.0", ["update"], captured.options));

  expect(process.exitCode).toBe(1);
  expect(captured.chunks.at(-1)).toContain("state=error");
  expect(captured.chunks).toContain("\u001b]2;Outfitting: Failed\u001b\\");
  expect(captured.chunks.join("")).not.toContain("SECRET");
  expect(captured.chunks.join("")).not.toContain("state=clear");
  expect(captured.chunks.join("")).not.toContain("\u0007");
});

test("interruption reports idle and seals captured callbacks", async () => {
  const captured = output();
  let callbacks: TerminalSessionControls | undefined;
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([
      Command.make("update", {}, () =>
        Effect.gen(function* () {
          callbacks = yield* TerminalSession;
          callbacks.phase("Downloading");
          callbacks.alert("password-required");
          return yield* Effect.interrupt;
        }),
      ),
    ]),
  );

  const exit = await Effect.runPromiseExit(runCli(root, "1.0.0", ["update"], captured.options));
  expect(Exit.hasInterrupts(exit)).toBe(true);
  expect(captured.chunks.at(-1)).toContain("state=idle");
  expect(captured.chunks.join("")).not.toContain("state=error");
  const beforeLateCallback = [...captured.chunks];
  callbacks!.resume();
  callbacks!.phase("Late work");
  callbacks!.alert("error");
  expect(captured.chunks).toEqual(beforeLateCallback);
});

test("shared activity progress updates the title without inventing a percentage", async () => {
  const captured = output();
  const progressOutput = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WriteStream;
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([
      Command.make("apply", {}, () =>
        withActivity("Installing packages", Effect.void, { stream: progressOutput }),
      ),
    ]),
  );

  await Effect.runPromise(runCli(root, "1.0.0", ["apply"], captured.options));

  expect(captured.chunks.filter((chunk) => chunk.startsWith("\u001b]2;"))).toEqual([
    "\u001b]2;Outfitting: Working\u001b\\",
    "\u001b]2;Outfitting: Installing packages\u001b\\",
    "\u001b]2;Outfitting: Done\u001b\\",
  ]);
  expect(captured.chunks.join("")).not.toContain("progress=");
});

test("reporting does not read, subscribe to input data, or change stdin", async () => {
  const captured = output();
  const read = vi.spyOn(process.stdin, "read");
  const on = vi.spyOn(process.stdin, "on");
  const setEncoding = vi.spyOn(process.stdin, "setEncoding");
  const resume = vi.spyOn(process.stdin, "resume");
  const pause = vi.spyOn(process.stdin, "pause");
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([Command.make("status", {}, () => Effect.void)]),
  );

  await Effect.runPromise(runCli(root, "1.0.0", ["status"], captured.options));

  expect(read).not.toHaveBeenCalled();
  expect(on.mock.calls.filter(([event]) => event === "data" || event === "readable")).toEqual([]);
  expect(setEncoding).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
  expect(captured.chunks.join("")).not.toContain("7501;?");
});

test.each(["SIGINT", "SIGTERM"])("runMain installs %s handling before titles start", (signal) => {
  const result = spawnSync(
    "bun",
    [
      "-e",
      `
      import { BunRuntime } from "@effect/platform-bun";
      import { Effect } from "effect";
      import { Command } from "effect/cli";
      import { runCli } from "./src/cli/run";
      const root = Command.make("outfitting-manager").pipe(Command.withSubcommands([
        Command.make("demo", {}, () => Effect.sleep("30 seconds")),
      ]));
      let interrupted = false;
      BunRuntime.runMain(runCli(root, "1.0.0", ["demo"], {
        stream: { isTTY: true, write: (text) => {
          process.stdout.write(text);
          if (!interrupted) {
            interrupted = true;
            if (process.listenerCount("${signal}") === 0) process.exit(2);
            process.kill(process.pid, "${signal}");
          }
        } },
        env: {},
      }), { disableErrorReporting: true });
      `,
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000 },
  );

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(130);
  expect(result.stdout).toContain("state=idle");
  expect(result.stdout).not.toContain("state=error");
  expect(result.stdout).toContain("\u001b]2;Outfitting: Cancelled\u001b\\");
  expect(result.stdout).not.toContain("state=done");
});

test.each([0, 7])(
  "sudo authentication integrates with scoped status and exit handling (exit %s)",
  async (code) => {
    const captured = output();
    const observed: string[] = [];
    const run = vi.fn<typeof runCommand>().mockImplementation(async (_command, args) => {
      const stage =
        args[0] === "-n" ? "check" : args.includes("nix-env") ? "set-profile" : "activate";
      const current = captured.chunks.filter((chunk) => chunk.startsWith("\u001b]7501;")).at(-1)!;
      observed.push(`${stage}:${current.match(/state=([a-z]+)/)![1]}`);
      return {
        code: stage === "check" ? 1 : stage === "set-profile" ? code : 0,
        stdout: "",
        stderr: "",
      };
    });
    const root = Command.make("outfitting-manager").pipe(
      Command.withSubcommands([
        Command.make("switch", {}, () =>
          Effect.flatMap(TerminalSession, (session) => {
            session.phase("Activating");
            return tryPromise(() =>
              activateNixSystem({
                systemConfig: "/nix/store/system",
                run,
                alert: session.alert,
                resume: session.resume,
              }),
            );
          }),
        ),
      ]),
    );

    await Effect.runPromise(runCli(root, "1.0.0", ["switch"], captured.options));

    expect(observed).toEqual(
      code === 0
        ? ["check:working", "set-profile:blocked", "activate:working"]
        : ["check:working", "set-profile:blocked"],
    );
    expect(process.exitCode).toBe(code === 0 ? undefined : 1);
    expect(captured.chunks.at(-1)).toContain(code === 0 ? "state=done" : "state=error");
  },
);

test.each([
  "handler-cli-error",
  "cleanup-defect",
  "exit-code",
  "interrupt-with-defect",
  "quit-with-defect",
])("%s cannot be published as successful completion or pure cancellation", async (scenario) => {
  const captured = output();
  const cleanup = Effect.addFinalizer(() => Effect.die(new Error("cleanup failed")));
  const effects = {
    "handler-cli-error": Effect.fail(new CliError.UserError({ cause: "failed" })),
    "cleanup-defect": cleanup,
    "exit-code": Effect.sync(() => {
      process.exitCode = 7;
    }),
    "interrupt-with-defect": cleanup.pipe(Effect.andThen(Effect.interrupt)),
    "quit-with-defect": withTerminalInput(Effect.fail(new Terminal.QuitError())).pipe(
      Effect.orDie,
      Effect.ensuring(Effect.die(new Error("cleanup failed"))),
    ),
  };
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([
      Command.make("apply", {}, () => effects[scenario as keyof typeof effects]),
    ]),
  );
  await Effect.runPromiseExit(runCli(root, "1.0.0", ["apply"], captured.options));
  expect(captured.chunks.at(-1)).toContain("state=error");
  expect(captured.chunks.join("")).not.toContain("state=done");
  expect(captured.chunks.join("")).not.toContain("state=idle");
});

test.each(["explicit", "implicit"])(
  "%s credential Ctrl-C reports cancellation and stores nothing",
  (mode) => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
    import { BunRuntime } from "@effect/platform-bun";
    import { Command } from "effect/cli";
    import { runCli } from "./src/cli/run";
    import { configureToken } from "./src/sync/configure";
    import { apiToken } from "./src/sync/keychain";
    delete process.env.AMP_ORB;
    delete process.env.OUTFITTING_SYNC_TOKEN;
    Object.defineProperty(process.stdin, "isTTY", { value: true });
    process.stdin.setRawMode = () => {};
    Bun.secrets = {
      get: async () => null,
      set: async () => { throw new Error("Must not save credentials"); },
    };
    const handler = ${mode === "explicit" ? "configureToken" : "apiToken"};
    const root = Command.make("outfitting-manager").pipe(Command.withSubcommands([
      Command.make("demo", {}, () => handler),
    ]));
    const on = process.stdin.on.bind(process.stdin);
    process.stdin.on = (event, listener) => {
      const result = on(event, listener);
      if (event === "data") queueMicrotask(() => process.stdin.emit("data", "\\u0003"));
      return result;
    };
    BunRuntime.runMain(runCli(root, "1.0.0", ["demo"], {
      stream: { isTTY: true, write: (text) => process.stdout.write(text) }, env: {},
    }), { disableErrorReporting: true });
  `,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(130);
    expect(result.stdout).toContain("state=blocked");
    expect(result.stdout).toContain("kind=auth");
    expect(result.stdout).toContain("state=idle");
    expect(result.stdout).not.toContain("state=error");
    expect(result.stdout).not.toContain("state=done");
  },
);

test.skipIf(process.platform === "win32").each(["cancel", "answer"])(
  "plaintext credential prompt handles %s in a real PTY",
  (action) => {
    const source = `
      import { BunRuntime } from "@effect/platform-bun";
      import { Command } from "effect/cli";
      import { runCli } from "./src/cli/run";
      import { configureWorker } from "./src/sync/configure";
      Bun.secrets = { set: async ({ value }) => console.log("stored:" + value) };
      const root = Command.make("outfitting-manager").pipe(Command.withSubcommands([
        Command.make("demo", {}, () => configureWorker()),
      ]));
      BunRuntime.runMain(runCli(root, "1.0.0", ["demo"]), { disableErrorReporting: true });
    `;
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
        let output = "";
        let sent = false;
        const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(source)}], {
          env: { ...process.env, TERM: "xterm-256color", OUTFITTING_PROGRAM_STATUS: "1" },
          terminal: { data(terminal, data) {
            output += Buffer.from(data).toString();
            if (!sent && output.includes("keychain)")) {
              sent = true;
              setTimeout(() => terminal.write(${JSON.stringify(action === "cancel" ? "\u0003" : "https://sync.example.test\r")}), 20);
            }
          } },
        });
        const code = await child.exited;
        await Bun.sleep(20);
        child.terminal.close();
        process.stdout.write(output);
        process.exitCode = code;
        `,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(action === "cancel" ? 130 : 0);
    expect(result.stdout).toContain("state=blocked");
    expect(result.stdout).toContain("kind=question");
    expect(result.stdout).toContain(action === "cancel" ? "state=idle" : "state=done");
    expect(result.stdout).not.toContain("state=error");
    if (action === "cancel") {
      expect(result.stdout).not.toContain("stored:");
      expect(result.stdout).not.toContain("state=done");
    } else {
      expect(result.stdout).toContain("stored:https://sync.example.test");
    }
  },
);

test("tracked operation progress counts attempts and drops the percentage in the next activity", async () => {
  const captured = output();
  const progressOutput = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WriteStream;
  const observed: string[] = [];
  const observe = () => observed.push(captured.chunks.at(-1)!);
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([
      Command.make("apply", {}, () =>
        Effect.gen(function* () {
          yield* withProgress(
            "Apply",
            3,
            (progress) =>
              Effect.gen(function* () {
                yield* progress.track("First", Effect.sync(observe));
                yield* progress.track("Second", Effect.fail("failed")).pipe(Effect.ignore);
                yield* progress.track("Third", Effect.sync(observe));
              }),
            { stream: progressOutput },
          );
          yield* withActivity("Publishing", Effect.sync(observe), { stream: progressOutput });
        }),
      ),
    ]),
  );
  await Effect.runPromise(runCli(root, "1.0.0", ["apply"], captured.options));
  expect(observed[0]).toContain("progress=0");
  expect(observed[1]).toContain("progress=66");
  expect(observed[2]).not.toContain("progress=");
  expect(captured.chunks.some((chunk) => chunk.includes("progress=100"))).toBe(true);
  expect(captured.chunks.at(-1)).toContain("state=done");
});
