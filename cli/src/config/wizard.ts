import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Console, Effect, Option, Result } from "effect";
import { Command, Flag, Prompt } from "effect/cli";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { composeBackupProfile } from "@/backups/composition";
import { applyWindows } from "@/commands/windows-apply";
import { normalizeGitRepository, validateGitRef } from "@/config/git";
import { loadConfig } from "@/config/load";
import { configFilePath, stateRoot } from "@/config/paths";
import type { OutfittingRepo } from "@/config/repo";
import type { BackupsConfig } from "@/config/types";
import { publishValidatedConfig } from "@/config/write";
import { tryPromise } from "@/effect";
import { classifyGitHubRepository, readGitHubFile } from "@/fetch/github";
import type { HostPlatform } from "@/platform";
import { envValue } from "@/secrets";
import { runSetup } from "@/setup/run";
import { readGitFile } from "@/setup/source";
import {
  BYOR_CONTRACT_PATH,
  BYOR_CONTRACT_SCHEMA,
  normalizeBackups,
  normalizeBackupPath,
  parseByorContract,
  parseByorContractJson,
  readByorContractFile,
  relativeSourcePath,
  validateLinuxByorSource,
  validateMacosByorSource,
  validateWindowsByorSource,
  type ByorContract,
  type ByorProfileDeclaration,
  type ByorWindowsShared,
  type LinuxProfileDeclaration,
  type MacosProfileDeclaration,
} from "@/source/contract";
import { discoverNixSourcePaths, missingSourcePathFromNixError } from "@/source/nix-dependencies";
import { ui } from "@/ui";
import { withActivity } from "@/ui/progress";
import { applyBrew } from "@/update/brew";
import { applyLinux } from "@/update/linux";
import { buildNixSystem } from "@/update/nix/build";
import { updateNix } from "@/update/nix/run";

type WizardSource = { path: string } | { repository: string; ref: string };

interface WizardConfigDocument {
  schema: 1 | 2;
  backups?: import("@/config/types").BackupsConfig;
  machine_id?: string;
  source: WizardSource;
  linux?: { profile: string };
  macos?: { profile: string };
  windows?: { profiles?: string[]; shared?: Omit<ByorWindowsShared, "defaultProfiles"> };
  profiles: ByorContract["profiles"];
}

interface ExistingWizardConfigDocument {
  schema?: 1 | 2;
  backups?: import("@/config/types").BackupsConfig;
  machine_id?: string;
  source?: WizardSource;
  linux?: { profile?: string };
  macos?: { profile?: string };
  windows?: { profiles?: string[]; shared?: Omit<ByorWindowsShared, "defaultProfiles"> };
  profiles?: ByorContract["profiles"];
}

interface ExistingWizardConfig {
  contents: string;
  document: ExistingWizardConfigDocument;
  declarations?: ByorContract;
}

interface WizardAnswers {
  configPath: string;
  contract: ByorContract;
  manifest?: ByorContract;
  machineId?: string;
  platform: HostPlatform;
  profiles: string[];
  source: WizardSource;
  localRoot?: string;
  existing?: ExistingWizardConfig;
}

interface WizardDocumentOptions {
  platform: HostPlatform;
  profiles: ReadonlyArray<string>;
  manifest?: ByorContract;
  existing?: ExistingWizardConfigDocument;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function hostPlatform(): HostPlatform {
  if (process.platform === "darwin") {
    return "macos";
  }
  return process.platform === "win32" ? "windows" : "linux";
}

function targetPathPrompt(defaultPath: string) {
  return Prompt.run(
    Prompt.String({
      message: "Where should config.toml be read from or written to?",
      default: defaultPath,
      validate: (value) => {
        const path = value.trim();
        if (path.length === 0) {
          return Effect.fail("Enter a path for config.toml.");
        }
        return Effect.succeed(resolve(path));
      },
    }),
  );
}

function localSourcePathPrompt(configDirectory: string, defaultPath = process.cwd()) {
  return Prompt.run(
    Prompt.String({
      message:
        "Path to the local source checkout containing your declared package or Nix files (relative to config.toml)",
      default: defaultPath,
      validate: (value) =>
        Effect.tryPromise({
          try: async () => {
            if (value.trim().length === 0) {
              throw new Error("Enter the path to a source checkout.");
            }
            const sourcePath = value.trim();
            const root = await realpath(resolve(configDirectory, sourcePath));
            if (!(await stat(root)).isDirectory()) {
              throw new Error(`${root} is not a directory.`);
            }
            return sourcePath;
          },
          catch: errorMessage,
        }),
    }),
  ).pipe(
    Effect.flatMap((path) =>
      Effect.tryPromise({
        try: async () => ({ path, root: await realpath(resolve(configDirectory, path)) }),
        catch: errorMessage,
      }),
    ),
  );
}

function normalizedTextPrompt(
  message: string,
  normalize: (value: string) => string,
  defaultValue?: string,
  preserveDefault = false,
) {
  const validate = (value: string) => {
    if (value.trim().length === 0) {
      return Effect.fail("This value is required.");
    }
    try {
      const trimmed = value.trim();
      return Effect.succeed(
        preserveDefault && trimmed === defaultValue ? defaultValue : normalize(trimmed),
      );
    } catch (cause) {
      return Effect.fail(errorMessage(cause));
    }
  };
  const prompt =
    defaultValue === undefined
      ? Prompt.String({ message, validate })
      : Prompt.String({ message, default: defaultValue, validate });
  return Prompt.run(prompt);
}

function optionalTextPrompt(message: string, defaultValue?: string) {
  return Prompt.run(Prompt.String({ message, default: defaultValue ?? "" })).pipe(
    Effect.map((value) => value.trim() || undefined),
  );
}

function commaSeparatedPaths(value: string | undefined): string[] {
  return value === undefined
    ? []
    : value
        .split(",")
        .map((path) => path.trim())
        .filter(Boolean);
}

export function requiredProfileNames(value: string): string {
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => name.length === 0)) {
    throw new Error("Enter one or more comma-separated profile names.");
  }
  return [...new Set(names)].join(",");
}

