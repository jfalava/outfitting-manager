import { spawnSync } from "node:child_process";

import { Effect } from "effect";
import { Command } from "effect/cli";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { makeMacosRootCommand } from "@/cli";
import { makeLinuxRootCommand } from "@/cli/linux";
import { runCli } from "@/cli/run";
import { makeWindowsRootCommand } from "@/cli/windows";
import { makeDebugCommand } from "@/commands/debug";
import { outputPreviews } from "@/debug/output";

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

async function run(args: string[]) {
  const statuses: string[] = [];
  const root = Command.make("outfitting-manager").pipe(
    Command.withSubcommands([makeDebugCommand("macos")]),
  );
  await Effect.runPromise(
    runCli(root, "0.8.0", ["debug", "output", ...args, "--delay-ms", "0"], {
      stream: { isTTY: true, write: (value) => statuses.push(value) },
      env: {},
    }),
  );
  return {
    stdout: vi.mocked(console.log).mock.calls.flat().join("\n"),
    stderr: vi.mocked(console.error).mock.calls.flat().join("\n"),
    statuses: statuses.join(""),
  };
}

function leaves(command: Command.Command.Any, path: string[] = []): string[] {
  return command.subcommands.flatMap((group) =>
    group.commands.flatMap((child) =>
      child.subcommands.length === 0
        ? [[...path, child.name].join(" ")]
        : leaves(child, [...path, child.name]),
    ),
  );
}

test.each([
  ["macos", makeMacosRootCommand],
  ["linux", makeLinuxRootCommand],
  ["windows", makeWindowsRootCommand],
] as const)("%s gallery covers every production command exactly once", (platform, makeRoot) => {
  const paths = outputPreviews(platform).map((preview) => preview.path);
  expect(paths.toSorted()).toEqual(
    leaves(makeRoot("0.8.0"))
      .filter((path) => !path.startsWith("debug "))
      .toSorted(),
  );
});

