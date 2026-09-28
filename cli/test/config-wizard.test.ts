import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stringify as stringifyToml } from "smol-toml";
import { afterEach, describe, expect, test } from "vitest";

import { loadConfig } from "@/config/load";
import { buildManifestWithPlatformEdits, publishByorManifest } from "@/config/manifest";
import {
  addLinuxSourcePaths,
  buildWizardConfigDocument,
  mergeByorContractDefaults,
} from "@/config/wizard";
import { publishValidatedConfig } from "@/config/write";
import { readByorContractFile, type ByorContract } from "@/source/contract";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "outfitting-config-wizard-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const contract: ByorContract = {
  schema: 1,
  windows: {
    defaultProfiles: ["base"],
    scoop: { manifest: "packages/scoop.json" },
  },
  profiles: {
    base: {
      linux: { apt: { manifest: "packages/base-apt.txt" } },
      windows: { winget: { manifest: "packages/base-winget.txt" } },
    },
    workstation: {
      linux: { pacman: { manifest: "packages/workstation-pacman.txt" } },
      windows: { winget: { manifest: "packages/workstation-winget.txt" } },
    },
  },
};

describe("config wizard document", () => {
  test("imports a repo-relative manifest and rejects traversal or escaping symlinks", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const manifest = join(root, "machine", "outfitting.json");
    await mkdir(join(root, "machine"));
    await writeFile(manifest, JSON.stringify(contract));
    await writeFile(join(outside, "manifest.json"), JSON.stringify(contract));
    await symlink(join(outside, "manifest.json"), join(root, "escape.json"));

    await expect(readByorContractFile(root, "machine/outfitting.json")).resolves.toEqual(contract);
    await expect(readByorContractFile(root, "../manifest.json")).rejects.toThrow(
      /repository-relative/,
    );
    await expect(readByorContractFile(root, "escape.json")).rejects.toThrow(
      /outside the repository/,
    );
  });

  test("TOML declarations override conflicting manifest defaults while missing platforms are filled", () => {
    const manifest: ByorContract = {
      schema: 1,
      windows: {
        defaultProfiles: ["desk"],
        scoop: { manifest: "repo/scoop.json" },
        fonts: { manifest: "repo/fonts.txt" },
      },
      profiles: {
        desk: {
          linux: { apt: { manifest: "repo/linux.txt" } },
          macos: { nix: { flake: "repo/macos", attribute: "darwinConfigurations.desk" } },
          windows: { winget: { manifest: "repo/winget.txt" } },
        },
      },
    };
    const toml: ByorContract = {
      schema: 1,
      windows: { scoop: { manifest: "toml/scoop.json" } },
      profiles: {
        desk: { linux: { apt: { manifest: "toml/linux.txt" } } },
        server: { linux: { pacman: { manifest: "toml/pacman.txt" } } },
      },
    };

    const merged = mergeByorContractDefaults(manifest, toml)!;
    expect(merged.profiles.desk?.linux?.apt).toEqual({ manifest: "toml/linux.txt" });
    expect(merged.profiles.desk?.macos).toEqual(manifest.profiles.desk?.macos);
    expect(merged.profiles.desk?.windows).toEqual(manifest.profiles.desk?.windows);
    expect(merged.profiles.server?.linux?.pacman).toEqual({ manifest: "toml/pacman.txt" });
    expect(merged.windows).toEqual({
      defaultProfiles: ["desk"],
      scoop: { manifest: "toml/scoop.json" },
      fonts: { manifest: "repo/fonts.txt" },
    });
  });

  test("copies all manifest platforms into TOML without replacing existing machine values", () => {
    const manifest: ByorContract = {
      schema: 1,
      windows: {
        defaultProfiles: ["desk"],
        scoop: { manifest: "repo/scoop.json" },
        fonts: { manifest: "repo/fonts.txt" },
      },
      profiles: {
        desk: {
          linux: { apt: { manifest: "repo/linux.txt" } },
          macos: { nix: { flake: "repo/macos", attribute: "darwinConfigurations.desk" } },
          windows: { winget: { manifest: "repo/winget.txt" } },
        },
      },
    };
    const existing = {
      schema: 1 as const,
      source: { path: "/repo" },
      linux: { profile: "desk" },
      windows: { profiles: ["desk"], shared: { scoop: { manifest: "toml/scoop.json" } } },
      profiles: { desk: { linux: { apt: { manifest: "toml/linux.txt" } } } },
    };
    const contractEdits: ByorContract = {
      schema: 1,
      profiles: { desk: { linux: { apt: { manifest: "toml/linux.txt" } } } },
    };

    const document = buildWizardConfigDocument(
      contractEdits,
      { path: "/repo" },
      {
        platform: "linux",
        profiles: ["desk"],
        manifest,
        existing,
      },
    );

    expect(document).toMatchObject({
      linux: { profile: "desk" },
      windows: {
        profiles: ["desk"],
        shared: {
          scoop: { manifest: "toml/scoop.json" },
          fonts: { manifest: "repo/fonts.txt" },
        },
      },
      profiles: {
        desk: {
          linux: { apt: { manifest: "toml/linux.txt" } },
          macos: manifest.profiles.desk?.macos,
          windows: manifest.profiles.desk?.windows,
        },
      },
    });
  });

  test("selects the requested Linux profile while retaining the source contract", async () => {
    const root = await temporaryRoot();
    const target = join(root, "nested", "config.toml");
    const document = buildWizardConfigDocument(
      contract,
      { repository: "https://github.com/example/dotfiles.git", ref: "main" },
      { platform: "linux", profiles: ["workstation"] },
    );

    await publishValidatedConfig(root, target, `${stringifyToml(document)}\n`);
    const config = await loadConfig({ stateRoot: root, configPath: target });

    expect(config.source).toEqual({
      kind: "remote",
      repository: "https://github.com/example/dotfiles.git",
      ref: "main",
    });
    expect(config.linux).toEqual({ profile: "workstation" });
    expect(config.declarations?.profiles.workstation?.linux?.pacman).toEqual({
      manifest: "packages/workstation-pacman.txt",
    });
    expect(config.declarations?.profiles.base?.linux?.apt).toEqual({
      manifest: "packages/base-apt.txt",
    });
  });

  test("stores only selected Windows profiles and moves shared declarations out of defaults", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.toml");
    const document = buildWizardConfigDocument(
      contract,
      { path: join(root, "checkout") },
      { platform: "windows", profiles: ["workstation"] },
    );

    await publishValidatedConfig(root, target, `${stringifyToml(document)}\n`);
    const config = await loadConfig({ stateRoot: root, configPath: target });

    expect(config.windows).toEqual({ profiles: ["workstation"] });
    expect(config.declarations?.windows).toEqual({ scoop: { manifest: "packages/scoop.json" } });
    expect(config.declarations?.profiles.workstation?.windows?.winget).toEqual({
      manifest: "packages/workstation-winget.txt",
    });
  });

  test("editing merges the selected platform and preserves unrelated config values", async () => {
    const root = await temporaryRoot();
    const target = join(root, "config.toml");
    const existing = {
      schema: 1 as const,
      machine_id: "jfalava:aarch64-linux",
      source: { path: "../outfitting" },
      linux: { profile: "base" },
      macos: { profile: "base" },
      windows: {
        profiles: ["base"],
        shared: { scoop: { manifest: "packages/scoop.json" } },
      },
      profiles: {
        base: {
          linux: { apt: { manifest: "packages/base-apt.txt" } },
          macos: { nix: { flake: "nix/mac", attribute: "darwinConfigurations.mac" } },
          windows: { winget: { manifest: "packages/base-winget.txt" } },
        },
        workstation: {
          linux: { pacman: { manifest: "packages/workstation-pacman.txt" } },
          windows: { winget: { manifest: "packages/workstation-winget.txt" } },
        },
      },
    };
    const editedContract: ByorContract = {
      schema: 1,
      profiles: {
        base: {
          linux: {
            nix: { flake: "system/linux", attribute: "homeConfigurations.base" },
            paths: ["packages/common"],
          },
        },
      },
    };

    const document = buildWizardConfigDocument(editedContract, existing.source, {
      platform: "linux",
      profiles: ["base"],
      existing,
    });

    expect(document).toMatchObject({
      machine_id: existing.machine_id,
      source: existing.source,
      linux: existing.linux,
      macos: existing.macos,
      windows: existing.windows,
      profiles: {
        base: {
          linux: editedContract.profiles.base?.linux,
          macos: existing.profiles.base.macos,
          windows: existing.profiles.base.windows,
        },
        workstation: existing.profiles.workstation,
      },
    });
    expect(document.profiles.base?.linux?.apt).toBeUndefined();

    await publishValidatedConfig(root, target, `${stringifyToml(document)}\n`);
    const config = await loadConfig({ stateRoot: root, configPath: target });
    expect(config.macos).toEqual({ profile: "base" });
    expect(config.declarations?.profiles.workstation?.windows?.winget).toEqual({
      manifest: "packages/workstation-winget.txt",
    });
  });

  test("adds discovered Nix paths without replacing existing paths or other profiles", () => {
    const document = buildWizardConfigDocument(
      {
        schema: 1,
        profiles: {
          base: {
            linux: {
              nix: {
                flake: "system/linux",
                attribute: "homeConfigurations.base.activationPackage",
              },
              paths: ["packages/common"],
            },
          },
        },
      },
      { path: "/repo" },
      { platform: "linux", profiles: ["base"] },
    );

    const updated = addLinuxSourcePaths(document, "base", [
      "packages/common/programs.nix",
      "system/common/dotfiles.nix",
      "system/common/dotfiles.nix",
    ]);

    expect(document.profiles.base?.linux?.paths).toEqual(["packages/common"]);
    expect(updated.profiles.base?.linux?.paths).toEqual([
      "packages/common",
      "packages/common/programs.nix",
      "system/common/dotfiles.nix",
    ]);
  });
});