const enterProfileSentinel = "\u0000enter-profile";

function profileNamePrompt(message: string, defaultName: string | undefined, candidates: string[]) {
  if (defaultName === undefined && candidates.length > 1) {
    return Prompt.run(
      Prompt.Select({
        message: `${message} (or choose to enter another profile)`,
        choices: [
          ...candidates.map((name) => ({ title: name, value: name })),
          { title: "Enter a different profile", value: enterProfileSentinel },
        ],
      }),
    ).pipe(
      Effect.filterOrElse(
        (name) => name !== enterProfileSentinel,
        () => normalizedTextPrompt(message, (value) => value),
      ),
    );
  }
  return normalizedTextPrompt(message, (value) => value, defaultName ?? candidates[0]);
}

function collectLinuxApt(existing?: NonNullable<ByorProfileDeclaration["linux"]>["apt"]) {
  return normalizedTextPrompt("APT manifest path", (value) => value, existing?.manifest).pipe(
    Effect.map((manifest) => ({ manifest })),
  );
}

function collectLinuxPacman(existing?: NonNullable<ByorProfileDeclaration["linux"]>["pacman"]) {
  return normalizedTextPrompt("pacman manifest path", (value) => value, existing?.manifest).pipe(
    Effect.map((manifest) => ({ manifest })),
  );
}

function collectLinuxNix(
  profileName: string,
  existing?: NonNullable<ByorProfileDeclaration["linux"]>["nix"],
) {
  return Effect.gen(function* () {
    const flake = yield* normalizedTextPrompt(
      "Nix flake directory",
      (value) => value,
      existing?.flake,
    );
    const attribute = yield* normalizedTextPrompt(
      "Nix output derivation attribute (Home Manager example: homeConfigurations.<name>.activationPackage)",
      (value) => value,
      existing?.attribute ?? `homeConfigurations.${profileName}.activationPackage`,
    );
    return { flake, attribute };
  });
}

function collectLinuxPaths(existing?: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    while (true) {
      const value = yield* optionalTextPrompt(
        "Extra repository paths read outside the flake directory (comma-separated; blank requires confirmation)",
        existing?.join(", "),
      );
      const paths = commaSeparatedPaths(value);
      if (paths.length > 0 || existing !== undefined) {
        return paths;
      }
      if (
        yield* confirm(
          "Confirm that this Nix flake reads no repository paths outside its flake directory?",
        )
      ) {
        return [];
      }
    }
  });
}

function selectLinuxBackends(existing?: ByorProfileDeclaration["linux"]) {
  return Prompt.run(
    Prompt.MultiSelect({
      message: "Choose the package sources this Linux profile declares",
      min: 1,
      choices: [
        { title: "APT manifest", value: "apt", selected: existing?.apt !== undefined },
        { title: "pacman manifest", value: "pacman", selected: existing?.pacman !== undefined },
        { title: "Nix flake", value: "nix", selected: existing?.nix !== undefined },
      ],
    }),
  );
}

export function collectLinuxDeclaration(
  profileName: string,
  backends: ReadonlyArray<string>,
  existing?: ByorProfileDeclaration["linux"],
) {
  return Effect.gen(function* () {
    const linux: LinuxProfileDeclaration = {};
    if (backends.includes("apt")) {
      linux.apt = yield* collectLinuxApt(existing?.apt);
    }
    if (backends.includes("pacman")) {
      linux.pacman = yield* collectLinuxPacman(existing?.pacman);
    }
    if (backends.includes("nix")) {
      linux.nix = yield* collectLinuxNix(profileName, existing?.nix);
    }
    if (backends.includes("nix")) {
      const paths = yield* collectLinuxPaths(existing?.paths);
      linux.paths = paths;
    }
    return linux;
  });
}

function collectLinuxProfile(
  defaultName: string | undefined,
  existing?: ByorContract,
  candidates: string[] = [],
) {
  return Effect.gen(function* () {
    const name = yield* profileNamePrompt("Linux profile name", defaultName, candidates);
    const declaration = existing?.profiles[name]?.linux;
    const backends = yield* selectLinuxBackends(declaration);
    const linux = yield* collectLinuxDeclaration(name, backends, declaration);
    const contract = parseByorContract({ schema: 1, profiles: { [name]: { linux } } });
    return { contract, profiles: [name] };
  });
}

export function collectMacosNix(existing?: MacosProfileDeclaration["nix"]) {
  return Effect.gen(function* () {
    const flake = yield* normalizedTextPrompt(
      "Nix flake directory",
      (value) => value,
      existing?.flake,
    );
    const attribute = yield* normalizedTextPrompt(
      "Nix output attribute",
      (value) => value,
      existing?.attribute,
    );
    const nix: MacosProfileDeclaration["nix"] = { flake, attribute };
    const darwin = yield* optionalTextPrompt(
      `Darwin configuration path (blank for ${nix.flake}/darwin.nix)`,
      existing?.darwin,
    );
    if (darwin !== undefined) {
      nix.darwin = darwin;
    }
    return nix;
  });
}