test.each(["macos", "linux", "windows"] as const)(
  "%s populated and empty fixtures run with network, subprocesses and credentials forbidden",
  (platform) => {
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
        import fs from "node:fs";
        import promises from "node:fs/promises";
        import subprocess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        const forbidden = () => { throw new Error("Preview attempted live IO"); };
        globalThis.fetch = forbidden;
        Bun.spawn = forbidden;
        Bun.spawnSync = forbidden;
        Bun.write = forbidden;
        Bun.secrets = { get: forbidden, set: forbidden, delete: forbidden };
        for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
          subprocess[name] = forbidden;
        }
        for (const name of ["writeFile", "appendFile", "mkdir", "rm", "unlink", "rename", "copyFile", "chmod", "link", "symlink"]) {
          fs[name] = forbidden;
          fs[name + "Sync"] = forbidden;
          promises[name] = forbidden;
        }
        fs.createWriteStream = forbidden;
        syncBuiltinESMExports();
        const { Effect } = await import("effect");
        const { Command } = await import("effect/cli");
        const { runCli } = await import("./src/cli/run");
        const { makeDebugCommand } = await import("./src/commands/debug");
        const { outputPreviews } = await import("./src/debug/output");
        const root = Command.make("outfitting-manager").pipe(Command.withSubcommands([
          makeDebugCommand("${platform}"),
        ]));
        const run = (args) => Effect.runPromise(runCli(root, "0.8.0", [
          "debug", "output", ...args, "--delay-ms", "0",
        ]));
        await run(["all"]);
        for (const preview of outputPreviews("${platform}").filter(p => p.empty)) {
          await run([...preview.path.split(" "), "--state", "empty"]);
        }
        `,
      ],
      {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, NO_COLOR: "1", OUTFITTING_CONFIG: "/no-preview-config.toml" },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Example Sans");
    expect(result.stdout).toContain("No history for preview:");
    expect(result.stderr).toContain("Sample package-manager note.");
    expect(result.stderr).not.toContain("\u001b]7501;");
  },
);

test("listing, family selection, cross-platform data and aliases", async () => {
  const listing = await run([]);
  expect(listing.stdout).toContain("Output previews (macos)");
  expect(listing.stdout).toContain("backups schedule");
  expect(listing.stderr).toBe("");
  vi.mocked(console.log).mockClear();
  const sync = await run(["sync", "--platform", "linux"]);
  expect(sync.stdout).toContain("preview:arm64-linux/nix");
  expect(sync.stdout).not.toContain("Example Sans");
  expect(sync.stderr).not.toContain("Preview: apply");
  vi.mocked(console.log).mockClear();
  const source = await run(["source", "path", "--platform", "windows"]);
  expect(source.stdout).toBe("C:/Users/preview/Developer/outfitting");
  vi.mocked(console.log).mockClear();
  const alias = await run(["upgrade", "--state", "empty"]);
  expect(alias.stdout).toContain("already up to date");
  vi.mocked(console.log).mockClear();
  const manifest = await run(["config", "manifest"]);
  expect(manifest.stdout).toContain("Review outfitting.json:");
  expect(manifest.stdout).toContain('"manifest": "windows/workstation.json"');
  expect(manifest.stdout).not.toContain("Review config.toml:");
});

test("shared tables, machine-readable output and status progress", async () => {
  const history = await run(["sync", "history"]);
  expect(history.stdout).toContain("CREATED_AT\tSIZE\tHASH");
  expect(history.stdout).toContain("2026-10-25T10:00:00Z\t968");
  vi.mocked(console.log).mockClear();
  const backup = await run(["backups", "status"]);
  expect(JSON.parse(backup.stdout)).toMatchObject([
    { job: "documents", outcome: "accepted-changed" },
  ]);
  const apply = await run(["apply"]);
  expect(apply.statuses).toContain("progress=33");
  expect(apply.statuses).toContain("progress=66");
  expect(apply.statuses).toContain("progress=100");
  expect(apply.statuses).toContain("state=done");
});

test.each([
  [["missing"], "No macos output preview"],
  [["all", "--state", "error"], "Select one command"],
  [["source", "path", "--state", "empty"], "No empty preview"],
  [["source", "path", "--state", "blocked"], "has no input-waiting preview"],
  [["sync", "configure", "token", "--state", "blocked"], "interactive terminal"],
] as const)(
  "invalid selection %j fails without producing fixture output",
  async (args, message) => {
    const result = await run([...args]);
    expect(process.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
    expect(result.statuses).toContain("state=error");
  },
);

test.each(["error", "cancelled"])("synthetic %s emits its terminal outcome", async (state) => {
  const result = await run(["apply", "--state", state]);
  expect(result.statuses).toContain(state === "error" ? "state=error" : "state=idle");
  expect(result.statuses).not.toContain("state=done");
  expect(process.exitCode).toBe(state === "error" ? 1 : undefined);
});

test.skipIf(process.platform === "win32").each([
  ["config wizard", "macos", "question", "workstation\r", 0, "done"],
  ["fonts publish", "macos", "permission", "n\r", 0, "idle"],
  ["apply", "windows", "permission", "y\r", 0, "done"],
  ["sync configure token", "macos", "auth", "dummy-secret\r", 0, "done"],
  ["sync configure token", "macos", "auth", "\u0003", 130, "idle"],
] as const)(
  "%s %s blocked preview in a real PTY",
  (path, platform, kind, answer, code, outcome) => {
    const args = [
      "index.macos.ts",
      "debug",
      "output",
      ...path.split(" "),
      "--platform",
      platform,
      "--state",
      "blocked",
    ];
    const result = spawnSync(
      "bun",
      [
        "-e",
        `
    import { stripVTControlCharacters } from "node:util";
    let output = "";
    let sent = false;
    const child = Bun.spawn([process.execPath, ...${JSON.stringify(args)}], {
      env: { ...process.env, TERM: "xterm-256color", OUTFITTING_PROGRAM_STATUS: "1" },
      terminal: { data(terminal, data) {
        output += Buffer.from(data).toString();
        if (!sent && stripVTControlCharacters(output).includes("? ")) {
          sent = true;
          setTimeout(() => terminal.write(${JSON.stringify(answer)}), 100);
        }
      } },
    });
    const code = await child.exited;
    await Bun.sleep(30);
    child.terminal.close();
    process.stdout.write(output);
    process.exitCode = code;
  `,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 5000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout).toBe(code);
    expect(result.stdout).toContain("state=blocked");
    expect(result.stdout).toContain(`kind=${kind}`);
    expect(result.stdout).toContain(`state=${outcome}`);
    expect(result.stdout).not.toContain("dummy-secret");
    expect(result.stdout).not.toContain("state=error");
  },
);
