import { randomUUID } from "node:crypto";
import { link, lstat, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Console, Effect, Option } from "effect";
import { Command, Flag, Prompt } from "effect/cli";

import { composeBackupProfile } from "@/backups/composition";
import { loadConfig } from "@/config/load";
import {
  collectLinuxDeclaration,
  collectMacosExtras,
  collectMacosNix,
  collectWindowsProfileDeclarations,
  collectWindowsShared,
  mergeByorContractDefaults,
  requiredProfileNames,
} from "@/config/wizard";
import { tryPromise } from "@/lockfiles/effect";
import type { HostPlatform } from "@/platform";
import {
  BYOR_CONTRACT_PATH,
  parseByorContract,
  parseByorContractJson,
  validateLinuxByorSource,
  validateMacosByorSource,
  validateWindowsByorSource,
  validateWindowsSharedArtifacts,
  type ByorContract,
  type ByorProfileDeclaration,
} from "@/source/contract";
import { ui } from "@/ui";

type ManifestPlatform = HostPlatform;
type MutableByorProfiles = { [name: string]: ByorProfileDeclaration };

function validateProfileNames(value: string) {
  return Effect.try({
    try: () => requiredProfileNames(value),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  });
}

function hostPlatform(): ManifestPlatform {
  if (process.platform === "darwin") {
    return "macos";
  }
  return process.platform === "win32" ? "windows" : "linux";
}

function platformProfiles(
  contract: ByorContract | undefined,
  platform: ManifestPlatform,
): string[] {
  return Object.entries(contract?.profiles ?? {})
    .filter(([, profile]) => profile[platform] !== undefined)
    .map(([name]) => name);
}

function profileNamesPrompt(message: string, defaults: ReadonlyArray<string>) {
  const prompt =
    defaults.length > 0
      ? Prompt.String({ message, default: defaults.join(", "), validate: validateProfileNames })
      : Prompt.String({ message, validate: validateProfileNames });
  return Prompt.run(prompt).pipe(Effect.map((names) => names.split(",")));
}

function windowsDefaultProfilesPrompt(
  names: ReadonlyArray<string>,
  defaults: ReadonlyArray<string>,
) {
  return Prompt.run(
    Prompt.String({
      message: "Default Windows profiles (comma-separated)",
      default: (defaults.length > 0 ? defaults : names).join(", "),
      validate: (value) =>
        Effect.try({
          try: () => {
            const selected = requiredProfileNames(value).split(",");
            const unknown = selected.filter((name) => !names.includes(name));
            if (unknown.length > 0) {
              throw new Error(`Unknown Windows profile(s): ${unknown.join(", ")}.`);
            }
            return selected.join(",");
          },
          catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
        }),
    }),
  ).pipe(Effect.map((profiles) => profiles.split(",")));
}

function collectLinuxProfiles(existing?: ByorContract) {
  return Effect.gen(function* () {
    const names = yield* profileNamesPrompt(
      "Linux profiles to include (comma-separated)",
      platformProfiles(existing, "linux"),
    );
    const profiles: Record<string, ByorProfileDeclaration> = {};
    for (const name of names) {
      const linux = existing?.profiles[name]?.linux;
      const backends: string[] = yield* Prompt.run(
        Prompt.MultiSelect({
          message: `Choose package sources for Linux profile ${name}`,
          min: 1,
          choices: [
            { title: "APT manifest", value: "apt", selected: linux?.apt !== undefined },
            { title: "pacman manifest", value: "pacman", selected: linux?.pacman !== undefined },
            { title: "Nix flake", value: "nix", selected: linux?.nix !== undefined },
          ],
        }),
      );
      profiles[name] = { linux: yield* collectLinuxDeclaration(name, backends, linux) };
    }
    return parseByorContract({ schema: 1, profiles });
  });
}