export function collectMacosExtras(existing?: ByorProfileDeclaration["macos"]) {
  return Effect.gen(function* () {
    const macos: Omit<MacosProfileDeclaration, "nix"> = {};
    const brewfile = yield* optionalTextPrompt(
      "Homebrew Brewfile path (blank to skip)",
      existing?.brewfile,
    );
    if (brewfile !== undefined) {
      macos.brewfile = brewfile;
    }
    const fonts = yield* optionalTextPrompt(
      "Fonts manifest path (blank to skip)",
      existing?.fonts?.manifest,
    );
    if (fonts !== undefined) {
      macos.fonts = { manifest: fonts };
    }
    const paths = yield* optionalTextPrompt(
      "Extra repository paths (comma-separated, blank if none)",
      existing?.paths?.join(", "),
    ).pipe(Effect.map(commaSeparatedPaths));
    if (paths.length > 0) {
      macos.paths = paths;
    }
    return macos;
  });
}

function collectMacosProfile(
  defaultName: string | undefined,
  existing?: ByorContract,
  candidates: string[] = [],
) {
  return Effect.gen(function* () {
    const name = yield* profileNamePrompt("macOS profile name", defaultName, candidates);
    const declaration = existing?.profiles[name]?.macos;
    const nix = yield* collectMacosNix(declaration?.nix);
    const extras = yield* collectMacosExtras(declaration);
    const macos: MacosProfileDeclaration = { nix, ...extras };
    const contract = parseByorContract({ schema: 1, profiles: { [name]: { macos } } });
    return { contract, profiles: [name] };
  });
}

export function collectWindowsProfileDeclarations(
  names: ReadonlyArray<string>,
  existing?: ByorContract,
) {
  return Effect.gen(function* () {
    const profiles: Record<string, ByorProfileDeclaration> = {};
    for (const name of names) {
      const manifest = yield* normalizedTextPrompt(
        `WinGet manifest path for ${name}`,
        (value) => value,
        existing?.profiles[name]?.windows?.winget.manifest,
      );
      profiles[name] = { windows: { winget: { manifest } } };
    }
    return profiles;
  });
}

function collectWindowsFontsAndRegistry(existing?: ByorContract["windows"]) {
  return Effect.gen(function* () {
    const extra: Pick<ByorWindowsShared, "fonts" | "registry"> = {};
    const fonts = yield* optionalTextPrompt(
      "Windows fonts manifest path (blank to skip)",
      existing?.fonts?.manifest,
    );
    if (fonts !== undefined) {
      extra.fonts = { manifest: fonts };
    }
    const registry = yield* optionalTextPrompt(
      "Registry file path (blank to skip)",
      existing?.registry?.path,
    );
    if (registry !== undefined) {
      extra.registry = { path: registry };
    }
    return extra;
  });
}

export function collectWindowsShared(
  names: ReadonlyArray<string>,
  existing?: ByorContract["windows"],
  defaultProfiles: ReadonlyArray<string> = names,
) {
  return Effect.gen(function* () {
    const windows: ByorWindowsShared = { defaultProfiles: [...defaultProfiles] };
    const scoop = yield* optionalTextPrompt(
      "Scoop manifest path (blank to skip)",
      existing?.scoop?.manifest,
    );
    if (scoop !== undefined) {
      windows.scoop = { manifest: scoop };
    }
    const powershell = yield* optionalTextPrompt(
      "PowerShell script path (blank to skip)",
      existing?.powershell?.path,
    );
    if (powershell !== undefined) {
      windows.powershell = { path: powershell };
    }
    Object.assign(windows, yield* collectWindowsFontsAndRegistry(existing));
    return windows;
  });
}

export function collectWindowsProfiles(
  defaultProfiles: ReadonlyArray<string>,
  existing?: ByorContract,
) {
  return Effect.gen(function* () {
    const namesInput = yield* normalizedTextPrompt(
      "Windows profile names (comma-separated)",
      requiredProfileNames,
      defaultProfiles.join(", ") || undefined,
    );
    const names = namesInput.split(",");
    const profiles = yield* collectWindowsProfileDeclarations(names, existing);
    const windows = yield* collectWindowsShared(names, existing?.windows);
    const contract = parseByorContract({ schema: 1, windows, profiles });
    return { contract, profiles: names };
  });
}

export function mergeByorContractDefaults(
  manifest?: ByorContract,
  toml?: ByorContract,
): ByorContract | undefined {
  if (manifest === undefined) {
    return toml;
  }
  if (toml === undefined) {
    return manifest;
  }

  const profiles = { ...manifest.profiles } satisfies ByorContract["profiles"];
  for (const [name, profile] of Object.entries(toml.profiles)) {
    profiles[name] = { ...profiles[name], ...profile };
  }
  const windows = { ...manifest.windows, ...toml.windows };
  const merged: ByorContract = {
    schema: 1,
    profiles,
  };
  if (toml.backups ?? manifest.backups) {
    merged.schema = BYOR_CONTRACT_SCHEMA;
    merged.backups = toml.backups ?? manifest.backups;
  }
  if (Object.keys(windows).length > 0) {
    merged.windows = windows;
  }
  return parseByorContract(merged);
}

function profileNamesFor(contract: ByorContract | undefined, platform: HostPlatform): string[] {
  if (contract === undefined) {
    return [];
  }
  return Object.entries(contract.profiles)
    .filter(([, profile]) =>
      platform === "linux"
        ? profile.linux !== undefined
        : platform === "macos"
          ? profile.macos !== undefined
          : profile.windows !== undefined,
    )
    .map(([name]) => name);
}

function windowsProfileSetupPrompt(
  existing: ExistingWizardConfig | undefined,
  defaults: ByorContract | undefined,
) {
  const selected = existing?.document.windows?.profiles;
  const windowsDefaults =
    selected !== undefined && selected.length > 0
      ? selected
      : (defaults?.windows?.defaultProfiles ?? profileNamesFor(defaults, "windows"));
  return collectWindowsProfiles(windowsDefaults, defaults);
}

