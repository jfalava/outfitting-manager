import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

import { initializeWindows } from "@/commands/setup/windows";
import { applyWindows } from "@/commands/windows-apply";
import { loadConfig } from "@/config";
import type { RunCommandResult } from "@/process";
import { readWindowsLock, writeWindowsLock } from "@/update/windows-lock";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

const ok = (stdout = ""): RunCommandResult => ({ code: 0, stdout, stderr: "" });
const missing = (): RunCommandResult => ({
  code: -1978335212,
  stdout: "",
  stderr: "not installed",
});

describe("Windows BYOR apply", () => {
  test("Windows setup accepts composed profiles alongside unrelated Linux declarations", async () => {
    const stateRoot = await tempRoot("outfitting-windows-mixed-state-");
    const repo = await tempRoot("outfitting-windows-mixed-repo-");
    await writeFile(join(repo, "work.list"), "Acme.Editor\n");
    await writeFile(join(repo, "dev.list"), "Acme.Terminal\n");
    await writeFile(join(repo, "linux.list"), "curl\n");
    await writeFile(
      join(stateRoot, "config.toml"),
      [
        "schema = 1",
        "",
        "[source]",
        `path = ${JSON.stringify(repo)}`,
        "",
        "[windows]",
        'profiles = ["work", "dev"]',
        "",
        "[profiles.work.windows.winget]",
        'manifest = "work.list"',
        "",
        "[profiles.dev.windows.winget]",
        'manifest = "dev.list"',
        "",
        "[profiles.linux-home.linux.apt]",
        'manifest = "linux.list"',
        "",
      ].join("\n"),
    );

    const { repo: validated } = await Effect.runPromise(
      initializeWindows({ stateRoot, profiles: ["work", "dev"] }),
    );

    expect(validated.root).toBe(repo);
    expect(validated.flakeKind).toBe("none");
  });

  test("initializes a local contract and applies only its custom WinGet path", async () => {
    const stateRoot = await tempRoot("outfitting-windows-state-");
    const repo = await tempRoot("outfitting-windows-repo-");
    await mkdir(join(repo, "machine", "apps"), { recursive: true });
    await writeFile(join(repo, "machine", "apps", "desktop.list"), "Acme.Editor\nAcme.Terminal\n");
    await writeFile(
      join(stateRoot, "config.toml"),
      `schema = 1\n[source]\npath = ${JSON.stringify(repo)}\n[windows]\nprofiles = ["workstation"]\n[profiles.workstation.windows.winget]\nmanifest = "machine/apps/desktop.list"\n`,
    );

    const config = await loadConfig({ stateRoot, machineId: "test:x64-windows" });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const discovered: string[] = [];
    const installed = new Set<string>();
    const commands: string[][] = [];
    await Effect.runPromise(
      applyWindows({
        config,
        yes: true,
        which: async (manager) => {
          discovered.push(manager);
          return manager === "winget" ? "winget.exe" : undefined;
        },
        run: async (_command, args) => {
          commands.push([...args]);
          if (args[0] === "list") return installed.has(args[2] ?? "") ? ok() : missing();
          if (args[0] === "install") {
            installed.add(args[2] ?? "");
            return ok();
          }
          return ok();
        },
      }),
    );

    expect((await readWindowsLock(config)).profiles).toEqual(["workstation"]);
    expect(
      (await readWindowsLock(config)).packages.winget.map((item) => item.name).toSorted(),
    ).toEqual(["Acme.Editor", "Acme.Terminal"]);
    expect(discovered).toEqual(["winget"]);
    expect(commands.filter((args) => args[0] === "install").map((args) => args[2])).toEqual([
      "Acme.Editor",
      "Acme.Terminal",
    ]);
    expect(output.mock.calls.flat().join(" ")).toContain("Windows declarations applied locally.");
    await expect(
      readFile(join(stateRoot, "manifests", "packages", "windows", "base.txt"), "utf8"),
    ).rejects.toThrow();
  });

  test("an omitted Scoop declaration skips Scoop detection", async () => {
    const stateRoot = await tempRoot("outfitting-windows-no-scoop-state-");
    const repo = await tempRoot("outfitting-windows-no-scoop-repo-");
    await writeFile(join(repo, "apps.list"), "Acme.Editor\n");
    await writeFile(
      join(stateRoot, "config.toml"),
      `schema = 1\n[source]\npath = ${JSON.stringify(repo)}\n[windows]\nprofiles = ["work"]\n[profiles.work.windows.winget]\nmanifest = "apps.list"\n`,
    );
    const config = await loadConfig({ stateRoot, machineId: "test:x64-windows" });
    const discovered: string[] = [];
    await Effect.runPromise(
      applyWindows({
        config,
        yes: true,
        which: async (manager) => {
          discovered.push(manager);
          return manager;
        },
        run: async (_command, args) => (args[0] === "list" ? ok("installed") : ok()),
      }),
    );

    expect(discovered).toEqual(["winget"]);
  });

  test("treats WinGet's Bun exit code 20 as absent and attempts installation", async () => {
    const stateRoot = await tempRoot("outfitting-windows-absent-code-state-");
    const repo = await tempRoot("outfitting-windows-absent-code-repo-");
    await writeFile(join(repo, "apps.list"), "Acme.Editor\n");
    await writeFile(
      join(stateRoot, "config.toml"),
      `schema = 1\n[source]\npath = ${JSON.stringify(repo)}\n[windows]\nprofiles = ["work"]\n[profiles.work.windows.winget]\nmanifest = "apps.list"\n`,
    );
    const config = await loadConfig({ stateRoot });
    const installAttempts: string[] = [];

    await Effect.runPromise(
      applyWindows({
        config,
        yes: true,
        which: async () => "winget.exe",
        run: async (_command, args) => {
          if (args[0] === "list") return { code: 20, stdout: "", stderr: "no match" };
          if (args[0] === "install") installAttempts.push(args[2] ?? "");
          return ok();
        },
      }),
    );

    const lock = await readWindowsLock(config);
    expect(installAttempts).toEqual(["Acme.Editor"]);
    expect(lock.profiles).toEqual(["work"]);
    expect(lock.packages.winget.map((entry) => entry.name)).toEqual(["Acme.Editor"]);
  });

  test("unrelated WinGet list errors still stop apply before installing", async () => {
    const stateRoot = await tempRoot("outfitting-windows-list-error-state-");
    const repo = await tempRoot("outfitting-windows-list-error-repo-");
    await writeFile(join(repo, "apps.list"), "Acme.Editor\n");
    await writeFile(
      join(stateRoot, "config.toml"),
      `schema = 1\n[source]\npath = ${JSON.stringify(repo)}\n[windows]\nprofiles = ["work"]\n[profiles.work.windows.winget]\nmanifest = "apps.list"\n`,
    );
    const config = await loadConfig({ stateRoot });
    const installAttempts: string[] = [];

    await expect(
      Effect.runPromise(
        applyWindows({
          config,
          yes: true,
          which: async () => "winget.exe",
          run: async (_command, args) => {
            if (args[0] === "list") return { code: 1, stdout: "", stderr: "unexpected failure" };
            if (args[0] === "install") installAttempts.push(args[2] ?? "");
            return ok();
          },
        }),
      ),
    ).rejects.toThrow(/exit 1/);

    expect(installAttempts).toEqual([]);
    expect((await readWindowsLock(config)).profiles).toEqual([]);
  });

  test("refuses a same-named Scoop bucket from a different source before installing", async () => {
    const stateRoot = await tempRoot("outfitting-windows-bucket-state-");
    const repo = await tempRoot("outfitting-windows-bucket-repo-");
    await writeFile(join(repo, "apps.list"), "Acme.Editor\n");
    await writeFile(
      join(repo, "scoop.txt"),
      'bucket "https://trusted.example/scoop-tools"\npackage "tools/Acme.App"\n',
    );
    await writeFile(
      join(stateRoot, "config.toml"),
      `schema = 1\n[source]\npath = ${JSON.stringify(repo)}\n[windows]\nprofiles = ["work"]\n[windows.shared.scoop]\nmanifest = "scoop.txt"\n[profiles.work.windows.winget]\nmanifest = "apps.list"\n`,
    );
    const config = await loadConfig({ stateRoot });
    const installs: string[][] = [];

    await expect(
      Effect.runPromise(
        applyWindows({
          config,
          yes: true,
          which: async (command) => (command === "scoop" ? "scoop.cmd" : "winget.exe"),
          run: async (_command, args) => {
            if (args.includes("export"))
              return ok(
                JSON.stringify({
                  apps: [],
                  buckets: [{ Name: "tools", Source: "https://untrusted.example/scoop-tools" }],
                }),
              );
            if (args.includes("install")) installs.push([...args]);
            return args[0] === "list" ? missing() : ok();
          },
        }),
      ),
    ).rejects.toThrow("Refusing to install from a different source");
    expect(installs).toEqual([]);
    expect((await readWindowsLock(config)).operations).toEqual([]);
  });

  test("default apply continues after an install failure and defers pruning", async () => {
    const stateRoot = await tempRoot("outfitting-windows-failed-state-");
    const repo = await tempRoot("outfitting-windows-failed-repo-");
    await writeFile(join(repo, "apps.list"), "Acme.Broken\nAcme.Editor\n");
    await writeFile(
      join(stateRoot, "config.toml"),
      `schema = 1\n[source]\npath = ${JSON.stringify(repo)}\n[windows]\nprofiles = ["work"]\n[profiles.work.windows.winget]\nmanifest = "apps.list"\n`,
    );
    const config = await loadConfig({ stateRoot });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const previous = await readWindowsLock(config);
    previous.profiles = ["previous"];
    previous.packages.winget.push({
      name: "Stale.Tool",
      args: ["install", "--id", "Stale.Tool"],
      origin: "baseline",
      installedBy: "outfitting",
      owners: ["work"],
    });
    await writeWindowsLock(previous, { root: stateRoot });

    const installAttempts: string[] = [];
    const commands: string[][] = [];
    await expect(
      Effect.runPromise(
        applyWindows({
          config,
          yes: true,
          prune: true,
          which: async () => "winget.exe",
          run: async (_command, args) => {
            commands.push([...args]);
            if (args[0] === "list") return missing();
            if (args[0] === "install") {
              const name = args[2] ?? "";
              installAttempts.push(name);
              return name === "Acme.Broken"
                ? { code: 1, stdout: "", stderr: "failed" }
                : { code: 43, stdout: "already installed", stderr: "" };
            }
            return ok();
          },
        }),
      ),
    ).rejects.toThrow(/apply was partial/);

    const lock = await readWindowsLock(config);
    expect(installAttempts).toEqual(["Acme.Broken", "Acme.Editor"]);
    expect(commands.some((args) => args[0] === "uninstall")).toBe(false);
    expect(lock.profiles).toEqual(["previous"]);
    expect(lock.packages.winget.map((entry) => entry.name)).toEqual(["Stale.Tool"]);
    expect(lock.operations.map(({ name, status, exitCode }) => [name, status, exitCode])).toEqual([
      ["Acme.Broken", "failed", 1],
    ]);
    expect(lock.packages.winget.some((entry) => entry.name === "Acme.Broken")).toBe(false);
    const messages = output.mock.calls.flat().join(" ");
    expect(messages).toContain("Windows apply was partial");
    expect(messages).not.toContain("Windows declarations applied locally.");
  });

  test("warns about stale ownership and makes no changes when pruning is declined", async () => {
    const stateRoot = await tempRoot("outfitting-windows-prune-state-");
    const repo = await tempRoot("outfitting-windows-prune-repo-");
    await writeFile(join(repo, "apps.list"), "Acme.Kept\n");
    await writeFile(
      join(stateRoot, "config.toml"),
      `schema = 1\n[source]\npath = ${JSON.stringify(repo)}\n[windows]\nprofiles = ["work"]\n[profiles.work.windows.winget]\nmanifest = "apps.list"\n`,
    );
    const config = await loadConfig({ stateRoot });
    const previous = await readWindowsLock(config);
    previous.packages.winget.push({
      name: "Manually.Reinstalled",
      args: ["install", "--id", "Manually.Reinstalled", "--source", "winget"],
      origin: "baseline",
      installedBy: "outfitting",
      owners: ["work"],
    });
    await writeWindowsLock(previous, { root: stateRoot });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    let asked = false;

    await Effect.runPromise(
      applyWindows({
        config,
        prune: true,
        which: async () => "winget.exe",
        run: async (_command, args) => {
          if (args[0] === "list") return ok();
          throw new Error("Package operations must not run before confirmation.");
        },
        confirm: Effect.sync(() => {
          asked = true;
          return false;
        }),
      }),
    );

    expect(asked).toBe(true);
    expect(output.mock.calls.flat().join(" ")).toMatch(
      /remove winget: Manually\.Reinstalled.*external uninstall and reinstall cannot be detected/i,
    );
    expect(await readWindowsLock(config)).toEqual(previous);
  });

  test("default apply continues from failed WinGet installs through Scoop packages", async () => {
    const stateRoot = await tempRoot("outfitting-windows-cross-manager-state-");
    const repo = await tempRoot("outfitting-windows-cross-manager-repo-");
    await writeFile(join(repo, "apps.list"), "Acme.Broken\n");
    await writeFile(join(repo, "scoop.txt"), 'package "Broken.Tool"\npackage "Good.Tool"\n');
    await writeFile(
      join(stateRoot, "config.toml"),
      [
        "schema = 1",
        "[source]",
        `path = ${JSON.stringify(repo)}`,
        "[windows]",
        'profiles = ["work"]',
        "[windows.shared.scoop]",
        'manifest = "scoop.txt"',
        "[profiles.work.windows.winget]",
        'manifest = "apps.list"',
        "",
      ].join("\n"),
    );
    const config = await loadConfig({ stateRoot });
    const installedScoop: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];
    const terminal = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      Effect.runPromise(
        applyWindows({
          config,
          yes: true,
          which: async (manager) =>
            ({
              winget: "winget.exe",
              scoop: "scoop.cmd",
            })[manager],
          run: async (command, args, options) => {
            expect(options?.inherit).toBe(false);
            commands.push({ command, args: [...args] });
            if (command === "winget.exe" && args[0] === "list") return missing();
            if (command === "winget.exe" && args[0] === "install") {
              return { code: 1, stdout: "", stderr: "WinGet diagnostic" };
            }
            if (args.includes("export")) {
              return { code: 0, stdout: '{"apps":[],"buckets":[]}', stderr: "" };
            }
            if (args.includes("install")) {
              const packageName = args.at(-1) ?? "";
              installedScoop.push(packageName);
              return packageName === "Broken.Tool"
                ? { code: 1, stdout: "", stderr: "Scoop diagnostic" }
                : ok();
            }
            return ok();
          },
        }),
      ),
    ).rejects.toThrow(/apply was partial/);

    const lock = await readWindowsLock(config);
    expect(installedScoop).toEqual(["Broken.Tool", "Good.Tool"]);
    expect(commands.some(({ args }) => args[0] === "uninstall")).toBe(false);
    expect(lock.operations.map(({ name, status }) => [name, status])).toEqual([
      ["Acme.Broken", "failed"],
      ["Broken.Tool", "failed"],
      ["Good.Tool", "success"],
    ]);
    expect(lock.packages.winget).toEqual([]);
    expect(lock.packages.scoop.map((entry) => entry.name)).toEqual(["Good.Tool"]);
    expect(lock.profiles).toEqual([]);
    const rendered = terminal.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(rendered.match(/WinGet diagnostic/g)).toHaveLength(1);
    expect(rendered.match(/Scoop diagnostic/g)).toHaveLength(1);
  });

  test("strict apply records the first failed install and stops before later packages", async () => {
    const stateRoot = await tempRoot("outfitting-windows-strict-state-");
    const repo = await tempRoot("outfitting-windows-strict-repo-");
    await writeFile(join(repo, "apps.list"), "Acme.Broken\nAcme.Editor\n");
    await writeFile(
      join(stateRoot, "config.toml"),
      `schema = 1\n[source]\npath = ${JSON.stringify(repo)}\n[windows]\nprofiles = ["work"]\n[profiles.work.windows.winget]\nmanifest = "apps.list"\n`,
    );
    const config = await loadConfig({ stateRoot });
    const installAttempts: string[] = [];
    await expect(
      Effect.runPromise(
        applyWindows({
          config,
          strict: true,
          yes: true,
          which: async () => "winget.exe",
          run: async (_command, args) => {
            if (args[0] === "list") return missing();
            if (args[0] === "install") {
              installAttempts.push(args[2] ?? "");
              return { code: 1, stdout: "", stderr: "failed" };
            }
            return ok();
          },
        }),
      ),
    ).rejects.toThrow(/Acme\.Broken/);

    const lock = await readWindowsLock(config);
    expect(installAttempts).toEqual(["Acme.Broken"]);
    expect(lock.profiles).toEqual([]);
    expect(lock.operations).toContainEqual(
      expect.objectContaining({ name: "Acme.Broken", status: "failed", exitCode: 1 }),
    );
  });

  test("repairs missing Scoop binaries without updating healthy declared packages", async () => {
    const stateRoot = await tempRoot("outfitting-windows-scoop-repair-state-");
    const repo = await tempRoot("outfitting-windows-scoop-repair-repo-");
    const scoopRoot = join(stateRoot, "scoop");
    const shimDirectory = join(scoopRoot, "shims");
    const globalScoopRoot = join(stateRoot, "scoop-global");
    const globalPrefix = join(globalScoopRoot, "apps", "global-tirith", "current");
    const globalShimDirectory = join(globalScoopRoot, "shims");
    const prefixes = new Map<string, string>();
    for (const name of [
      "tirith",
      "healthy",
      "path-hidden",
      "partial",
      "script-hidden",
      "no-bin",
      "unknown",
      "external",
    ]) {
      const prefix = join(scoopRoot, "apps", name, "current");
      prefixes.set(name, prefix);
      await mkdir(prefix, { recursive: true });
      await writeFile(join(prefix, "install.json"), '{"architecture":"64bit"}');
    }
    prefixes.set("global-tirith", globalPrefix);
    await mkdir(globalPrefix, { recursive: true });
    await mkdir(globalShimDirectory, { recursive: true });
    await writeFile(join(globalPrefix, "install.json"), '{"architecture":"64bit"}');
    await writeFile(join(globalPrefix, "manifest.json"), '{"bin":"global-tirith.exe"}');
    await writeFile(join(globalPrefix, "global-tirith.exe"), "global binary");
    const globalShimPath = join(globalShimDirectory, "global-tirith.exe");
    await writeFile(globalShimPath, "shim executable");
    const tirithPrefix = prefixes.get("tirith")!;
    const tirithShimPath = join(shimDirectory, "tirith.exe");
    await mkdir(shimDirectory, { recursive: true });
    await writeFile(tirithShimPath, "shim executable");
    await writeFile(
      join(shimDirectory, "tirith.shim"),
      `path = "${join(tirithPrefix, "bin", "tirith.exe")}"\n`,
    );
    await writeFile(
      join(tirithPrefix, "manifest.json"),
      JSON.stringify({
        bin: "fallback.exe",
        architecture: { "64bit": { bin: [["bin/tirith.exe", "tirith"]] } },
      }),
    );
    const healthyPrefix = prefixes.get("healthy")!;
    const healthyShimPath = join(shimDirectory, "healthy.exe");
    await writeFile(join(healthyPrefix, "manifest.json"), '{"bin":"healthy.exe"}');
    await writeFile(join(healthyPrefix, "healthy.exe"), "binary");
    await writeFile(healthyShimPath, "shim executable");
    await writeFile(
      join(shimDirectory, "healthy.shim"),
      `path = "${join(healthyPrefix, "healthy.exe")}"\n`,
    );
    const hiddenPrefix = prefixes.get("path-hidden")!;
    const hiddenShimPath = join(shimDirectory, "path-hidden.exe");
    await writeFile(join(hiddenPrefix, "manifest.json"), '{"bin":"path-hidden.exe"}');
    await writeFile(join(hiddenPrefix, "path-hidden.exe"), "binary");
    await writeFile(hiddenShimPath, "shim executable");
    await writeFile(
      join(shimDirectory, "path-hidden.shim"),
      `path = "${join(hiddenPrefix, "path-hidden.exe")}"\n`,
    );
    const partialPrefix = prefixes.get("partial")!;
    const partialHiddenShimPath = join(shimDirectory, "partial-hidden.exe");
    const partialBrokenShimPath = join(shimDirectory, "partial-broken.exe");
    await writeFile(
      join(partialPrefix, "manifest.json"),
      JSON.stringify({
        bin: [
          ["first.exe", "partial-hidden"],
          ["script.cmd", "partial-script"],
          ["second.exe", "partial-broken"],
        ],
      }),
    );
    await writeFile(join(partialPrefix, "first.exe"), "first binary");
    await writeFile(join(partialPrefix, "script.cmd"), "@echo off\r\n");
    await writeFile(join(shimDirectory, "partial-script.cmd"), "@echo off\r\n");
    for (const [name, shimPath, target] of [
      ["partial-hidden", partialHiddenShimPath, join(partialPrefix, "first.exe")],
      ["partial-broken", partialBrokenShimPath, join(partialPrefix, "second.exe")],
    ] as const) {
      await writeFile(shimPath, "shim executable");
      await writeFile(join(shimDirectory, `${name}.shim`), `path = "${target}"\n`);
    }
    const scriptPrefix = prefixes.get("script-hidden")!;
    await writeFile(join(scriptPrefix, "manifest.json"), '{"bin":"script-hidden.cmd"}');
    await writeFile(join(scriptPrefix, "script-hidden.cmd"), "@echo off\r\n");
    await writeFile(join(shimDirectory, "script-hidden.cmd"), "@echo off\r\n");
    await writeFile(join(prefixes.get("no-bin")!, "manifest.json"), '{"version":"1.0"}');
    await writeFile(join(prefixes.get("unknown")!, "manifest.json"), '{"bin":{"bad":true}}');
    await writeFile(join(prefixes.get("external")!, "manifest.json"), '{"bin":"external.exe"}');
    const externalCommandPath = join(stateRoot, "external.exe");
    await writeFile(externalCommandPath, "external binary");
    await writeFile(join(repo, "apps.list"), "Acme.Editor\n");
    await writeFile(
      join(repo, "scoop.txt"),
      [
        "tirith",
        "healthy",
        "path-hidden",
        "partial",
        "script-hidden",
        "no-bin",
        "unknown",
        "external",
        "global-tirith",
      ]
        .map((name) => `package "${name}"`)
        .join("\n"),
    );
    await writeFile(
      join(stateRoot, "config.toml"),
      [
        "schema = 1",
        "[source]",
        `path = ${JSON.stringify(repo)}`,
        "[windows]",
        'profiles = ["work"]',
        "[windows.shared.scoop]",
        'manifest = "scoop.txt"',
        "[profiles.work.windows.winget]",
        'manifest = "apps.list"',
        "",
      ].join("\n"),
    );
    const config = await loadConfig({ stateRoot });
    const previous = await readWindowsLock(config);
    previous.packages.scoop.push({
      name: "tirith",
      args: ["install", "tirith"],
      origin: "manual",
    });
    await writeWindowsLock(previous, { root: stateRoot });

    const commands: string[][] = [];
    await Effect.runPromise(
      applyWindows({
        config,
        yes: true,
        which: async (command) =>
          command === "scoop"
            ? "scoop.cmd"
            : command === "winget"
              ? "winget.exe"
              : command === "tirith"
                ? tirithShimPath
                : command === "healthy"
                  ? healthyShimPath
                  : command === "global-tirith"
                    ? globalShimPath
                    : command === "partial-broken"
                      ? partialBrokenShimPath
                      : command === "external"
                        ? externalCommandPath
                        : undefined,
        run: async (_command, args) => {
          commands.push([...args]);
          if (args.includes("export")) {
            return ok(
              JSON.stringify({
                apps: [
                  "tirith",
                  "healthy",
                  "path-hidden",
                  "partial",
                  "script-hidden",
                  "no-bin",
                  "unknown",
                  "external",
                  "global-tirith",
                ].map((Name) => ({
                  Name,
                  Source: "test",
                  Version: "1.0",
                  Info: Name === "global-tirith" ? "Global install" : "",
                })),
                buckets: [],
              }),
            );
          }
          if (args.includes("prefix")) {
            return ok(prefixes.get(args[args.indexOf("prefix") + 1] ?? "") ?? "");
          }
          if (args.includes("update")) {
            const name = args[args.indexOf("update") + 1];
            if (name === "tirith") {
              const target = join(tirithPrefix, "bin", "tirith.exe");
              await mkdir(join(tirithPrefix, "bin"), { recursive: true });
              await writeFile(target, "restored binary");
            } else if (name === "global-tirith") {
              await writeFile(
                join(globalShimDirectory, "global-tirith.shim"),
                `path = "${join(globalPrefix, "global-tirith.exe")}"\n`,
              );
            } else if (name === "partial") {
              await writeFile(join(partialPrefix, "second.exe"), "restored binary");
            }
          }
          return ok();
        },
      }),
    );

    const updates = commands
      .filter((args) => args.includes("update"))
      .map((args) => args.slice(args.indexOf("update")));
    const lock = await readWindowsLock(config);
    expect(updates).toEqual([
      ["update", "tirith", "--force"],
      ["update", "partial", "--force"],
      ["update", "global-tirith", "--force", "--global"],
    ]);
    expect(lock.packages.scoop).toContainEqual({
      name: "tirith",
      args: ["install", "tirith"],
      origin: "manual",
    });
    expect(lock.operations).toContainEqual(
      expect.objectContaining({
        manager: "scoop",
        action: "upgrade",
        name: "tirith",
        status: "success",
        args: ["update", "tirith", "--force"],
      }),
    );
    expect(lock.operations).toContainEqual(
      expect.objectContaining({
        manager: "scoop",
        action: "upgrade",
        name: "partial",
        status: "success",
        args: ["update", "partial", "--force"],
      }),
    );
    expect(lock.operations).toContainEqual(
      expect.objectContaining({
        manager: "scoop",
        action: "upgrade",
        name: "global-tirith",
        status: "success",
        args: ["update", "global-tirith", "--force", "--global"],
      }),
    );
    await expect(readFile(join(tirithPrefix, "bin", "tirith.exe"), "utf8")).resolves.toBe(
      "restored binary",
    );
    await expect(readFile(join(partialPrefix, "second.exe"), "utf8")).resolves.toBe(
      "restored binary",
    );
  });

  test("reports a Scoop repair as failed when update exits successfully but the binary stays missing", async () => {
    const stateRoot = await tempRoot("outfitting-windows-scoop-repair-failed-state-");
    const repo = await tempRoot("outfitting-windows-scoop-repair-failed-repo-");
    const prefix = join(stateRoot, "scoop-apps", "tirith");
    await mkdir(prefix, { recursive: true });
    await writeFile(join(prefix, "manifest.json"), '{"bin":"tirith.exe"}');
    await writeFile(join(prefix, "install.json"), '{"architecture":"64bit"}');
    await writeFile(join(repo, "apps.list"), "Acme.Editor\n");
    await writeFile(join(repo, "scoop.txt"), 'package "tirith"\n');
    await writeFile(
      join(stateRoot, "config.toml"),
      [
        "schema = 1",
        "[source]",
        `path = ${JSON.stringify(repo)}`,
        "[windows]",
        'profiles = ["work"]',
        "[windows.shared.scoop]",
        'manifest = "scoop.txt"',
        "[profiles.work.windows.winget]",
        'manifest = "apps.list"',
        "",
      ].join("\n"),
    );
    const config = await loadConfig({ stateRoot });

    await expect(
      Effect.runPromise(
        applyWindows({
          config,
          yes: true,
          which: async (command) =>
            command === "scoop" ? "scoop.cmd" : command === "winget" ? "winget.exe" : undefined,
          run: async (_command, args) => {
            if (args.includes("export")) {
              return ok(
                JSON.stringify({
                  apps: [{ Name: "tirith", Source: "test", Version: "1.0", Info: "" }],
                  buckets: [],
                }),
              );
            }
            if (args.includes("prefix")) return ok(prefix);
            return ok();
          },
        }),
      ),
    ).rejects.toThrow(/apply was partial/);

    const lock = await readWindowsLock(config);
    expect(lock.profiles).toEqual([]);
    expect(lock.operations).toContainEqual(
      expect.objectContaining({
        action: "upgrade",
        name: "tirith",
        status: "failed",
        exitCode: 1,
      }),
    );
  });
});