function collectMacosProfiles(existing?: ByorContract) {
  return Effect.gen(function* () {
    const names = yield* profileNamesPrompt(
      "macOS profiles to include (comma-separated)",
      platformProfiles(existing, "macos"),
    );
    const profiles: Record<string, ByorProfileDeclaration> = {};
    for (const name of names) {
      const macos = existing?.profiles[name]?.macos;
      const nix = yield* collectMacosNix(macos?.nix);
      const extras = yield* collectMacosExtras(macos);
      profiles[name] = { macos: { nix, ...extras } };
    }
    return parseByorContract({ schema: 1, profiles });
  });
}

function collectWindowsProfiles(existing?: ByorContract, selectedProfiles?: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const names = yield* profileNamesPrompt(
      "Windows profiles to include (comma-separated)",
      platformProfiles(existing, "windows"),
    );
    const defaults =
      selectedProfiles ??
      existing?.windows?.defaultProfiles ??
      platformProfiles(existing, "windows");
    const defaultProfiles = yield* windowsDefaultProfilesPrompt(names, defaults);
    const profiles = yield* collectWindowsProfileDeclarations(names, existing);
    const windows = yield* collectWindowsShared(names, existing?.windows, defaultProfiles);
    return parseByorContract({ schema: 1, windows, profiles });
  });
}

function collectPlatformManifest(
  platform: ManifestPlatform,
  defaults: ByorContract | undefined,
  selectedWindowsProfiles: ReadonlyArray<string> | undefined,
) {
  switch (platform) {
    case "linux":
      return collectLinuxProfiles(defaults);
    case "macos":
      return collectMacosProfiles(defaults);
    case "windows":
      return collectWindowsProfiles(defaults, selectedWindowsProfiles);
  }
}

function replacePlatformProfiles(
  profiles: MutableByorProfiles,
  platform: ManifestPlatform,
  edits: ByorContract["profiles"] | undefined,
): void {
  for (const [name, profile] of Object.entries(profiles)) {
    const updated = { ...profile };
    delete updated[platform];
    if (Object.keys(updated).length === 0) {
      delete profiles[name];
    } else {
      profiles[name] = updated;
    }
  }
  for (const [name, profile] of Object.entries(edits ?? {})) {
    profiles[name] = { ...profiles[name], [platform]: profile[platform] };
  }
}

/** Merge edited platforms into a manifest while preserving every unselected platform. */
export function buildManifestWithPlatformEdits(
  existing: ByorContract | undefined,
  selected: ReadonlyArray<ManifestPlatform>,
  edits: Partial<Record<ManifestPlatform, ByorContract>>,
): ByorContract {
  const profiles: MutableByorProfiles = { ...existing?.profiles };
  for (const platform of selected) {
    replacePlatformProfiles(profiles, platform, edits[platform]?.profiles);
  }

  const windows = selected.includes("windows") ? edits.windows?.windows : existing?.windows;
  const result: ByorContract = {
    schema: 1,
    profiles,
  };
  if (existing?.backups !== undefined) {
    result.schema = 3;
    result.backups = existing?.backups;
  }
  if (windows !== undefined) {
    result.windows = windows;
  }
  return parseByorContract(result);
}

async function validateManifestArtifacts(root: string, contract: ByorContract): Promise<void> {
  for (const [profile, declaration] of Object.entries(contract.backups?.profiles ?? {})) {
    await composeBackupProfile({ root, profile, declaration });
  }
  for (const name of platformProfiles(contract, "linux")) {
    await validateLinuxByorSource({ root, contract, profile: name });
  }
  for (const name of platformProfiles(contract, "macos")) {
    await validateMacosByorSource({ root, contract, profile: name });
  }
  const windowsProfiles = platformProfiles(contract, "windows");
  if (windowsProfiles.length > 0) {
    await validateWindowsByorSource({ root, contract, profiles: windowsProfiles });
  } else {
    await validateWindowsSharedArtifacts(root, contract.windows);
  }
}