function singleProfileSetupPrompt(
  platform: "linux" | "macos",
  existing: ExistingWizardConfig | undefined,
  defaults: ByorContract | undefined,
) {
  const candidates = profileNamesFor(defaults, platform);
  const selected =
    platform === "linux" ? existing?.document.linux?.profile : existing?.document.macos?.profile;
  const defaultName =
    selected !== undefined && candidates.includes(selected)
      ? selected
      : candidates.length === 1
        ? candidates[0]
        : undefined;
  if (platform === "linux") {
    return collectLinuxProfile(defaultName, defaults, candidates);
  }
  return collectMacosProfile(defaultName, defaults, candidates);
}

function profileSetupPrompt(
  platform: HostPlatform,
  existing?: ExistingWizardConfig,
  manifest?: ByorContract,
) {
  const defaults = mergeByorContractDefaults(manifest, existing?.declarations);
  switch (platform) {
    case "windows":
      return windowsProfileSetupPrompt(existing, defaults);
    case "linux":
    case "macos":
      return singleProfileSetupPrompt(platform, existing, defaults);
  }
}

async function readExistingConfig(
  stateRootPath: string,
  configPath: string,
): Promise<ExistingWizardConfig | undefined> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
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

  const config = await loadConfig({ stateRoot: stateRootPath, configPath });
  const document = parseToml(contents) as ExistingWizardConfigDocument;
  return { contents, document, declarations: config.declarations };
}

function mergeProfiles(
  ...profileSets: ReadonlyArray<ByorContract["profiles"] | undefined>
): ByorContract["profiles"] {
  const profilesDocument: Record<string, ByorProfileDeclaration> = {};
  for (const profileSet of profileSets) {
    for (const [name, profile] of Object.entries(profileSet ?? {})) {
      profilesDocument[name] = { ...profilesDocument[name], ...profile };
    }
  }
  return profilesDocument;
}

function preserveExistingWindowsConfig(
  document: WizardConfigDocument,
  existing: NonNullable<ExistingWizardConfigDocument["windows"]>,
): void {
  const shared = { ...document.windows?.shared, ...existing.shared };
  const windows = {
    ...document.windows,
    ...existing,
  };
  if (Object.keys(shared).length > 0) {
    windows.shared = shared;
  } else {
    delete windows.shared;
  }
  document.windows = windows;
}

function preserveExistingConfig(
  document: WizardConfigDocument,
  existing?: ExistingWizardConfigDocument,
): void {
  if (existing?.machine_id !== undefined) {
    document.machine_id = existing.machine_id;
  }
  if (existing?.linux?.profile !== undefined) {
    document.linux = { profile: existing.linux.profile };
  }
  if (existing?.macos?.profile !== undefined) {
    document.macos = { profile: existing.macos.profile };
  }
  if (existing?.windows !== undefined) {
    preserveExistingWindowsConfig(document, existing.windows);
  }
}

function selectWindowsConfig(
  document: WizardConfigDocument,
  contract: ByorContract,
  profiles: ReadonlyArray<string>,
): void {
  document.windows ??= {};
  document.windows.profiles = [...profiles];
  const { defaultProfiles: _defaultProfiles, ...shared } = contract.windows ?? {};
  if (Object.keys(shared).length > 0) {
    document.windows.shared = shared;
  } else {
    delete document.windows.shared;
  }
}

export function buildWizardConfigDocument(
  contract: ByorContract,
  source: WizardSource,
  options: WizardDocumentOptions,
): WizardConfigDocument {
  const { platform, profiles, manifest, existing } = options;
  const manifestWindows = manifest?.windows;
  const { defaultProfiles: _manifestDefaults, ...manifestShared } = manifestWindows ?? {};
  const document: WizardConfigDocument = {
    schema: 1,
    source,
    profiles: mergeProfiles(manifest?.profiles, existing?.profiles, contract.profiles),
  };
  if (Object.keys(manifestShared).length > 0) {
    document.windows = { shared: manifestShared };
  }

  preserveExistingConfig(document, existing);

  const backups = importedBackups(manifest, existing?.backups, platform);
  if (backups !== undefined) {
    document.schema = 2;
    document.backups = backups;
  }

  switch (platform) {
    case "linux":
      document.linux = { profile: profiles[0]! };
      break;
    case "macos":
      document.macos = { profile: profiles[0]! };
      break;
    case "windows":
      selectWindowsConfig(document, contract, profiles);
      break;
  }
  return document;
}

function importedBackups(
  manifest: ByorContract | undefined,
  existing: BackupsConfig | undefined,
  platform: HostPlatform,
): BackupsConfig | undefined {
  if (manifest === undefined) {
    return existing;
  }
  const declaration = manifest.backups;
  const profiles = Object.fromEntries(
    Object.entries(existing?.profiles ?? {}).filter(([, profile]) => profile.platform !== platform),
  );
  for (const [name, profile] of Object.entries(declaration?.profiles ?? {}).filter(
    ([, entry]) => entry.platform === platform,
  )) {
    if (profiles[name] !== undefined) {
      throw new Error(`Backup profile ${name} conflicts with an unrelated platform.`);
    }
    profiles[name] = profile;
  }
  const preferred = declaration?.defaultProfile ?? "";
  const profile = Object.hasOwn(profiles, preferred) ? preferred : Object.keys(profiles)[0];
  return profile === undefined ? undefined : { profile, profiles };
}

