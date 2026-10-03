import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { afterEach, describe, expect, test, vi } from "vitest";

import { makeCommandHelpLayer } from "@/cli/help";

const execFileAsync = promisify(execFile);
const commonPaths = [
  "",
  "init",
  "apply",
  "config",
  "config wizard",
  "config manifest",
  "source",
  "source path",
  "validate",
  "update",
  "diff",
  "sync",
  "sync configure-worker",
  "sync configure-token",
  "sync push",
  "sync pull",
  "sync list",
  "sync history",
  "status",
  "fonts",
  "fonts configure-endpoint",
  "fonts configure-credentials",
  "fonts list",
  "fonts repopulate",
  "fonts publish",
  "fonts remove",
  "provision",
  "self-update",
  "upgrade",
];
const nixPaths = [
  "nix",
  "nix build",
  "nix switch",
  "nix test",
  "nix dry-run",
  "nix update",
  "recover",
  "recover nix",
];
const backupPaths = [
  "backups",
  "backups doctor",
  "backups status",
  "backups run",
  "backups run-due",
  "backups snapshots",
  "backups check",
  "backups restore",
  "backups accept",
  "backups maintenance",
  "backups secrets",
  "backups secrets set",
  "backups secrets check",
  "backups secrets import-secretstore",
  "backups schedule",
];

afterEach(() => vi.restoreAllMocks());

describe.each([
  ["linux", "index.ts", nixPaths],
  ["macos", "index.macos.ts", [...nixPaths, ...backupPaths, "homebrew", "homebrew inventory"]],
  [
    "windows",
    "index.windows.ts",
    [
      ...backupPaths,
      "winget",
      "winget install",
      "winget uninstall",
      "scoop",
      "scoop install",
      "scoop uninstall",
    ],
  ],
] as const)("%s command help", (_platform, entry, platformPaths) => {
  const cliEntry = fileURLToPath(new URL(`../${entry}`, import.meta.url));
  test.each([...commonPaths, ...platformPaths])(
    "%s --help succeeds without configured state or required arguments",
    async (path) => {
      const { stdout, stderr } = await execFileAsync(
        "bun",
        [cliEntry, ...(path ? path.split(" ") : []), "--help"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NO_COLOR: "1",
            OUTFITTING_CONFIG: "/does-not-exist/help-config.toml",
          },
        },
      );
      expect(stderr).toBe("");
      expect(stdout).toMatch(/^DESCRIPTION\n  \S/m);
      const canonicalPath = path === "upgrade" ? "self-update" : path;
      expect(stdout).toContain(
        `USAGE\n  outfitting-manager${canonicalPath ? ` ${canonicalPath}` : ""} `,
      );
      expect(stdout).toContain("--help, -h");
      if (
        [
          "nix update",
          "winget install",
          "scoop install",
          "config manifest",
          "fonts publish",
          "sync pull",
        ].includes(path)
      ) {
        const related = stdout.split("RELATED COMMANDS\n")[1];
        expect(related).toBeDefined();
        const parent = path.split(" ")[0];
        expect(
          related!
            .trim()
            .split("\n")
            .every((line) => line.trim().startsWith(`${parent} `)),
        ).toBe(true);
      }
      if (path === "nix update") {
        expect(stdout).toContain("--profile");
        expect(stdout).not.toContain("--no-push");
        expect(
          stdout
            .split("RELATED COMMANDS\n")[1]
            ?.trim()
            .split("\n")
            .map((line) => line.trim().split(/\s{2,}/)[0]),
        ).toEqual(["nix build", "nix switch", "nix test", "nix dry-run", "nix update"]);
        expect(stdout).toMatch(/nix build +Build .* without activating\./);
        expect(stdout).toMatch(/nix switch +Build and activate/);
        expect(stdout).toMatch(/nix update +Update flake inputs, build, and activate/);
        expect(stdout).toContain(_platform === "linux" ? "Home Manager" : "nix-darwin");
      }
    },
  );
});

test("help preserves parsing and isolates same-named commands in nested families", async () => {
  const handler = vi.fn(() => Effect.void);
  const update = Command.make(
    "update",
    {
      target: Argument.String("target"),
      profile: Flag.String("profile"),
    },
    handler,
  ).pipe(Command.withDescription("Update the selected target."), Command.withAlias("u"));
  const build = Command.make("build", {}, handler).pipe(
    Command.withDescription("Build the target\nwithout activating it."),
    Command.withShortDescription("Build only.\nDo not activate."),
  );
  const hidden = Command.make("internal", {}, handler).pipe(Command.unlisted);
  const family = Command.make("nix").pipe(Command.withSubcommands([update, build, hidden]));
  const other = Command.make("other").pipe(
    Command.withSubcommands([
      Command.make("update", {}, handler).pipe(Command.withDescription("Update another manager.")),
    ]),
  );
  const root = Command.make("tool").pipe(
    Command.withSubcommands([
      Command.make("nested").pipe(Command.withSubcommands([family, other])),
    ]),
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const run = (args: string[]) =>
    Effect.runPromise(
      Command.runWith(root, { version: "1.0.0" })(args).pipe(
        Effect.provide([makeCommandHelpLayer(root), BunServices.layer]),
      ),
    );

  await run(["nested", "nix", "u", "-h"]);
  const help = log.mock.calls.flat().join("\n");
  expect(help).toContain("Update the selected target.");
  expect(help).toContain("--profile string");
  expect(help).toContain("target string");
  expect(help.split("RELATED COMMANDS\n")[1]?.trim().split("\n")).toEqual([
    "nested nix update    Update the selected target.",
    "  nested nix build     Build only. Do not activate.",
  ]);
  expect(help).not.toContain("internal");
  expect(help).not.toContain("another manager");
  expect(handler).not.toHaveBeenCalled();

  log.mockClear();
  await run(["nested", "other", "update", "--help"]);
  expect(log.mock.calls.flat().join("\n")).toContain(
    "nested other update    Update another manager.",
  );
  expect(handler).not.toHaveBeenCalled();

  await run(["nested", "nix", "u", "a-target", "--profile", "workstation"]);
  expect(handler).toHaveBeenCalledExactlyOnceWith({ target: "a-target", profile: "workstation" }, [
    "tool",
    "nested",
    "nix",
    "update",
  ]);
});
