import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeMacosRootCommand } from "@/cli";
import { makeCommandHelpLayer } from "@/cli/help";
import { makeLinuxRootCommand } from "@/cli/linux";
import { makeWindowsRootCommand } from "@/cli/windows";

const execFileAsync = promisify(execFile);

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

type Node = { path: string; command: Command.Command.Any; parent?: Node };

function nodes(command: Command.Command.Any, parent?: Node): Node[] {
  const node: Node = {
    path: parent ? [parent.path, command.name].filter(Boolean).join(" ") : "",
    command,
    parent,
  };
  return [
    node,
    ...command.subcommands.flatMap((group) => group.commands.flatMap((c) => nodes(c, node))),
  ];
}

/** Any leaf handler that is reached dies before running, so help can never execute a command. */
function guarded(command: Command.Command.Any, parentPath: string[] = []): Command.Command.Any {
  const path = [...parentPath, command.name];
  if (command.subcommands.length === 0) {
    return command.pipe(
      Command.provideEffectDiscard(Effect.die(new Error(`handler ran: ${path.join(" ")}`))),
    );
  }
  return command.pipe(
    Command.withSubcommands(
      command.subcommands.flatMap<Command.Command.SubcommandEntry>((group) => {
        const commands = group.commands.map((child) => guarded(child, path));
        return group.group === undefined ? commands : [{ group: group.group, commands }];
      }),
    ),
  );
}

async function help(root: Command.Command.Any, args: string[]) {
  vi.mocked(console.log).mockClear();
  vi.mocked(console.error).mockClear();
  const exit = await Effect.runPromiseExit(
    Command.runWith(root, { version: "1.0.0" })(args).pipe(
      Effect.provide([makeCommandHelpLayer(root), BunServices.layer]),
    ) as Effect.Effect<void, unknown>,
  );
  return {
    exit,
    stdout: vi.mocked(console.log).mock.calls.flat().join("\n"),
    stderr: vi.mocked(console.error).mock.calls.flat().join("\n"),
  };
}

const relatedNames = (output: string) =>
  output
    .split("RELATED COMMANDS\n")[1]
    ?.trim()
    .split("\n")
    .map((line) => line.trim().split(/\s{2,}/)[0]);

describe.each([
  ["linux", makeLinuxRootCommand],
  ["macos", makeMacosRootCommand],
  ["windows", makeWindowsRootCommand],
] as const)("%s command help", (_platform, makeRoot) => {
  const root = guarded(makeRoot("1.0.0"));
  const tree = nodes(root);

  test.each(tree.map((node) => [node.path || "(root)", node] as const))(
    "%s --help describes the command without running it",
    async (_name, node) => {
      const { exit, stdout, stderr } = await help(root, [
        ...(node.path ? node.path.split(" ") : []),
        "--help",
      ]);
      expect(exit, String(Exit.isFailure(exit) && exit.cause)).toStrictEqual(Exit.void);
      expect(stderr).toBe("");
      expect(stdout).toMatch(/^DESCRIPTION\n {2}\S/m);
      expect(stdout).toContain(`USAGE\n  ${[root.name, node.path].filter(Boolean).join(" ")} `);
      expect(stdout).toContain("--help, -h");
      const siblings = node.parent?.command.subcommands
        .flatMap((group) => group.commands)
        .filter((command) => !command.unlisted)
        .map((command) => [node.parent!.path, command.name].filter(Boolean).join(" "));
      expect(relatedNames(stdout)).toEqual(
        node.command.subcommands.length === 0 ? siblings : undefined,
      );
    },
  );

  test.each(tree.filter((node) => node.path && node.command.subcommands.length > 0))(
    "$path without an action shows its help and runs nothing",
    async (node) => {
      const { exit, stdout } = await help(root, node.path.split(" "));
      expect(exit).toStrictEqual(
        Exit.fail(
          new CliError.ShowHelp({ commandPath: [root.name, ...node.path.split(" ")], errors: [] }),
        ),
      );
      expect(stdout).toContain(`USAGE\n  ${root.name} ${node.path} <subcommand>`);
    },
  );
});

test("the upgrade alias shows self-update help", async () => {
  const root = guarded(makeLinuxRootCommand("1.0.0"));
  const { exit, stdout } = await help(root, ["upgrade", "--help"]);
  expect(exit).toStrictEqual(Exit.void);
  expect(stdout).toContain("USAGE\n  outfitting-manager self-update ");
});

test.each(["index.ts", "index.macos.ts", "index.windows.ts"])(
  "%s prints root help without configured state",
  async (entry) => {
    const { stdout, stderr } = await execFileAsync(
      "bun",
      [fileURLToPath(new URL(`../${entry}`, import.meta.url)), "--help"],
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
    expect(stdout).toMatch(/^DESCRIPTION\n {2}\S/m);
    expect(stdout).toContain("USAGE\n  outfitting-manager ");
  },
);

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
  const related = (output: string) =>
    output
      .split("RELATED COMMANDS\n")[1]
      ?.trim()
      .split("\n")
      .map((line) => line.trim().split(/\s{2,}/));

  const nixHelp = await help(root, ["nested", "nix", "u", "-h"]);
  expect(nixHelp.stdout).toContain("Update the selected target.");
  expect(nixHelp.stdout).toContain("--profile string");
  expect(nixHelp.stdout).toContain("target string");
  expect(related(nixHelp.stdout)).toEqual([
    ["nested nix update", "Update the selected target."],
    ["nested nix build", "Build only. Do not activate."],
  ]);
  expect(nixHelp.stdout).not.toContain("internal");
  expect(nixHelp.stdout).not.toContain("another manager");
  expect(handler).not.toHaveBeenCalled();

  const otherHelp = await help(root, ["nested", "other", "update", "--help"]);
  expect(related(otherHelp.stdout)).toEqual([["nested other update", "Update another manager."]]);
  expect(handler).not.toHaveBeenCalled();

  await help(root, ["nested", "nix", "u", "a-target", "--profile", "workstation"]);
  expect(handler).toHaveBeenCalledExactlyOnceWith({ target: "a-target", profile: "workstation" }, [
    "tool",
    "nested",
    "nix",
    "update",
  ]);
});