function backupSetupPrompt(document: WizardConfigDocument, platform: HostPlatform, root?: string) {
  return Effect.gen(function* () {
    if (platform === "linux") {
      return;
    }
    const current = document.backups;
    if (
      !(yield* Prompt.run(
        Prompt.Confirm({
          message: "Configure independent backup profiles?",
          initial: current !== undefined,
        }),
      ))
    ) {
      return;
    }
    const profiles = { ...current?.profiles };
    const candidates = Object.keys(profiles).filter(
      (name) => profiles[name]?.platform === platform,
    );
    const name = yield* profileNamePrompt("Backup profile", current?.profile, candidates);
    const files = yield* normalizedTextPrompt(
      "Backup TOML files, comma-separated in composition order",
      (value) => value.split(",").map(normalizeBackupPath).join(", "),
      profiles[name]?.files.join(", "),
    );
    profiles[name] = {
      ...profiles[name],
      platform,
      files: files.split(",").map((file) => file.trim()),
    };
    const validated = yield* tryPromise(async () =>
      normalizeBackups({ defaultProfile: name, profiles })!,
    );
    if (root !== undefined) {
      for (const [profile, declaration] of Object.entries(validated.profiles)) {
        if (declaration.platform === platform) {
          yield* tryPromise(() => composeBackupProfile({ root, profile, declaration }));
        }
      }
    }
    document.schema = 2;
    document.backups = { profile: name, profiles: validated.profiles };
  });
}

export function addLinuxSourcePaths(
  document: WizardConfigDocument,
  profileName: string,
  paths: ReadonlyArray<string>,
): WizardConfigDocument {
  const profile = document.profiles[profileName];
  if (profile?.linux?.nix === undefined) {
    throw new Error(`Linux profile \`${profileName}\` does not declare a Nix flake.`);
  }

  const profiles = { ...document.profiles } satisfies ByorContract["profiles"];
  profiles[profileName] = {
    ...profile,
    linux: {
      ...profile.linux,
      paths: [...new Set([...(profile.linux.paths ?? []), ...paths])],
    },
  };
  return { ...document, profiles };
}

async function validateLocalProfile(answers: WizardAnswers): Promise<void> {
  const root = answers.localRoot;
  if (root === undefined) {
    return;
  }
  const profile = answers.profiles.join(",");
  const validate = {
    linux: () =>
      validateLinuxByorSource({
        root,
        profile,
        contract: answers.contract,
      }),
    macos: () =>
      validateMacosByorSource({
        root,
        profile,
        contract: answers.contract,
      }),
    windows: () =>
      validateWindowsByorSource({
        root,
        profiles: answers.profiles,
        contract: answers.contract,
      }),
  }[answers.platform];
  await validate();
}

function configLocationPrompt() {
  return Effect.gen(function* () {
    const root = stateRoot();
    const defaultPath = envValue("OUTFITTING_CONFIG") ?? configFilePath(root);
    const configPath = yield* targetPathPrompt(defaultPath);
    const existing = yield* tryPromise(() => readExistingConfig(root, configPath));
    const machineId = yield* optionalTextPrompt(
      "Machine ID override (blank for automatic detection)",
      existing?.document.machine_id,
    );
    return { configPath, existing, machineId };
  });
}

function sourceKindPrompt(existingSource?: WizardSource) {
  return Prompt.run(
    Prompt.Select({
      message: "Where is the Outfitting source?",
      choices: [
        {
          title: "Use a local checkout",
          value: "local",
          selected: existingSource !== undefined && "path" in existingSource,
        },
        {
          title: "Use a remote Git repository",
          value: "remote",
          selected: existingSource !== undefined && "repository" in existingSource,
        },
      ],
    }),
  );
}

function localSourceSetupPrompt(configPath: string, existingSource?: WizardSource) {
  return Effect.gen(function* () {
    const defaultPath =
      existingSource !== undefined && "path" in existingSource
        ? existingSource.path
        : process.cwd();
    const local = yield* localSourcePathPrompt(dirname(configPath), defaultPath);
    return { source: { path: local.path }, localRoot: local.root };
  });
}

function remoteSourceSetupPrompt(existingSource?: WizardSource) {
  return Effect.gen(function* () {
    const existingRemote =
      existingSource !== undefined && "repository" in existingSource ? existingSource : undefined;
    const repository = yield* normalizedTextPrompt(
      "Git repository URL",
      normalizeGitRepository,
      existingRemote?.repository,
      true,
    );
    const ref = yield* normalizedTextPrompt(
      "Git branch, tag, or ref",
      validateGitRef,
      existingRemote?.ref ?? "main",
      existingRemote?.ref !== undefined,
    );
    return { source: { repository, ref }, localRoot: undefined };
  });
}

function sourceSetupPrompt(configPath: string, existing?: ExistingWizardConfig) {
  return Effect.gen(function* () {
    const existingSource = existing?.document.source;
    const sourceKind = yield* sourceKindPrompt(existingSource);
    if (sourceKind === "local") {
      return yield* localSourceSetupPrompt(configPath, existingSource);
    }
    return yield* remoteSourceSetupPrompt(existingSource);
  });
}

function manifestPathPrompt(explicitPath?: string) {
  if (explicitPath !== undefined) {
    return Effect.try({
      try: () => relativeSourcePath(explicitPath, "BYOR manifest path"),
      catch: errorMessage,
    });
  }
  return Prompt.run(
    Prompt.Confirm({ message: "Import declarations from a repo-side manifest?", initial: false }),
  ).pipe(
    Effect.flatMap((importManifest) =>
      importManifest
        ? normalizedTextPrompt(
            "Repo-relative manifest path",
            (value) => relativeSourcePath(value, "BYOR manifest path"),
            BYOR_CONTRACT_PATH,
          )
        : Effect.void,
    ),
  );
}

async function readSourceManifest(
  source: WizardSource,
  localRoot: string | undefined,
  path: string,
): Promise<ByorContract> {
  if (localRoot !== undefined) {
    return readByorContractFile(localRoot, path);
  }
  if (!("repository" in source)) {
    throw new Error("A local repository root is required to read its manifest.");
  }
  const repository = classifyGitHubRepository(source.repository);
  if (repository !== undefined) {
    const file = await readGitHubFile({ repository, ref: source.ref, path });
    return parseByorContractJson(new TextDecoder().decode(file.body), path);
  }
  return parseByorContractJson(
    await readGitFile({ repository: source.repository, ref: source.ref, path }),
    path,
  );
}