describe("config manifest generation", () => {
  test("replaces selected platform declarations and keeps other platforms intact", () => {
    const existing: ByorContract = {
      schema: 1,
      windows: { defaultProfiles: ["common"], scoop: { manifest: "scoop.json" } },
      profiles: {
        common: {
          linux: { apt: { manifest: "old-apt.txt" } },
          macos: { nix: { flake: "nix/mac", attribute: "darwinConfigurations.common" } },
          windows: { winget: { manifest: "winget.txt" } },
        },
        linuxOnly: { linux: { pacman: { manifest: "old-pacman.txt" } } },
      },
    };
    const edited: ByorContract = {
      schema: 1,
      profiles: {
        common: { linux: { apt: { manifest: "new-apt.txt" } } },
        server: { linux: { apt: { manifest: "server.txt" } } },
      },
    };

    const result = buildManifestWithPlatformEdits(existing, ["linux"], { linux: edited });
    expect(result.profiles.common).toEqual({
      linux: { apt: { manifest: "new-apt.txt" } },
      macos: existing.profiles.common?.macos,
      windows: existing.profiles.common?.windows,
    });
    expect(result.profiles.server?.linux).toEqual({ apt: { manifest: "server.txt" } });
    expect(result.profiles.linuxOnly).toBeUndefined();
    expect(result.windows).toEqual(existing.windows);
  });

  test("creates without overwrite and replaces only the reviewed manifest version", async () => {
    const root = await temporaryRoot();
    const target = join(root, "outfitting.json");
    const original = `${JSON.stringify(contract, null, 2)}\n`;
    const edited = `${JSON.stringify(
      { schema: 1, profiles: { base: { linux: { apt: { manifest: "new.txt" } } } } },
      null,
      2,
    )}\n`;

    await publishByorManifest(root, original);
    await expect(publishByorManifest(root, edited)).rejects.toMatchObject({ code: "EEXIST" });
    await publishByorManifest(root, edited, original);
    await expect(readFile(target, "utf8")).resolves.toBe(edited);
    await expect(publishByorManifest(root, original, original)).rejects.toThrow(/changed while/);
    await expect(readFile(target, "utf8")).resolves.toBe(edited);
  });
});

