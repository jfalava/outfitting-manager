import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import { parseWindowsPackageList } from "@/commands/windows-apply";
import { runWindowsPackageBatch, windowsPackageCommandArgs } from "@/commands/windows-packages";
import type { ManagerConfig } from "@/config";
import type { RunCommandResult } from "@/process";
import { parseScoopManifest, updateScoop } from "@/update/scoop";
import { scoopScriptPath } from "@/update/scoop-command";
import {
  isWingetAlreadyInstalledExitCode,
  isWingetPackageAbsentExitCode,
  readWindowsLock,
  recordWindowsOperation,
  windowsLockPath,
  writeWindowsLock,
} from "@/update/windows-lock";
import {
  captureBunGlobalInventory,
  captureScoopInventory,
  exportWingetInventory,
} from "@/update/windows-snapshot";
import { updateWinget, wingetPackageArgs } from "@/update/winget";

const temps: string[] = [];
const ok = (stdout = ""): RunCommandResult => ({ code: 0, stdout, stderr: "" });
const execFileAsync = promisify(execFile);
const windowsEntry = fileURLToPath(new URL("../index.windows.ts", import.meta.url));

afterEach(async () => {
  await Promise.all(temps.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temps.push(root);
  return root;
}

async function runWindowsCli(args: string[]): Promise<{ code: number; text: string }> {
  try {
    const result = await execFileAsync("bun", [windowsEntry, ...args], { encoding: "utf8" });
    return { code: 0, text: `${result.stdout}\n${result.stderr}` };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      text: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`,
    };
  }
}

describe("Windows CLI entrypoint", () => {
  test("registers distinct init, apply, native update, and self-update commands", async () => {
    const root = await runWindowsCli(["--help"]);
    const config = await runWindowsCli(["config", "--help"]);
    const wizard = await runWindowsCli(["config", "wizard", "--help"]);
    const configManifest = await runWindowsCli(["config", "manifest", "--help"]);
    const configMigrate = await runWindowsCli(["config", "migrate"]);
    const source = await runWindowsCli(["source", "--help"]);
    const init = await runWindowsCli(["init", "--help"]);
    const apply = await runWindowsCli(["apply", "--help"]);
    const update = await runWindowsCli(["update", "--help"]);
    const foreign = await runWindowsCli(["update", "brew"]);
    const setup = await runWindowsCli(["setup", "--help"]);
    const wingetInstall = await runWindowsCli(["winget", "install", "--help"]);
    const wingetUninstall = await runWindowsCli(["winget", "uninstall", "--help"]);
    const scoopInstall = await runWindowsCli(["scoop", "install", "--help"]);
    const scoopUninstall = await runWindowsCli(["scoop", "uninstall", "--help"]);

    expect(root.code).toBe(0);
    expect(root.text).toMatch(/\bconfig\b/);
    expect(root.text).toMatch(/\bsource\b/);
    expect(root.text).toMatch(/\binit\b/);
    expect(root.text).toMatch(/\bapply\b/);
    expect(root.text).toMatch(/\bself-update\b/);
    expect(root.text).toMatch(/self-update.*upgrade/);
    expect(root.text).not.toMatch(/^\s+setup\s/m);
    expect(config.text).toMatch(/\bwizard\b/i);
    expect(config.text).toMatch(/\bmanifest\b/i);
    expect(config.text).not.toMatch(/\bmigrate\b/i);
    expect(configManifest.text).toContain("--repo");
    expect(configManifest.text).toContain("--force");
    expect(configMigrate.code).not.toBe(0);
    expect(source.text).toMatch(/path/i);
    expect(init.text).toMatch(/source/i);
    expect(init.text).toMatch(/--no-refresh/);
    expect(apply.text).toMatch(/profile/i);
    expect(apply.text).toMatch(/package/i);
    expect(apply.text).toContain("--strict");
    expect(wizard.text).toContain("--strict");
    expect(wizard.text).toContain("--manifest");
    expect(update.text).toMatch(/\bwinget\b/);
    expect(update.text).toMatch(/\bscoop\b/);
    expect(update.text).toMatch(/--package-manager/);
    expect(update.text).not.toMatch(/outfitting-manager update <subcommand>|^\s+all\s/m);
    expect(update.text).not.toMatch(/--manifest|--route/);
    expect(foreign.code).not.toBe(0);
    expect(setup.text).not.toMatch(/^\s+setup\s/m);
    expect(wingetInstall.text).toContain("--strict");
    expect(wingetUninstall.text).not.toContain("--strict");
    expect(scoopInstall.text).toContain("--strict");
    expect(scoopUninstall.text).not.toContain("--strict");
  }, 15_000);
});

describe("WinGet declarations and commands", () => {
  test("deduplicates package IDs and rejects command fragments", () => {
    expect(
      parseWindowsPackageList("# comment\nGit.Git\ngit.git\nOven-sh.Bun\n", "base.txt"),
    ).toEqual([{ name: "Git.Git" }, { name: "Oven-sh.Bun" }]);
    expect(() => parseWindowsPackageList("Git.Git --silent\n", "base.txt")).toThrow(
      /Invalid WinGet/,
    );
  });

  test("accepts agreements for installation, never for uninstall", () => {
    expect(windowsPackageCommandArgs("winget", "install", "Git.Git")).toEqual([
      "install",
      "--id",
      "Git.Git",
      "--exact",
      "--accept-source-agreements",
      "--accept-package-agreements",
    ]);
    expect(windowsPackageCommandArgs("winget", "uninstall", "Git.Git")).toEqual([
      "uninstall",
      "--id",
      "Git.Git",
      "--exact",
      "--accept-source-agreements",
    ]);
    expect(wingetPackageArgs("uninstall", "Store.App", "msstore")).toContain("msstore");
  });

  test("recognizes exact Bun WinGet result codes without matching other low-byte aliases", () => {
    expect(isWingetPackageAbsentExitCode(20)).toBe(true);
    expect(isWingetPackageAbsentExitCode(0xdead0014)).toBe(false);
    expect(isWingetAlreadyInstalledExitCode(43)).toBe(true);
    expect(isWingetAlreadyInstalledExitCode(0xdead002b)).toBe(false);
  });
});

describe("manual Windows package installs", () => {
  test("default multi-package installs continue and track only successes", async () => {
    const root = await tempRoot("outfitting-windows-manual-install-");
    const config: ManagerConfig = {
      configPath: join(root, "config.toml"),
      stateRoot: root,
      machineId: "test:x64-windows",
      machineIdOverridden: true,
    };
    const attempts: string[] = [];

    await expect(
      Effect.runPromise(
        runWindowsPackageBatch({
          manager: "winget",
          action: "install",
          packages: ["Broken.App", "Good.App"],
          config,
          noPush: true,
          which: async () => "winget.exe",
          run: async (_command, args) => {
            attempts.push(args[2] ?? "");
            return args[2] === "Broken.App"
              ? { code: 1, stdout: "", stderr: "not found" }
              : { code: 43, stdout: "already installed", stderr: "" };
          },
        }),
      ),
    ).rejects.toThrow(/Broken\.App/);

    const lock = await readWindowsLock(config);
    expect(attempts).toEqual(["Broken.App", "Good.App"]);
    expect(lock.operations.map(({ name, status, exitCode }) => [name, status, exitCode])).toEqual([
      ["Broken.App", "failed", 1],
      ["Good.App", "success", 43],
    ]);
    expect(lock.packages.winget.map((entry) => entry.name)).toEqual(["Good.App"]);
  });

  test("strict multi-package installs stop after recording the first failure", async () => {
    const root = await tempRoot("outfitting-windows-manual-strict-");
    const config: ManagerConfig = {
      configPath: join(root, "config.toml"),
      stateRoot: root,
      machineId: "test:x64-windows",
      machineIdOverridden: true,
    };
    const attempts: string[] = [];

    await expect(
      Effect.runPromise(
        runWindowsPackageBatch({
          manager: "winget",
          action: "install",
          packages: ["Broken.App", "Good.App"],
          config,
          strict: true,
          noPush: true,
          which: async () => "winget.exe",
          run: async (_command, args) => {
            attempts.push(args[2] ?? "");
            return { code: 1, stdout: "", stderr: "not found" };
          },
        }),
      ),
    ).rejects.toThrow(/Broken\.App/);

    const lock = await readWindowsLock(config);
    expect(attempts).toEqual(["Broken.App"]);
    expect(lock.operations).toHaveLength(1);
    expect(lock.operations[0]).toMatchObject({ name: "Broken.App", status: "failed" });
  });
});

test("writing Windows lock state replaces a symlink instead of overwriting its external target", async () => {
  const root = await tempRoot("outfitting-windows-lock-atomic-");
  const external = await tempRoot("outfitting-windows-lock-external-");
  const destination = windowsLockPath({ root });
  const target = join(external, "original.json");
  await writeFile(target, "outside state root");
  await symlink(target, destination);
  const config: ManagerConfig = {
    configPath: join(root, "config.toml"),
    stateRoot: root,
    machineId: "test:x64-windows",
    machineIdOverridden: true,
  };

  await writeWindowsLock(await readWindowsLock({ ...config, stateRoot: external }), { root });
  expect(await readFile(target, "utf8")).toBe("outside state root");
  expect(JSON.parse(await readFile(destination, "utf8"))).toMatchObject({
    format: "outfitting-windows-lock-v2",
  });
});

test("records Windows operations in the local lock", async () => {
  const root = await tempRoot("outfitting-windows-lock-");
  const config: ManagerConfig = {
    configPath: join(root, "config.toml"),
    stateRoot: root,
    machineId: "test:x64-windows",
    machineIdOverridden: true,
  };
  await recordWindowsOperation(
    {
      config,
      manager: "winget",
      action: "install",
      name: "Git.Git",
      args: ["install", "--id", "Git.Git"],
      status: "success",
      exitCode: 0,
    },
    { root },
  );
  await recordWindowsOperation(
    {
      config,
      manager: "winget",
      action: "uninstall",
      name: "Missing.Package",
      args: ["uninstall", "--id", "Missing.Package"],
      status: "failed",
      exitCode: 1,
    },
    { root },
  );
  await recordWindowsOperation(
    {
      config,
      manager: "winget",
      action: "uninstall",
      name: "Git.Git",
      args: ["uninstall", "--id", "Git.Git"],
      status: "success",
      exitCode: 0,
    },
    { root },
  );

  const lock = await readWindowsLock(config, { root });
  expect(lock.packages.winget).toEqual([]);
  expect(lock.operations).toHaveLength(3);
  expect(lock.operations[1]).toMatchObject({
    name: "Missing.Package",
    status: "failed",
    exitCode: 1,
  });
  expect(windowsLockPath({ root })).toContain("windows.lock.json");
});

describe("Scoop", () => {
  test("parses buckets, bucket-qualified packages, and comments", () => {
    expect(
      parseScoopManifest(
        [
          "# Windows package state",
          'bucket "https://github.com/sheeki03/scoop-tirith.git"',
          'package "tirith"',
          'package "extras/rustic"',
        ].join("\n"),
      ),
    ).toEqual({
      buckets: [{ name: "tirith", url: "https://github.com/sheeki03/scoop-tirith.git" }],
      packages: ["tirith", "extras/rustic"],
    });
    expect(() => parseScoopManifest('package "extras/fzf"\npackage "fzf"')).toThrow(
      /duplicate package/,
    );
  });

  test("executes Scoop's cmd shim through its PowerShell sibling", () => {
    expect(scoopScriptPath("C:\\scoop\\shims\\scoop.cmd")).toBe("C:\\scoop\\shims\\scoop.ps1");
  });

  test("updates Scoop without requiring any package source configuration", async () => {
    const calls: string[] = [];
    const stateRoot = await tempRoot("outfitting-scoop-update-");
    const config: ManagerConfig = {
      configPath: join(stateRoot, "config.toml"),
      stateRoot,
      machineId: "test:x64-windows",
      machineIdOverridden: true,
    };
    await Effect.runPromise(
      updateScoop({
        config,
        which: async () => "C:\\scoop\\shims\\scoop.ps1",
        noPush: true,
        run: async (command, args) => {
          calls.push(`${command} ${args.join(" ")}`);
          return ok();
        },
      }),
    );
    expect(calls).toEqual([
      "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\scoop\\shims\\scoop.ps1 update",
      "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\scoop\\shims\\scoop.ps1 update *",
      "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\\scoop\\shims\\scoop.ps1 cleanup *",
    ]);
  });
});

describe("Windows inventories and upgrades", () => {
  test("normalizes and sorts Scoop inventory", async () => {
    const body = await captureScoopInventory(async () =>
      ok(
        JSON.stringify({
          apps: [
            { Name: "zulu", Source: "main", Version: "2", Info: "" },
            { Name: "alpha", Source: "extras", Version: "1", Info: "" },
          ],
          buckets: [
            { Name: "zeta", Source: "https://zeta" },
            { Name: "alpha", Source: "https://alpha" },
          ],
        }),
      ),
    );
    expect(body.indexOf('"Name": "alpha"')).toBeLessThan(body.indexOf('"Name": "zulu"'));
    expect(body).not.toMatch(/timestamp|fetchedAt/i);
  });

  test("sorts and deduplicates global Bun package names", async () => {
    const body = await captureBunGlobalInventory(async () =>
      ok(
        ["/tmp/global/node_modules", "├── zed@1.0.0", "├── @scope/pkg@2.0.0", "└── zed@1.0.0"].join(
          "\n",
        ),
      ),
    );
    expect(body).toContain('"packages": [\n    "@scope/pkg",\n    "zed"\n  ]');
  });

  test("requires WinGet export to create the requested file", async () => {
    const root = await tempRoot("outfitting-winget-export-");
    const output = join(root, "winget.json");
    await exportWingetInventory(output, async (_command, args) => {
      await writeFile(args[2]!, '{"Sources":[]}\n', "utf8");
      return ok();
    });
    await expect(readFile(output, "utf8")).resolves.toContain("Sources");
  });

  test("WinGet upgrades all and writes local state without source configuration", async () => {
    const stateRoot = await tempRoot("outfitting-winget-update-");
    const calls: string[][] = [];
    await Effect.runPromise(
      updateWinget({
        config: {
          configPath: join(stateRoot, "config.toml"),
          stateRoot,
          machineId: "test:x86_64-windows",
          machineIdOverridden: true,
        },
        which: async () => "C:\\Windows\\winget.exe",
        run: async (command, args) => {
          calls.push([command, ...args]);
          return ok();
        },
        noPush: true,
      }),
    );
    expect(calls).toEqual([
      ["winget", "upgrade", "--all", "--accept-source-agreements", "--accept-package-agreements"],
    ]);
    expect(
      JSON.parse(await readFile(join(stateRoot, "windows.lock.json"), "utf8")).operations[0].action,
    ).toBe("upgrade");
  });
});
