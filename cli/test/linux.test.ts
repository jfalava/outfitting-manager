import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";

import { loadConfig } from "@/config";
import {
  detectLinuxPackageManager,
  linuxDistributionFamily,
  parseOsRelease,
} from "@/platform/linux";
import { runLinuxInit } from "@/setup/linux";
import {
  applyLinux,
  linuxPackageIdentity,
  linuxPackageManagerArgs,
  listInstalledLinuxPackages,
  missingLinuxPackages,
  parseLinuxPackageManifest,
  updateLinux,
} from "@/update/linux";
import { prepareLinuxSource } from "@/update/linux-source";

const execFileAsync = promisify(execFile);
const linuxEntry = fileURLToPath(new URL("../index.ts", import.meta.url));

async function createLinuxRepo(
  stateRoot: string,
  profiles: Record<string, { apt?: string; pacman?: string }>,
) {
  const repo = await mkdtemp(join(tmpdir(), "outfitting-linux-byor-repo-"));
  const toml = [
    "schema = 1",
    "",
    "[source]",
    `path = ${JSON.stringify(repo)}`,
    "",
    "[linux]",
    `profile = ${JSON.stringify(Object.keys(profiles)[0])}`,
  ];

  await mkdir(repo, { recursive: true });
  for (const [profile, declarations] of Object.entries(profiles)) {
    const linux: Record<string, { manifest: string }> = {};
    for (const [manager, content] of Object.entries(declarations)) {
      if (content === undefined) continue;
      const manifest = `packages/${profile}/${manager}.txt`;
      await mkdir(join(repo, "packages", profile), { recursive: true });
      await writeFile(join(repo, manifest), content);
      linux[manager] = { manifest };
    }
    for (const [manager, declaration] of Object.entries(linux)) {
      toml.push(
        "",
        `[profiles.${JSON.stringify(profile)}.linux.${manager}]`,
        `manifest = ${JSON.stringify(declaration.manifest)}`,
      );
    }
  }
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, "config.toml"), `${toml.join("\n")}\n`);
  return repo;
}