test("publishes with private permissions and never overwrites an existing config", async () => {
  const root = await temporaryRoot();
  const target = join(root, "config.toml");
  const document = buildWizardConfigDocument(
    contract,
    { path: join(root, "checkout") },
    {
      platform: "linux",
      profiles: ["base"],
    },
  );
  const serialized = `${stringifyToml(document)}\n`;

  await publishValidatedConfig(root, target, serialized);
  const before = await readFile(target, "utf8");
  if (process.platform !== "win32") {
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  }

  await expect(publishValidatedConfig(root, target, serialized)).rejects.toMatchObject({
    code: "EEXIST",
  });
  await expect(readFile(target, "utf8")).resolves.toBe(before);
});

test("replaces an existing config only if it still matches the reviewed contents", async () => {
  const root = await temporaryRoot();
  const target = join(root, "config.toml");
  const original = `${stringifyToml(
    buildWizardConfigDocument(contract, { path: root }, { platform: "linux", profiles: ["base"] }),
  )}\n`;
  const edited = `${stringifyToml(
    buildWizardConfigDocument(
      {
        schema: 1,
        profiles: { base: { linux: { apt: { manifest: "packages/updated-apt.txt" } } } },
      },
      { path: root },
      { platform: "linux", profiles: ["base"] },
    ),
  )}\n`;

  await publishValidatedConfig(root, target, original);
  await publishValidatedConfig(root, target, edited, { expectedExistingContents: original });

  await expect(readFile(target, "utf8")).resolves.toBe(edited);
  await expect(
    publishValidatedConfig(root, target, original, { expectedExistingContents: original }),
  ).rejects.toThrow(/changed while the wizard was open/);
  await expect(readFile(target, "utf8")).resolves.toBe(edited);
});
