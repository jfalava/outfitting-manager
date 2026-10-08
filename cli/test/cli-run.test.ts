import { spawnSync } from "node:child_process";

import { Effect, Exit } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { runCli } from "@/cli/run";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import type { runCommand } from "@/process";
import { TerminalSession, type TerminalSessionControls } from "@/terminal-alert";
import { withActivity } from "@/ui/progress";
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

function output(status = true) {
  const chunks: string[] = [];
  return {
    chunks,
    options: {
      stream: { isTTY: true, write: (chunk: string) => chunks.push(chunk) },
      env: { OUTFITTING_TITLE_PROTOCOL: "xterm-window-stack" },
      supportsStatus: vi.fn(() => status),
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
      expect(captured.chunks).toContain("\u001b]2;Outfitting · nix switch · Working\u001b\\");
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
  expect(captured.chunks.filter((chunk) => chunk === "\u001b[22;2t")).toHaveLength(1);
  expect(captured.chunks.at(-1)).toBe("\u001b[23;2t");
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
  expect(captured.options.supportsStatus).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});

test.each(["failure", "defect"])(
  "%s reports the error before restoring and preserves exit code",
  async (kind) => {
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
    expect(captured.chunks.at(-1)).toBe("\u001b[23;2t");
    expect(captured.chunks.at(-2)).toContain("state=error");
    expect(captured.chunks).toContain("\u001b]2;Outfitting · update · Failed\u001b\\");
    expect(captured.chunks.join("")).not.toContain("SECRET");
    expect(captured.chunks.join("")).not.toContain("state=clear");
    expect(captured.chunks.join("")).not.toContain("\u0007");
  },
);

test("interruption restores the title, reports idle, and seals captured callbacks", async () => {
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
  expect(captured.chunks.at(-2)).toContain("state=idle");
  expect(captured.chunks.at(-1)).toBe("\u001b[23;2t");
  expect(captured.chunks.join("")).not.toContain("state=error");
  const beforeLateCallback = [...captured.chunks];
  callbacks!.resume();
  callbacks!.phase("Late work");
  callbacks!.alert("error");
  expect(captured.chunks).toEqual(beforeLateCallback);
});

test("shared activity progress updates the command title while keeping success silent", async () => {
  const captured = output(false);
  const progressOutput = { isTTY: false, write: vi.fn() } as unknown as NodeJS.WriteStream;
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([
      Command.make("apply", {}, () =>
        withActivity("Installing packages", Effect.void, { stream: progressOutput }),
      ),
    ]),
  );

  await Effect.runPromise(runCli(root, "1.0.0", ["apply"], captured.options));

  expect(captured.chunks).toEqual([
    "\u001b[22;2t",
    "\u001b]2;Outfitting · apply · Working\u001b\\",
    "\u001b]2;Outfitting · apply · Installing packages\u001b\\",
    "\u001b[23;2t",
  ]);
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
        env: { OUTFITTING_TITLE_PROTOCOL: "xterm-window-stack" },
        supportsStatus: () => true,
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
  expect(result.stdout.match(/\u001b\[22;2t/g)).toHaveLength(1);
  expect(result.stdout.match(/\u001b\[23;2t/g)).toHaveLength(1);
  expect(result.stdout.endsWith("\u001b[23;2t")).toBe(true);
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
    expect(captured.chunks.at(-2)).toContain(code === 0 ? "state=clear" : "state=error");
    expect(captured.chunks.at(-1)).toBe("\u001b[23;2t");
  },
);