function interview(platform: HostPlatform, explicitManifestPath?: string) {
  return Effect.gen(function* () {
    const { configPath, existing, machineId } = yield* configLocationPrompt();
    const { source, localRoot } = yield* sourceSetupPrompt(configPath, existing);
    const manifestPath = yield* manifestPathPrompt(explicitManifestPath);
    const manifest =
      manifestPath === undefined
        ? undefined
        : yield* tryPromise(() => readSourceManifest(source, localRoot, manifestPath));
    const { contract, profiles } = yield* profileSetupPrompt(platform, existing, manifest);
    return {
      configPath,
      contract,
      manifest,
      machineId,
      platform,
      profiles,
      source,
      localRoot,
      existing,
    } satisfies WizardAnswers;
  }).pipe(
    Effect.catchTag("QuitError", () =>
      Console.log(ui.muted("Setup wizard cancelled; no config was written.")).pipe(
        Effect.as(undefined),
      ),
    ),
  );
}

function confirm(message: string) {
  return Prompt.run(Prompt.Confirm({ message, initial: false })).pipe(
    Effect.catchTag("QuitError", () => Effect.succeed(false)),
  );
}

function commandPrefix(configPath: string, platform: HostPlatform): string {
  if (resolve(configPath) === resolve(configFilePath(stateRoot()))) {
    return "outfitting-manager";
  }
  if (platform === "windows") {
    return `$env:OUTFITTING_CONFIG = '${configPath.replaceAll("'", "''")}'; outfitting-manager`;
  }
  return `outfitting-manager --config '${configPath.replaceAll("'", "'\\''")}'`;
}

function selectedNixDeclaration(
  config: Awaited<ReturnType<typeof loadConfig>>,
  platform: HostPlatform,
  profiles: ReadonlyArray<string>,
): boolean {
  const declaration = config.declarations?.profiles[profiles[0]!];
  if (platform === "linux") {
    return declaration?.linux?.nix !== undefined;
  }
  if (platform === "macos") {
    return declaration?.macos?.nix !== undefined;
  }
  return false;
}

function isCoveredSourcePath(path: string, parent: string): boolean {
  return parent === "." || path === parent || path.startsWith(`${parent}/`);
}

type LoadedWizardConfig = Awaited<ReturnType<typeof loadConfig>>;

interface LinuxNixWizardState {
  document: WizardConfigDocument;
  serialized: string;
  config: LoadedWizardConfig;
  repo: OutfittingRepo;
}

interface NixPathReview {
  complete: boolean;
  updated: boolean;
}

function includeLinuxSourcePaths(
  answers: WizardAnswers,
  state: LinuxNixWizardState,
  profile: string,
  paths: ReadonlyArray<string>,
) {
  return Effect.gen(function* () {
    const document = addLinuxSourcePaths(state.document, profile, paths);
    const serialized = `${stringifyToml(document).trimEnd()}\n`;
    yield* Console.log("");
    yield* Console.log(ui.heading("Review the config with the discovered Nix source paths:"));
    yield* Console.log(serialized);
    if (!(yield* confirm("Write these repository paths and refresh the selected source?"))) {
      return false;
    }

    yield* tryPromise(() =>
      publishValidatedConfig(state.config.stateRoot, answers.configPath, serialized, {
        expectedExistingContents: state.serialized,
      }),
    );
    const config = yield* tryPromise(() =>
      loadConfig({ stateRoot: state.config.stateRoot, configPath: answers.configPath }),
    );
    const repo = yield* runSetup({
      platform: "linux",
      config,
      repoProfile: profile,
      refreshSource: true,
      skipSymlinks: true,
      nextCommand: "Checking the refreshed Nix source dependency closure…",
    });
    state.document = document;
    state.serialized = serialized;
    state.config = config;
    state.repo = repo;
    return true;
  });
}

function reviewLinuxNixPaths(
  answers: WizardAnswers,
  state: LinuxNixWizardState,
  profile: string,
  skippedPaths: Set<string>,
) {
  return Effect.gen(function* () {
    const linux = state.config.declarations?.profiles[profile]?.linux;
    if (linux?.nix === undefined) {
      return { complete: false, updated: false } satisfies NixPathReview;
    }
    const nix = linux.nix;

    const scanned = yield* Effect.result(
      tryPromise(() =>
        discoverNixSourcePaths({
          root: state.repo.root,
          flake: nix.flake,
          declaredPaths: linux.paths ?? [],
        }),
      ),
    );
    if (Result.isFailure(scanned)) {
      yield* Console.log(`Could not complete the Nix source scan: ${scanned.failure.message}`);
      return { complete: false, updated: false } satisfies NixPathReview;
    }

    const candidates = scanned.success.filter((path) => !skippedPaths.has(path));
    if (candidates.length === 0) {
      return { complete: true, updated: false } satisfies NixPathReview;
    }
    yield* Console.log(
      ui.heading(
        "Possible repository paths referenced by Nix files under the flake (heuristic scan):",
      ),
    );
    const selected = yield* Prompt.run(
      Prompt.MultiSelect({
        message: "Select the paths to include in the sparse source",
        min: 0,
        choices: candidates.map((path) => ({
          title: path,
          value: path,
          selected: true,
        })),
      }),
    );
    const selectedPaths = new Set(selected);
    for (const path of candidates) {
      if (!selectedPaths.has(path)) {
        skippedPaths.add(path);
      }
    }
    if (selected.length === 0) {
      return { complete: true, updated: false } satisfies NixPathReview;
    }

    const updated = yield* includeLinuxSourcePaths(answers, state, profile, selected);
    if (!updated) {
      for (const path of selected) {
        skippedPaths.add(path);
      }
      return { complete: false, updated: false } satisfies NixPathReview;
    }
    return { complete: true, updated: true } satisfies NixPathReview;
  });
}

