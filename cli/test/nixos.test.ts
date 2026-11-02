import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { hostGuardFailure } from "@/platform/guard";
import { checkNixosHost, defaultNixosHostProbe, type NixosHostProbe } from "@/platform/nixos";
import { nixosDrift, recordNixosActivation } from "@/update/nix/nixos-record";

const NIXOS = 'ID=nixos\nNAME="NixOS"\n';
const NIX_LD = "/nix/store/4icsp0w35609avnvdqhzykswqwggahwl-nix-ld-2.0.6/libexec/nix-ld";
const LIBS = "/run/current-system/sw/share/nix-ld/lib";

function probe(overrides: Partial<NixosHostProbe> = {}): NixosHostProbe {
  const present = new Set([`${LIBS}/libsecret-1.so.0`, `${LIBS}/libglib-2.0.so.0`]);
  return {
    readOsRelease: () => NIXOS,
    resolveLoader: () => NIX_LD,
    libraryDirs: () => [LIBS],
    fileExists: (path) => present.has(path),
    ...overrides,
  };
}

describe("NixOS host guard", () => {
  test("passes on NixOS with nix-ld providing libsecret and glib", () => {
    expect(checkNixosHost(probe()).every((check) => check.ok)).toBe(true);
    expect(hostGuardFailure("nixos", ["backups", "run-due"], probe())).toBeUndefined();
  });

  test("names the failing requirement", () => {
    expect(
      hostGuardFailure("nixos", ["status"], probe({ readOsRelease: () => "ID=ubuntu\n" })),
    ).toMatch(/does not identify NixOS. Install the linux build/);
    // Real glibc behind the loader path means nix-ld is not in charge.
    expect(
      hostGuardFailure(
        "nixos",
        ["status"],
        probe({ resolveLoader: () => "/nix/store/xycc-glibc-2.42/lib/ld-linux-aarch64.so.1" }),
      ),
    ).toMatch(/does not resolve to nix-ld.*Enable programs.nix-ld/);
    // The silent credential failure: the binary starts, Bun.secrets cannot load libsecret.
    expect(
      hostGuardFailure(
        "nixos",
        ["status"],
        probe({ fileExists: (path) => path.endsWith("libglib-2.0.so.0") }),
      ),
    ).toMatch(/does not provide libsecret-1.so.0.*programs.nix-ld.libraries/);
  });

  test("the linux build refuses NixOS but still lets self-update install the NixOS build", () => {
    expect(hostGuardFailure("linux", ["backups", "run-due"], probe())).toMatch(/self-update/);
    expect(hostGuardFailure("linux", ["--config", "/c.toml", "self-update"], probe())).toBe(
      undefined,
    );
    expect(
      hostGuardFailure("linux", ["status"], probe({ readOsRelease: () => "ID=ubuntu\n" })),
    ).toBeUndefined();
  });

  test("help, version, and debug bypass the guard on a broken host", () => {
    const broken = probe({ readOsRelease: () => undefined, resolveLoader: () => undefined });
    for (const args of [[], ["--version"], ["nix", "switch", "--help"], ["debug", "host"]]) {
      expect(hostGuardFailure("nixos", args, broken)).toBeUndefined();
    }
    expect(hostGuardFailure("nixos", ["--config", "debug", "status"], broken)).toBeDefined();
  });

  test("systemd units without NIX_LD_LIBRARY_PATH use nix-ld's default library directory", () => {
    vi.stubEnv("NIX_LD_LIBRARY_PATH", "");
    try {
      expect(defaultNixosHostProbe.libraryDirs()).toEqual([LIBS]);
      vi.stubEnv("NIX_LD_LIBRARY_PATH", "/a:/b");
      expect(defaultNixosHostProbe.libraryDirs()).toEqual(["/a", "/b"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("NixOS drift", () => {
  const temps: string[] = [];
  afterEach(async () => {
    await Promise.all(temps.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  test("flags a system profile moved by someone else, even before it is activated", async () => {
    // macOS tmpdir() is a symlink (/var → /private/var); the record must still match.
    const root = await realpath(await mkdtemp(join(tmpdir(), "outfitting-nixos-drift-")));
    temps.push(root);
    const managed = join(root, "managed-system");
    const remote = join(root, "remote-system");
    await mkdir(managed);
    await mkdir(remote);
    const record = join(root, "state", "nixos-activation");
    const current = join(root, "current-system");
    const profile = join(root, "system");
    await symlink(managed, current);
    await symlink(managed, profile);

    expect(
      await nixosDrift({ recordPath: record, currentPath: current, profilePath: profile }),
    ).toBeUndefined();
    await recordNixosActivation(managed, record);
    expect(
      await nixosDrift({ recordPath: record, currentPath: current, profilePath: profile }),
    ).toMatchObject({ changed: false });

    // A refused remote nixos-rebuild still runs nix-env --set before switch-to-configuration.
    await rm(profile);
    await symlink(remote, profile);
    expect(
      await nixosDrift({ recordPath: record, currentPath: current, profilePath: profile }),
    ).toMatchObject({ changed: true, recorded: managed, current: managed, profile: remote });
  });
});