/** Atomically publish the reviewed repository manifest without clobbering concurrent edits. */
export async function publishByorManifest(
  root: string,
  serialized: string,
  expectedExistingContents?: string,
): Promise<void> {
  const target = join(root, BYOR_CONTRACT_PATH);
  const temporary = join(root, `.outfitting-manifest-${randomUUID()}.json`);
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx", mode: 0o644 });
    parseByorContractJson(await readFile(temporary, "utf8"));

    if (expectedExistingContents === undefined) {
      await link(temporary, target);
      return;
    }
    const targetStat = await lstat(target);
    if (!targetStat.isFile()) {
      throw new Error(`Refusing to replace non-regular manifest file ${target}.`);
    }
    if ((await readFile(target, "utf8")) !== expectedExistingContents) {
      throw new Error("Manifest changed while the review was open. Run the command again.");
    }
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readExistingManifest(target: string): Promise<string | undefined> {
  try {
    if (!(await lstat(target)).isFile()) {
      throw new Error(`Refusing to read non-regular manifest file ${target}.`);
    }
    return await readFile(target, "utf8");
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw cause;
  }
}

const runManifest = (repoPath: string | undefined, force: boolean) =>
  Effect.gen(function* () {
    const root = yield* tryPromise(async () => {
      const resolved = await realpath(repoPath ?? process.cwd());
      if (!(await stat(resolved)).isDirectory()) {
        throw new Error(`${resolved} is not a repository directory.`);
      }
      return resolved;
    });
    const target = join(root, BYOR_CONTRACT_PATH);
    const originalContents = yield* tryPromise(() => readExistingManifest(target));
    if (originalContents !== undefined && !force) {
      throw new Error(`${target} already exists; pass --force to review and replace it.`);
    }
    const existing =
      originalContents === undefined
        ? undefined
        : yield* tryPromise(async () => parseByorContractJson(originalContents));
    const configured = yield* tryPromise(() => loadConfig());
    const defaults = mergeByorContractDefaults(existing, configured.declarations);
    const selected = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "Choose platforms to include in the repo manifest",
        min: 1,
        choices: (["linux", "macos", "windows"] as const).map((platform) => ({
          title: platform === "macos" ? "macOS" : platform[0]!.toUpperCase() + platform.slice(1),
          value: platform,
          selected:
            platformProfiles(defaults, platform).length > 0 ||
            (platform === "windows" && configured.windows !== undefined) ||
            (defaults === undefined && platform === hostPlatform()),
        })),
      }),
    );
    const edits: Partial<Record<ManifestPlatform, ByorContract>> = {};
    for (const platform of selected) {
      edits[platform] = yield* collectPlatformManifest(
        platform,
        defaults,
        configured.windows?.profiles,
      );
    }
    const contract = buildManifestWithPlatformEdits(defaults, selected, edits);
    yield* tryPromise(() => validateManifestArtifacts(root, contract));
    const serialized = `${JSON.stringify(contract, null, 2)}\n`;

    yield* Console.log("");
    yield* Console.log(ui.heading(`Review ${BYOR_CONTRACT_PATH}:`));
    yield* Console.log(serialized);
    if (
      !(yield* Prompt.run(
        Prompt.Confirm({
          message:
            originalContents === undefined
              ? "Write this repo manifest?"
              : "Replace the reviewed repo manifest?",
          initial: false,
        }),
      ))
    ) {
      yield* Console.log(ui.muted("Manifest generation cancelled; no file was written."));
      return;
    }
    yield* tryPromise(() => publishByorManifest(root, serialized, originalContents));
    yield* Console.log(ui.success(`Repo manifest written: ${target}`));
  }).pipe(
    Effect.catchTag("QuitError", () =>
      Console.log(ui.muted("Manifest generation cancelled; no file was written.")),
    ),
  );

export const configManifestCommand = Command.make(
  "manifest",
  {
    repo: Flag.String("repo").pipe(
      Flag.optional,
      Flag.withDescription("Repository checkout; defaults to the current directory."),
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Review and replace an existing outfitting.json."),
    ),
  },
  ({ repo, force }) => runManifest(Option.getOrUndefined(repo), force),
).pipe(Command.withDescription("Create or update the repo-owned outfitting.json manifest."));