function mayOfferNixActivation(sourceScanAvailable: boolean, skippedPaths: ReadonlySet<string>) {
  return Effect.gen(function* () {
    if (!sourceScanAvailable) {
      yield* Console.log(
        "The source dependency scan was incomplete, so the wizard will not offer activation.",
      );
      return false;
    }
    if (skippedPaths.size === 0) {
      return true;
    }

    yield* Console.log(
      `Static path suggestions not included:\n${[...skippedPaths].map((path) => `  ${path}`).join("\n")}`,
    );
    return yield* confirm(
      "The Nix dry-run passed, but these suggested paths were skipped. Continue to activation anyway?",
    );
  });
}

function isNixPathIncluded(linux: LinuxProfileDeclaration | undefined, path: string): boolean {
  return (
    (linux?.nix !== undefined && isCoveredSourcePath(path, linux.nix.flake)) ||
    (linux?.paths ?? []).some((declared) => isCoveredSourcePath(path, declared))
  );
}

function retryMissingNixPath(
  answers: WizardAnswers,
  state: LinuxNixWizardState,
  profile: string,
  message: string,
) {
  return Effect.gen(function* () {
    const missingPath = missingSourcePathFromNixError(message, state.repo.root);
    const linux = state.config.declarations?.profiles[profile]?.linux;
    if (missingPath === undefined) {
      return false;
    }
    if (state.config.source?.kind !== "remote" || isNixPathIncluded(linux, missingPath)) {
      return false;
    }

    yield* Console.log(`Nix reported an unfetched repository path: ${missingPath}`);
    return yield* includeLinuxSourcePaths(answers, state, profile, [missingPath]);
  });
}

function prepareLinuxNixSetup(answers: WizardAnswers, initial: LinuxNixWizardState) {
  return Effect.gen(function* () {
    const profile = answers.profiles[0]!;
    const state = { ...initial };
    const skippedPaths = new Set<string>();
    let sourceScanAvailable = true;
    let nixReady = false;
    let finished = false;

    for (let attempt = 0; attempt < 12; attempt++) {
      if (sourceScanAvailable) {
        const review = yield* reviewLinuxNixPaths(answers, state, profile, skippedPaths);
        sourceScanAvailable = review.complete;
        if (review.updated) {
          continue;
        }
      }

      const build = yield* Effect.result(
        withActivity(
          `Checking Nix source (attempt ${attempt + 1})`,
          tryPromise(() => buildNixSystem({ repo: state.repo, mode: "dry" })),
          { announceNonTTY: false },
        ),
      );
      if (Result.isSuccess(build)) {
        yield* Console.log(ui.success("Nix dry-run passed."));
        nixReady = yield* mayOfferNixActivation(sourceScanAvailable, skippedPaths);
        finished = true;
        break;
      }

      let message = build.failure.message;
      if (
        state.repo.flakeKind === "home-manager" &&
        !state.repo.systemAttr.endsWith(".activationPackage")
      ) {
        message +=
          "\nHome Manager output attributes should select a derivation, usually homeConfigurations.<name>.activationPackage.";
      }
      yield* Console.log(`Nix dry-run failed; activation will be withheld.\n${message}`);
      if (yield* retryMissingNixPath(answers, state, profile, message)) {
        continue;
      }
      finished = true;
      break;
    }

    if (!finished) {
      yield* Console.log(
        "Nix source validation reached its retry limit; activation will be withheld.",
      );
    }
    if (!nixReady) {
      yield* Console.log(
        "Review the Nix paths and output attribute, then rerun `outfitting-manager config wizard`.",
      );
    }
    return { ...state, nixReady };
  });
}

function displayNextCommands(commands: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    if (commands.length === 0) {
      return;
    }
    yield* Console.log(ui.muted("Continue setup later with:"));
    for (const command of commands) {
      yield* Console.log(`  ${command}`);
    }
  });
}

function continueLinuxSetup(
  config: Awaited<ReturnType<typeof loadConfig>>,
  profiles: ReadonlyArray<string>,
  prefix: string,
  strict: boolean,
) {
  return Effect.gen(function* () {
    const profile = profiles[0]!;
    const declaration = config.declarations?.profiles[profile]?.linux;
    if (declaration?.apt === undefined && declaration?.pacman === undefined) {
      return [];
    }
    if (yield* confirm("Install missing packages declared for this Linux profile now?")) {
      yield* applyLinux({
        config,
        profile,
        strict,
        noRefresh: true,
        ifConfigured: true,
        confirm: Prompt.run(
          Prompt.Confirm({ message: "Apply the displayed package plan?", initial: false }),
        ).pipe(Effect.orDie),
      });
      return [];
    }
    return [`${prefix} apply --no-refresh${strict ? " --strict" : ""}`];
  });
}

function continueMacosSetup(
  config: Awaited<ReturnType<typeof loadConfig>>,
  profiles: ReadonlyArray<string>,
  prefix: string,
  strict: boolean,
) {
  return Effect.gen(function* () {
    const profile = profiles[0]!;
    const declaration = config.declarations?.profiles[profile]?.macos;
    if (declaration?.brewfile === undefined) {
      return [];
    }
    if (
      yield* confirm(
        "Install the declared Homebrew packages now? This may trust taps and install software.",
      )
    ) {
      yield* applyBrew({ config, profile, noPush: true, strict });
      return [];
    }
    return [`${prefix} apply --no-refresh${strict ? " --strict" : ""}`];
  });
}