function managerTools(calls: Array<{ command: string; args: ReadonlyArray<string> }>) {
  return {
    packageManager: "apt" as const,
    readOsRelease: async () => "ID=ubuntu\n",
    which: async (command: string) =>
      ({
        apt: "/usr/bin/apt",
        dpkg: "/usr/bin/dpkg",
        "dpkg-query": "/usr/bin/dpkg-query",
        sudo: "/usr/bin/sudo",
      })[command],
    run: async (command: string, args: ReadonlyArray<string>) => {
      calls.push({ command, args });
      if (command === "/usr/bin/dpkg") {
        return { code: 0, stdout: "amd64\n", stderr: "" };
      }
      if (command === "/usr/bin/dpkg-query") {
        const installed = calls
          .filter(({ args }) => args.includes("install") && args[0] === "/usr/bin/apt")
          .map(({ args }) => `${args.at(-1)}\tamd64\tinstall ok installed\n`)
          .join("");
        return { code: 0, stdout: installed, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

test("Linux offline source resolution accepts local sources but rejects refreshing remote sources", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-offline-source-"));
  const repo = await createLinuxRepo(stateRoot, { workstation: { apt: "curl\n" } });
  try {
    const config = await loadConfig({ stateRoot });
    const local = await prepareLinuxSource({
      config,
      profile: "workstation",
      refresh: true,
      offline: true,
    });
    expect(local).toMatchObject({ root: repo, mode: "checkout" });

    await expect(
      prepareLinuxSource({
        config: {
          ...config,
          source: { kind: "remote", repository: "owner/repository", ref: "main" },
        },
        profile: "workstation",
        refresh: true,
        offline: true,
      }),
    ).rejects.toThrow("--refresh and --offline cannot be used together");
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
    await rm(repo, { force: true, recursive: true });
  }
});

test("Linux commands expose init, apply, Nix, and native update as distinct operations", async () => {
  const root = await execFileAsync("bun", [linuxEntry, "--help"], { encoding: "utf8" });
  const rootHelp = `${root.stdout}\n${root.stderr}`;
  expect(rootHelp).toMatch(/^\s+init\s/m);
  expect(rootHelp).toMatch(/^\s+apply\s/m);
  expect(rootHelp).toMatch(/^\s+nix\s/m);
  expect(rootHelp).toMatch(/^\s+update\s/m);
  expect(rootHelp).toMatch(/self-update.*upgrade/);
  expect(rootHelp).toContain("--config <path>");
  expect(rootHelp).not.toMatch(/^\s+setup\s/m);

  const init = await execFileAsync("bun", [linuxEntry, "init", "--help"], {
    encoding: "utf8",
  });
  const initHelp = `${init.stdout}\n${init.stderr}`;
  expect(initHelp).toContain("--profile");
  expect(initHelp).toContain("--repo");
  expect(initHelp).not.toContain("manifest-base-url");
  expect(initHelp).not.toContain("manifest-ref");

  const apply = await execFileAsync("bun", [linuxEntry, "apply", "--help"], {
    encoding: "utf8",
  });
  const applyHelp = `${apply.stdout}\n${apply.stderr}`;
  expect(applyHelp).toContain("--profile");
  expect(applyHelp).toContain("--package-manager");
  expect(applyHelp).toContain("--if-configured");
  expect(applyHelp).toContain("--strict");
  expect(applyHelp).not.toMatch(/\bapply (all|apt|pacman)\b/i);
  expect(applyHelp).toContain("remote sources need --no-refresh");

  const update = await execFileAsync("bun", [linuxEntry, "update", "--help"], {
    encoding: "utf8",
  });
  expect(`${update.stdout}\n${update.stderr}`).toContain(
    "Refuse upgrades because network-free package resolution cannot be guaranteed",
  );

  await expect(
    execFileAsync("bun", [linuxEntry, "--config", "--help"], { encoding: "utf8" }),
  ).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Error: --config requires a path."),
  });

  const nix = await execFileAsync("bun", [linuxEntry, "nix", "switch", "--help"], {
    encoding: "utf8",
  });
  expect(`${nix.stdout}\n${nix.stderr}`).toContain("--if-configured");

  const nixUpdate = await execFileAsync("bun", [linuxEntry, "nix", "update", "--help"], {
    encoding: "utf8",
  });
  expect(`${nixUpdate.stdout}\n${nixUpdate.stderr}`).toContain("Update flake inputs");
  expect(`${nixUpdate.stdout}\n${nixUpdate.stderr}`).not.toContain("--no-push");

  const recoverNix = await execFileAsync("bun", [linuxEntry, "recover", "nix", "--help"], {
    encoding: "utf8",
  });
  expect(`${recoverNix.stdout}\n${recoverNix.stderr}`).toContain("interrupted Nix profile update");
});

test("Linux init requires a selected source and does not invent a default profile", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-init-empty-"));
  try {
    await expect(
      Effect.runPromise(runLinuxInit({ stateRoot, profile: "workstation" })),
    ).rejects.toThrow(/No profile declarations are configured/);
    await expect(readFile(join(stateRoot, "config.toml"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
  }
});

test("Linux init validates and persists a selected local BYOR checkout without applying packages", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-init-"));
  const repo = await createLinuxRepo(stateRoot, { "workstation-v2": { apt: "curl\n" } });
  try {
    await Effect.runPromise(runLinuxInit({ stateRoot, repo, profile: "workstation-v2" }));

    const config = await readFile(join(stateRoot, "config.toml"), "utf8");
    expect(config).toContain('profile = "workstation-v2"');
    expect(config).toContain(`path = ${JSON.stringify(repo)}`);
  } finally {
    await rm(stateRoot, { force: true, recursive: true });
    await rm(repo, { force: true, recursive: true });
  }
});

describe("Linux host detection", () => {
  test("parses quoted os-release values and identifies Debian family", () => {
    const release = parseOsRelease('ID="ubuntu"\nID_LIKE="debian"\n');
    expect(release).toEqual({ ID: "ubuntu", ID_LIKE: "debian" });
    expect(linuxDistributionFamily('ID="ubuntu"\nID_LIKE="debian"\n')).toBe("debian");
  });

  test("honors an explicit executable override and does not silently switch distro managers", async () => {
    await expect(
      detectLinuxPackageManager({
        requested: "pacman",
        readOsRelease: async () => "ID=ubuntu\n",
        which: async (command) => (command === "pacman" ? "/usr/bin/pacman" : undefined),
      }),
    ).resolves.toBe("pacman");

    const checked: string[] = [];
    await expect(
      detectLinuxPackageManager({
        readOsRelease: async () => "ID=ubuntu\n",
        which: async (command) => {
          checked.push(command);
          return command === "pacman" ? "/usr/bin/pacman" : undefined;
        },
      }),
    ).rejects.toThrow("apt");
    expect(checked).toEqual(["apt"]);
  });
});

describe("Linux package adapter", () => {
  test("parses and validates package declarations", () => {
    expect(parseLinuxPackageManifest("\n# baseline\ncurl\ngit # source control\ncurl\n")).toEqual([
      "curl",
      "git",
    ]);
    expect(() => parseLinuxPackageManifest("foo;bar")).toThrow("Invalid Linux package entry");
  });

  test("builds native apt and pacman operations", () => {
    expect(linuxPackageManagerArgs("apt", "update")).toEqual(["update"]);
    expect(linuxPackageManagerArgs("apt", "install", ["curl", "git"], true)).toEqual([
      "install",
      "--no-download",
      "-y",
      "curl",
      "git",
    ]);
    expect(linuxPackageManagerArgs("pacman", "upgrade")).toEqual(["-Syu", "--noconfirm"]);
    expect(() => linuxPackageManagerArgs("pacman", "install", ["curl"], true)).toThrow(
      "Offline pacman installs are refused",
    );
  });

  test("normalizes package identities and inventories only installed apt packages", async () => {
    expect(linuxPackageIdentity("curl:amd64=8.5.0")).toBe("curl:amd64");
    const installed = await listInstalledLinuxPackages("apt", {
      which: async (command) =>
        ({ dpkg: "/usr/bin/dpkg", "dpkg-query": "/usr/bin/dpkg-query" })[command],
      run: async (command) =>
        command === "/usr/bin/dpkg"
          ? { code: 0, stdout: "amd64\n", stderr: "" }
          : {
              code: 0,
              stdout:
                "curl\tamd64\tinstall ok installed\nold-package\tamd64\tdeinstall ok config-files\nlibc6\ti386\tinstall ok installed\nfonts\tall\tinstall ok installed\n",
              stderr: "",
            },
    });
    expect(installed).toEqual({
      manager: "apt",
      nativeArchitecture: "amd64",
      installed: new Set(["curl:amd64", "libc6:i386", "fonts:all"]),
    });
    expect(
      missingLinuxPackages(["curl", "libc6:amd64", "libc6:i386", "fonts", "git", "git"], installed),
    ).toEqual(["libc6:amd64", "git"]);
    expect(missingLinuxPackages(["libc6", "fonts:amd64"], installed)).toEqual([
      "libc6",
      "fonts:amd64",
    ]);
  });

  test("Linux update upgrades installed packages without requiring BYOR configuration", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-update-"));
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    try {
      await Effect.runPromise(
        updateLinux({
          config: {
            configPath: join(stateRoot, "config.toml"),
            stateRoot,
            machineId: "test:x86_64-linux",
            machineIdOverridden: true,
          },
          readOsRelease: async () => "ID=ubuntu\n",
          which: async (command) => ({ apt: "/usr/bin/apt", sudo: "/usr/bin/sudo" })[command],
          run: async (command, args) => {
            calls.push({ command, args });
            return { code: 0, stdout: "", stderr: "" };
          },
        }),
      );
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
    }
    expect(calls).toEqual([
      { command: "/usr/bin/sudo", args: ["/usr/bin/apt", "update"] },
      { command: "/usr/bin/sudo", args: ["/usr/bin/apt", "upgrade", "-y"] },
    ]);
  });

  test("Linux apply reconciles only the selected BYOR profile declaration", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-apply-"));
    const repo = await createLinuxRepo(stateRoot, {
      "workstation-v2": { apt: "curl\ngit\n" },
      "other-profile": { apt: "vim\n" },
    });
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const configBefore = await readFile(join(stateRoot, "config.toml"), "utf8");
    try {
      await Effect.runPromise(
        applyLinux({
          config: await loadConfig({ stateRoot }),
          noRefresh: true,
          yes: true,
          ...managerTools(calls),
        }),
      );
      expect(await readFile(join(stateRoot, "config.toml"), "utf8")).toBe(configBefore);
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }

    expect(calls).toContainEqual({
      command: "/usr/bin/sudo",
      args: ["/usr/bin/apt", "install", "-y", "curl"],
    });
    expect(calls).toContainEqual({
      command: "/usr/bin/sudo",
      args: ["/usr/bin/apt", "install", "-y", "git"],
    });
    expect(calls.some(({ args }) => args.includes("vim"))).toBe(false);
  });

  test("default apply continues after a package failure and defers prune", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-partial-"));
    const repo = await createLinuxRepo(stateRoot, {
      workstation: { apt: "broken-package\ncurl\n" },
    });
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    await writeFile(
      join(stateRoot, "linux-package-ownership.json"),
      JSON.stringify({ version: 2, profiles: { workstation: { apt: ["stale-package:amd64"] } } }),
    );

    try {
      await expect(
        Effect.runPromise(
          applyLinux({
            config: await loadConfig({ stateRoot }),
            prune: true,
            noRefresh: true,
            yes: true,
            ...managerTools(calls),
            run: async (command, args) => {
              calls.push({ command, args });
              if (command === "/usr/bin/dpkg") {
                return { code: 0, stdout: "amd64\n", stderr: "" };
              }
              if (command === "/usr/bin/dpkg-query") {
                return {
                  code: 0,
                  stdout: `stale-package\tamd64\tinstall ok installed\n${calls.some(({ args }) => args.at(-1) === "curl") ? "curl\tamd64\tinstall ok installed\n" : ""}`,
                  stderr: "",
                };
              }
              if (args[0] === "-s" && args[1] === "remove") {
                return { code: 0, stdout: "Remv stale-package [1.0]\n", stderr: "" };
              }
              if (
                args[0] === "/usr/bin/apt" &&
                args[1] === "install" &&
                args[3] === "broken-package"
              ) {
                return { code: 1, stdout: "", stderr: "not found" };
              }
              return { code: 0, stdout: "", stderr: "" };
            },
          }),
        ),
      ).rejects.toThrow(/apply was partial/);

      const ownership = JSON.parse(
        await readFile(join(stateRoot, "linux-package-ownership.json"), "utf8"),
      ) as { profiles: { workstation: { apt: string[] } } };
      expect(ownership.profiles.workstation.apt.toSorted()).toEqual([
        "curl:amd64",
        "stale-package:amd64",
      ]);
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }

    expect(
      calls
        .filter(({ args }) => args[0] === "/usr/bin/apt" && args[1] === "install")
        .map(({ args }) => args[3]),
    ).toEqual(["broken-package", "curl"]);
    expect(calls.some(({ args }) => args[0] === "/usr/bin/apt" && args[1] === "remove")).toBe(
      false,
    );
  });

  test("strict apply stops on the first failed package", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-strict-"));
    const repo = await createLinuxRepo(stateRoot, {
      workstation: { apt: "broken-package\ncurl\n" },
    });
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

    try {
      await expect(
        Effect.runPromise(
          applyLinux({
            config: await loadConfig({ stateRoot }),
            strict: true,
            noRefresh: true,
            yes: true,
            ...managerTools(calls),
            run: async (command, args) => {
              calls.push({ command, args });
              if (command === "/usr/bin/dpkg") {
                return { code: 0, stdout: "amd64\n", stderr: "" };
              }
              if (command === "/usr/bin/dpkg-query") {
                return { code: 0, stdout: "", stderr: "" };
              }
              if (args[0] === "/usr/bin/apt" && args[1] === "install") {
                return { code: 1, stdout: "", stderr: "not found" };
              }
              return { code: 0, stdout: "", stderr: "" };
            },
          }),
        ),
      ).rejects.toThrow(/broken-package/);
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }

    expect(
      calls
        .filter(({ args }) => args[0] === "/usr/bin/apt" && args[1] === "install")
        .map(({ args }) => args[3]),
    ).toEqual(["broken-package"]);
  });

  test("apply profile override is invocation-local and leaves TOML unchanged", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-profile-override-"));
    const repo = await createLinuxRepo(stateRoot, {
      "workstation-v2": { apt: "curl\n" },
      "other-profile": { apt: "vim\n" },
    });
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const configBefore = await readFile(join(stateRoot, "config.toml"), "utf8");
    try {
      await Effect.runPromise(
        applyLinux({
          config: await loadConfig({ stateRoot }),
          profile: "other-profile",
          noRefresh: true,
          yes: true,
          ...managerTools(calls),
        }),
      );
      expect(await readFile(join(stateRoot, "config.toml"), "utf8")).toBe(configBefore);
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }

    expect(calls).toContainEqual({
      command: "/usr/bin/sudo",
      args: ["/usr/bin/apt", "install", "-y", "vim"],
    });
    expect(calls.some(({ args }) => args.includes("curl"))).toBe(false);
  });

  test("apply can skip a selected profile with no native package declaration", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-apply-nix-only-"));
    const repo = await mkdtemp(join(tmpdir(), "outfitting-linux-apply-nix-repo-"));
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    await mkdir(repo, { recursive: true });
    await writeFile(
      join(stateRoot, "config.toml"),
      [
        "schema = 1",
        "[source]",
        `path = ${JSON.stringify(repo)}`,
        "[linux]",
        'profile = "nix-only"',
        "[profiles.nix-only.linux.nix]",
        'flake = "system/linux"',
        'attribute = "homeConfigurations.work.activationPackage"',
        "",
      ].join("\n"),
    );
    try {
      await Effect.runPromise(
        applyLinux({
          config: await loadConfig({ stateRoot }),
          ifConfigured: true,
          ...managerTools(calls),
        }),
      );
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }

    expect(calls).toEqual([]);
  });

  test("Linux prune removes only previously owned, unshared packages", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-prune-"));
    const repo = await createLinuxRepo(stateRoot, {
      workstation: { apt: "manual\n" },
      server: { apt: "shared\n" },
    });
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    let messages = "";
    try {
      await writeFile(
        join(stateRoot, "linux-package-ownership.json"),
        `${JSON.stringify({
          version: 2,
          profiles: {
            workstation: { apt: ["shared:amd64", "stale-only:amd64"] },
            server: { apt: ["shared:amd64"] },
          },
        })}\n`,
      );
      await Effect.runPromise(
        applyLinux({
          config: {
            configPath: join(stateRoot, "config.toml"),
            stateRoot,
            source: { kind: "local", path: repo },
            declarations: {
              schema: 1,
              profiles: {
                workstation: { linux: { apt: { manifest: "packages/workstation/apt.txt" } } },
                server: { linux: { apt: { manifest: "packages/server/apt.txt" } } },
              },
            },
            machineId: "test:x86_64-linux",
            machineIdOverridden: true,
          },
          profile: "workstation",
          packageManager: "apt",
          prune: true,
          noRefresh: true,
          yes: true,
          which: async (command) =>
            ({
              apt: "/usr/bin/apt",
              dpkg: "/usr/bin/dpkg",
              "dpkg-query": "/usr/bin/dpkg-query",
              sudo: "/usr/bin/sudo",
            })[command],
          run: async (command, args) => {
            calls.push({ command, args });
            if (command === "/usr/bin/dpkg") {
              return { code: 0, stdout: "amd64\n", stderr: "" };
            }
            if (command === "/usr/bin/dpkg-query") {
              return {
                code: 0,
                stdout:
                  "manual\tamd64\tinstall ok installed\nshared\tamd64\tinstall ok installed\nstale-only\tamd64\tinstall ok installed\n",
                stderr: "",
              };
            }
            if (args[0] === "-s") {
              return { code: 0, stdout: "Remv stale-only [1.0]\n", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        }),
      );
      messages = output.mock.calls.flat().join(" ");
    } finally {
      output.mockRestore();
      await rm(stateRoot, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }

    expect(messages).toMatch(/external uninstall and reinstall cannot be detected/i);
    expect(calls).toContainEqual({
      command: "/usr/bin/sudo",
      args: ["/usr/bin/apt", "remove", "-y", "stale-only:amd64"],
    });
    expect(calls.some(({ args }) => args.includes("manual") || args.includes("shared"))).toBe(
      false,
    );
  });

  test("migrates legacy apt ownership without allowing a wrong-architecture prune", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-legacy-ownership-"));
    const repo = await createLinuxRepo(stateRoot, { workstation: { apt: "manual\n" } });
    const calls: string[][] = [];
    await writeFile(
      join(stateRoot, "linux-package-ownership.json"),
      JSON.stringify({
        version: 1,
        profiles: { workstation: { apt: ["libc6"], pacman: ["nano"] } },
      }),
    );
    try {
      await Effect.runPromise(
        applyLinux({
          config: await loadConfig({ stateRoot }),
          packageManager: "apt",
          prune: true,
          noRefresh: true,
          yes: true,
          which: async (name) =>
            ({ apt: "/usr/bin/apt", dpkg: "/usr/bin/dpkg", "dpkg-query": "/usr/bin/dpkg-query" })[
              name
            ],
          run: async (command, args) => {
            calls.push([command, ...args]);
            if (command === "/usr/bin/dpkg") return { code: 0, stdout: "arm64\n", stderr: "" };
            if (command === "/usr/bin/dpkg-query")
              return {
                code: 0,
                stdout:
                  "manual\tarm64\tinstall ok installed\nlibc6\tarm64\tinstall ok installed\nlibc6\ti386\tinstall ok installed\n",
                stderr: "",
              };
            return { code: 0, stdout: "Remv libc6:arm64 [1.0]\n", stderr: "" };
          },
        }),
      );
      const state = JSON.parse(
        await readFile(join(stateRoot, "linux-package-ownership.json"), "utf8"),
      ) as {
        version: number;
        profiles: { workstation: { apt: string[]; pacman: string[] } };
      };
      expect(state).toMatchObject({
        version: 2,
        profiles: { workstation: { apt: [], pacman: ["nano"] } },
      });
      expect(calls.some((args) => args.includes("remove"))).toBe(false);
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("refuses an apt removal simulation that targets a different architecture", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-linux-wrong-arch-"));
    const repo = await createLinuxRepo(stateRoot, { workstation: { apt: "manual\n" } });
    const calls: string[][] = [];
    await writeFile(
      join(stateRoot, "linux-package-ownership.json"),
      JSON.stringify({
        version: 2,
        profiles: { workstation: { apt: ["libc6:arm64"] } },
      }),
    );
    try {
      await expect(
        Effect.runPromise(
          applyLinux({
            config: await loadConfig({ stateRoot }),
            packageManager: "apt",
            prune: true,
            noRefresh: true,
            yes: true,
            which: async (name) =>
              ({ apt: "/usr/bin/apt", dpkg: "/usr/bin/dpkg", "dpkg-query": "/usr/bin/dpkg-query" })[
                name
              ],
            run: async (command, args) => {
              calls.push([command, ...args]);
              if (command === "/usr/bin/dpkg") return { code: 0, stdout: "arm64\n", stderr: "" };
              if (command === "/usr/bin/dpkg-query")
                return {
                  code: 0,
                  stdout:
                    "manual\tarm64\tinstall ok installed\nlibc6\tarm64\tinstall ok installed\nlibc6\ti386\tinstall ok installed\n",
                  stderr: "",
                };
              return { code: 0, stdout: "Remv libc6:i386 [1.0]\n", stderr: "" };
            },
          }),
        ),
      ).rejects.toThrow(/Refusing unsafe apt removal/);
      expect(calls.some((args) => args[0] === "/usr/bin/apt" && args[1] === "remove")).toBe(false);
    } finally {
      await rm(stateRoot, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }
  });
});