function continueWindowsSetup(
  config: Awaited<ReturnType<typeof loadConfig>>,
  profiles: ReadonlyArray<string>,
  prefix: string,
  strict: boolean,
) {
  return Effect.gen(function* () {
    if (yield* confirm("Review and apply the selected Windows package plan now?")) {
      yield* applyWindows({
        config,
        profiles,
        strict,
        confirm: Prompt.run(
          Prompt.Confirm({ message: "Apply the displayed package plan?", initial: false }),
        ).pipe(Effect.orDie),
      });
      return [];
    }
    return [`${prefix} apply${strict ? " --strict" : ""}`];
  });
}

function continueNixSetup(
  config: Awaited<ReturnType<typeof loadConfig>>,
  platform: HostPlatform,
  profiles: ReadonlyArray<string>,
  nixReady: boolean,
) {
  return Effect.gen(function* () {
    if (!selectedNixDeclaration(config, platform, profiles)) {
      return [];
    }
    const prefix = commandPrefix(config.configPath, platform);
    if (platform === "linux" && !nixReady) {
      yield* Console.log(
        "Nix activation is disabled because the wizard's Nix preflight did not pass.",
      );
      return [`${prefix} nix dry-run --no-refresh --no-push`];
    }
    const message =
      platform === "macos"
        ? "Activate the nix-darwin system now? This may require administrator access."
        : "Activate the selected Home Manager profile now?";
    if (yield* confirm(message)) {
      yield* withActivity(
        "Switching the Nix profile",
        updateNix({
          action: "switch",
          config,
          profile: profiles[0],
          noRefresh: true,
          ifConfigured: true,
          noPush: true,
        }),
      );
      return [];
    }
    return [`${prefix} nix switch --no-refresh --no-push`];
  });
}

function continueSetup(options: {
  config: Awaited<ReturnType<typeof loadConfig>>;
  platform: HostPlatform;
  profiles: ReadonlyArray<string>;
  nixReady: boolean;
  strict: boolean;
}) {
  return Effect.gen(function* () {
    const { config, platform, profiles, nixReady, strict } = options;
    const prefix = commandPrefix(config.configPath, platform);
    const platformSetup = {
      linux: continueLinuxSetup,
      macos: continueMacosSetup,
      windows: continueWindowsSetup,
    }[platform];
    const nextCommands = yield* platformSetup(config, profiles, prefix, strict);
    nextCommands.push(...(yield* continueNixSetup(config, platform, profiles, nixReady)));
    yield* displayNextCommands(nextCommands);
  });
}

const runWizard = (strict: boolean, manifestPath?: string) =>
  Effect.gen(function* () {
    const platform = hostPlatform();
    const answers = yield* interview(platform, manifestPath);
    if (answers === undefined) {
      return;
    }

    yield* tryPromise(() => validateLocalProfile(answers));
    const document = buildWizardConfigDocument(answers.contract, answers.source, {
      platform,
      profiles: answers.profiles,
      manifest: answers.manifest,
      existing: answers.existing?.document,
    });
    yield* backupSetupPrompt(document, platform, answers.localRoot);
    if (answers.machineId === undefined) {
      delete document.machine_id;
    } else {
      document.machine_id = answers.machineId;
    }
    const serialized = `${stringifyToml(document).trimEnd()}\n`;
    const editing = answers.existing !== undefined;

    yield* Console.log("");
    yield* Console.log(
      ui.heading(editing ? "Review the updated config.toml:" : "Review the new config.toml:"),
    );
    yield* Console.log(serialized);
    if (
      !(yield* confirm(
        editing
          ? "Write these changes and initialize the selected Outfitting source?"
          : "Write this config and initialize the selected Outfitting source?",
      ))
    ) {
      yield* Console.log(
        ui.muted(
          editing
            ? "Edit cancelled; no config was written."
            : "Setup cancelled; no config was written.",
        ),
      );
      return;
    }

    const root = stateRoot();
    yield* tryPromise(() =>
      publishValidatedConfig(root, answers.configPath, serialized, {
        expectedExistingContents: answers.existing?.contents,
      }),
    );
    let config = yield* tryPromise(() =>
      loadConfig({ stateRoot: root, configPath: answers.configPath }),
    );
    yield* Console.log(
      ui.success(`Config ${editing ? "updated" : "created"}: ${config.configPath}`),
    );
    yield* Console.log(ui.heading("Preparing Outfitting state and validating the source…"));
    const needsLinuxNixPreflight =
      platform === "linux" && selectedNixDeclaration(config, platform, answers.profiles);
    const repo = yield* withActivity(
      "Initializing the selected source",
      runSetup({
        platform,
        config,
        repoProfile: answers.profiles.join(","),
        refreshSource: true,
        skipSymlinks: true,
        nextCommand: needsLinuxNixPreflight
          ? "Checking the selected Nix source before offering activation…"
          : "Source is initialized. Choose whether to apply packages below.",
      }),
    );
    let nixReady = true;
    if (needsLinuxNixPreflight) {
      const prepared = yield* prepareLinuxNixSetup(answers, {
        document,
        serialized,
        config,
        repo,
      });
      config = prepared.config;
      nixReady = prepared.nixReady;
    }
    yield* continueSetup({ config, platform, profiles: answers.profiles, nixReady, strict });
  });

export const configWizardCommand = Command.make(
  "wizard",
  {
    strict: Flag.Boolean("strict").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Stop at the first package installation failure during setup."),
    ),
    manifest: Flag.String("manifest").pipe(
      Flag.optional,
      Flag.withDescription("Import this repo-relative BYOR manifest into config.toml."),
    ),
  },
  ({ strict, manifest }) => runWizard(strict, Option.getOrUndefined(manifest)),
).pipe(Command.withDescription("Create or edit config.toml, then initialize its source."));
