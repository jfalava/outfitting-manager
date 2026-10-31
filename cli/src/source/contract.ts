import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import { Result, Schema } from "effect";

import { BackupCredentials, Job, JobPolicy } from "@/backups/model";
import { validateBackupBindings } from "@/backups/paths";
import { errorMessage } from "@/errors";
import { platformLabel, type HostPlatform } from "@/platform";
import { parseLinuxPackageManifest } from "@/source/linux-manifest";
import { isProfileName } from "@/source/profile-name";
import { isReservedSourcePath } from "@/source/reserved";
import { parseWindowsPackageList } from "@/source/windows-manifest";

export const BYOR_CONTRACT_PATH = "outfitting.json";
export const BYOR_CONTRACT_SCHEMA = 3;

export type LinuxPackageBackend = "apt" | "pacman";

export interface LinuxPackageDeclaration {
  manifest: string;
}

export interface LinuxNixDeclaration {
  flake: string;
  attribute: string;
}

export interface LinuxProfileDeclaration {
  apt?: LinuxPackageDeclaration;
  pacman?: LinuxPackageDeclaration;
  nix?: LinuxNixDeclaration;
  /**
   * Files outside the flake directory that Nix reads from the sparse source.
   * An empty array means the user confirmed there are no out-of-flake reads.
   */
  paths?: string[];
}

export interface WindowsWingetDeclaration {
  manifest: string;
}

export interface WindowsPathDeclaration {
  path: string;
}

export interface WindowsManifestDeclaration {
  manifest: string;
}

export interface WindowsProfileDeclaration {
  winget: WindowsWingetDeclaration;
}

export interface MacosNixDeclaration {
  flake: string;
  attribute: string;
  /** Repository-relative darwin.nix path; defaults to `<flake>/darwin.nix`. */
  darwin?: string;
}

export interface MacosFontsDeclaration {
  manifest: string;
}

export interface MacosProfileDeclaration {
  nix: MacosNixDeclaration;
  brewfile?: string;
  fonts?: MacosFontsDeclaration;
  /**
   * Extra repository-relative paths that must exist as files.
   * An empty array means the user confirmed there are no out-of-flake reads.
   */
  paths?: string[];
}

export interface ByorWindowsShared {
  defaultProfiles?: string[];
  scoop?: WindowsManifestDeclaration;
  powershell?: WindowsPathDeclaration;
  fonts?: WindowsManifestDeclaration;
  registry?: WindowsPathDeclaration;
}

export type BackupPlatform = "macos" | "windows";

export interface BackupProfileDeclaration {
  platform: BackupPlatform;
  files: string[];
  paths?: Readonly<Record<string, string>>;
  jobs?: Readonly<Record<string, JobPolicy>>;
}

export interface ByorBackupsDeclaration {
  defaultProfile: string;
  /** Native service names imported into local config; never credential values. */
  credentials?: BackupCredentials;
  profiles: Readonly<Record<string, BackupProfileDeclaration>>;
}

export interface ByorProfileDeclaration {
  linux?: LinuxProfileDeclaration;
  windows?: WindowsProfileDeclaration;
  macos?: MacosProfileDeclaration;
}

export interface ByorContract {
  schema: typeof BYOR_CONTRACT_SCHEMA;
  windows?: ByorWindowsShared;
  backups?: ByorBackupsDeclaration;
  profiles: Readonly<Record<string, ByorProfileDeclaration>>;
}

export interface SelectedByorProfile {
  name: string;
  linux: LinuxProfileDeclaration;
}

export interface SelectedMacosByorProfile {
  name: string;
  macos: MacosProfileDeclaration;
}

export interface SelectedWindowsByorProfiles {
  names: string[];
  wingetPaths: Record<string, string>;
  shared: ByorWindowsShared | undefined;
}

export interface ValidatedLinuxByorProfile {
  root: string;
  profile: string;
  contract: ByorContract;
  linux: LinuxProfileDeclaration;
  backends: ReadonlyArray<LinuxPackageBackend | "nix">;
}

export interface ValidatedMacosByorProfile {
  root: string;
  profile: string;
  contract: ByorContract;
  macos: MacosProfileDeclaration;
  /** Absolute flake directory (contains flake.nix). */
  flakePath: string;
  /** Absolute darwin.nix path. */
  darwinNixPath: string;
  systemAttr: string;
}

export interface ValidatedWindowsByorSource {
  root: string;
  names: string[];
  wingetPaths: Record<string, string>;
  shared: ByorWindowsShared | undefined;
  contract: ByorContract;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type ByorContractInput = {
  schema: typeof BYOR_CONTRACT_SCHEMA;
  windows?: ByorWindowsShared;
  backups?: ByorBackupsDeclaration;
  profiles: Readonly<Record<string, ByorProfileDeclaration>>;
};
type ByorContractValue = JsonValue | ByorContractInput;

const PackageDeclarationSchema = Schema.Struct({
  manifest: Schema.String,
});

const NixDeclarationSchema = Schema.Struct({
  flake: Schema.String,
  attribute: Schema.String,
});

const LinuxProfileSchema = Schema.Struct({
  apt: Schema.optionalKey(PackageDeclarationSchema),
  pacman: Schema.optionalKey(PackageDeclarationSchema),
  nix: Schema.optionalKey(NixDeclarationSchema),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
});

const WindowsWingetSchema = Schema.Struct({
  manifest: Schema.String,
});

const WindowsProfileSchema = Schema.Struct({
  winget: WindowsWingetSchema,
});

const MacosNixSchema = Schema.Struct({
  flake: Schema.String,
  attribute: Schema.String,
  darwin: Schema.optionalKey(Schema.String),
});

const MacosFontsSchema = Schema.Struct({
  manifest: Schema.String,
});

const MacosProfileSchema = Schema.Struct({
  nix: MacosNixSchema,
  brewfile: Schema.optionalKey(Schema.String),
  fonts: Schema.optionalKey(MacosFontsSchema),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
});

const WindowsPathSchema = Schema.Struct({
  path: Schema.String,
});

const WindowsManifestSchema = Schema.Struct({
  manifest: Schema.String,
});

const ByorWindowsSharedSchema = Schema.Struct({
  defaultProfiles: Schema.optionalKey(Schema.Array(Schema.String)),
  scoop: Schema.optionalKey(WindowsManifestSchema),
  powershell: Schema.optionalKey(WindowsPathSchema),
  fonts: Schema.optionalKey(WindowsManifestSchema),
  registry: Schema.optionalKey(WindowsPathSchema),
});

export const BackupProfileSchema = Schema.Struct({
  platform: Schema.Union([Schema.Literal("macos"), Schema.Literal("windows")]),
  files: Schema.Array(Schema.String),
  paths: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  jobs: Schema.optionalKey(Schema.Record(Job, JobPolicy)),
});

const BackupsSchema = Schema.Struct({
  defaultProfile: Schema.String,
  credentials: Schema.optionalKey(BackupCredentials),
  profiles: Schema.Record(Schema.String, BackupProfileSchema),
});

const ByorProfileSchema = Schema.Struct({
  linux: Schema.optionalKey(LinuxProfileSchema),
  windows: Schema.optionalKey(WindowsProfileSchema),
  macos: Schema.optionalKey(MacosProfileSchema),
});

const ByorContractSchema = Schema.Struct({
  schema: Schema.Literal(BYOR_CONTRACT_SCHEMA),
  windows: Schema.optionalKey(ByorWindowsSharedSchema),
  backups: Schema.optionalKey(BackupsSchema),
  profiles: Schema.Record(Schema.String, ByorProfileSchema),
});

type DecodedPackageDeclaration = Schema.Schema.Type<typeof PackageDeclarationSchema>;
type DecodedNixDeclaration = Schema.Schema.Type<typeof NixDeclarationSchema>;
type DecodedLinuxProfile = Schema.Schema.Type<typeof LinuxProfileSchema>;
type DecodedWindowsProfile = Schema.Schema.Type<typeof WindowsProfileSchema>;
type DecodedMacosProfile = Schema.Schema.Type<typeof MacosProfileSchema>;
type DecodedWindowsShared = Schema.Schema.Type<typeof ByorWindowsSharedSchema>;
type DecodedContract = Schema.Schema.Type<typeof ByorContractSchema>;

const decodeByorContract = Schema.decodeUnknownResult(ByorContractSchema, {
  onExcessProperty: "error",
});

function requiredString(value: string, label: string): string {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

export function normalizeBackupPath(path: string): string {
  const value = path.trim().replaceAll("\\", "/");
  if (value.length === 0 || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error("Backup TOML paths must be non-empty repository-relative paths.");
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        /[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
        /[<>:"|?*]/.test(part) ||
        [...part].some((char) => char.charCodeAt(0) < 32),
    )
  ) {
    throw new Error(`Unsafe backup TOML path: ${path}.`);
  }
  if (
    !value.endsWith(".toml") ||
    isReservedSourcePath(value.toLowerCase()) ||
    parts.some((part) => part.toLowerCase() === ".git")
  ) {
    throw new Error(`Backup path must name a non-reserved TOML file: ${path}.`);
  }
  return parts.join("/");
}

function normalizeBackupPolicies(
  jobs: NonNullable<BackupProfileDeclaration["jobs"]>,
  platform: BackupPlatform,
) {
  const policies = Schema.decodeSync(Schema.Record(Job, JobPolicy), {
    onExcessProperty: "error",
  })(jobs);
  for (const [job, policy] of Object.entries(policies)) {
    const processes = policy.skipIfProcessesRunning ?? [];
    if (processes.length > 0 && platform !== "windows") {
      throw new Error(`Process guards for ${job} currently support Windows only.`);
    }
    if (
      processes.some((process) => process.toLowerCase().endsWith(".exe")) ||
      new Set(processes.map((process) => process.toLowerCase())).size !== processes.length
    ) {
      throw new Error(`Process names for ${job} must be unique basenames without .exe.`);
    }
  }
  return policies;
}

export function normalizeBackups(
  value: NonNullable<DecodedContract["backups"]>,
): ByorBackupsDeclaration {
  const names = Object.keys(value.profiles);
  if (names.length === 0 || !names.includes(value.defaultProfile)) {
    throw new Error("backups.defaultProfile must name a declared backup profile.");
  }
  const profiles: Record<string, BackupProfileDeclaration> = {};
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (!isProfileName(name)) {
      throw new Error(`Invalid backup profile name: ${name}.`);
    }
    if (profile.files.length === 0) {
      throw new Error(`Backup profile ${name} must declare files.`);
    }
    const files = profile.files.map(normalizeBackupPath);
    const identities =
      profile.platform === "windows" ? files.map((file) => file.toLowerCase()) : files;
    if (new Set(identities).size !== files.length) {
      throw new Error(`Backup profile ${name} contains duplicate files.`);
    }
    profiles[name] = { platform: profile.platform, files };
    if (profile.paths !== undefined) {
      validateBackupBindings(profile.paths, profile.platform);
      profiles[name].paths = profile.paths;
    }
    if (profile.jobs !== undefined) {
      profiles[name].jobs = normalizeBackupPolicies(profile.jobs, profile.platform);
    }
  }
  return { ...value, profiles };
}

function profileName(value: string, label: string): string {
  const profile = requiredString(value, label);
  if (!isProfileName(profile)) {
    throw new Error(`${label} must contain only letters, numbers, ., _, and -.`);
  }
  return profile;
}

/** Whether a repository-relative path equals or sits under `parent` ("." covers everything). */
export function isWithinSourcePath(path: string, parent: string): boolean {
  return parent === "." || path === parent || path.startsWith(`${parent}/`);
}

/** Normalize repository paths, accepting one leading slash but rejecting traversal and platform escapes. */
export function relativeSourcePath(value: string, label: string): string {
  const path = requiredString(value, label).replace(/^\//, "");
  const segments = path.split("/");
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    /^[A-Za-z]:/.test(path) ||
    segments.some((segment) => segment.length === 0 || segment === "..")
  ) {
    throw new Error(`${label} must be a repository-relative path without traversal.`);
  }
  return segments.filter((segment) => segment !== ".").join("/") || ".";
}

function parsePackageDeclaration(
  value: DecodedPackageDeclaration,
  label: string,
): LinuxPackageDeclaration {
  return {
    manifest: relativeSourcePath(value.manifest, `${label}.manifest`),
  };
}

function parseNixAttribute(value: string, label: string): string {
  const attribute = requiredString(value, label);
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(attribute)) {
    throw new Error(`${label} must be a dot-separated Nix attribute path.`);
  }
  return attribute;
}

function parseNixDeclaration(value: DecodedNixDeclaration, label: string): LinuxNixDeclaration {
  return {
    flake: relativeSourcePath(value.flake, `${label}.flake`),
    attribute: parseNixAttribute(value.attribute, `${label}.attribute`),
  };
}

function parseMacosNixDeclaration(
  value: DecodedMacosProfile["nix"],
  label: string,
): MacosNixDeclaration {
  const flake = relativeSourcePath(value.flake, `${label}.flake`);
  const nix: MacosNixDeclaration = {
    flake,
    attribute: parseNixAttribute(value.attribute, `${label}.attribute`),
  };
  if (value.darwin !== undefined) {
    nix.darwin = relativeSourcePath(value.darwin, `${label}.darwin`);
  }
  return nix;
}

function parseLinuxProfile(value: DecodedLinuxProfile, label: string): LinuxProfileDeclaration {
  const linux: LinuxProfileDeclaration = {};
  if (value.apt !== undefined) {
    linux.apt = parsePackageDeclaration(value.apt, `${label}.apt`);
  }
  if (value.pacman !== undefined) {
    linux.pacman = parsePackageDeclaration(value.pacman, `${label}.pacman`);
  }
  if (value.nix !== undefined) {
    linux.nix = parseNixDeclaration(value.nix, `${label}.nix`);
  }
  if (value.paths !== undefined) {
    linux.paths = value.paths.map((path, index) =>
      relativeSourcePath(path, `${label}.paths[${index}]`),
    );
  }
  if (linux.apt === undefined && linux.pacman === undefined && linux.nix === undefined) {
    throw new Error(`${label} must declare apt, pacman, or nix.`);
  }
  return linux;
}

function parseWindowsProfile(
  value: DecodedWindowsProfile,
  label: string,
): WindowsProfileDeclaration {
  return {
    winget: {
      manifest: relativeSourcePath(value.winget.manifest, `${label}.winget.manifest`),
    },
  };
}

function parseMacosProfile(value: DecodedMacosProfile, label: string): MacosProfileDeclaration {
  const macos: MacosProfileDeclaration = {
    nix: parseMacosNixDeclaration(value.nix, `${label}.nix`),
  };
  if (value.brewfile !== undefined) {
    macos.brewfile = relativeSourcePath(value.brewfile, `${label}.brewfile`);
  }
  if (value.fonts !== undefined) {
    macos.fonts = {
      manifest: relativeSourcePath(value.fonts.manifest, `${label}.fonts.manifest`),
    };
  }
  if (value.paths !== undefined) {
    macos.paths = value.paths.map((path, index) =>
      relativeSourcePath(path, `${label}.paths[${index}]`),
    );
  }
  return macos;
}

function parseWindowsShared(value: DecodedWindowsShared): ByorWindowsShared {
  const shared: ByorWindowsShared = {};
  if (value.defaultProfiles !== undefined) {
    if (value.defaultProfiles.length === 0) {
      throw new Error(`${BYOR_CONTRACT_PATH}.windows.defaultProfiles must not be empty.`);
    }
    shared.defaultProfiles = [
      ...new Set(
        value.defaultProfiles.map((name, index) =>
          profileName(name, `${BYOR_CONTRACT_PATH}.windows.defaultProfiles[${index}]`),
        ),
      ),
    ];
  }
  if (value.scoop !== undefined) {
    shared.scoop = {
      manifest: relativeSourcePath(
        value.scoop.manifest,
        `${BYOR_CONTRACT_PATH}.windows.scoop.manifest`,
      ),
    };
  }
  if (value.powershell !== undefined) {
    shared.powershell = {
      path: relativeSourcePath(
        value.powershell.path,
        `${BYOR_CONTRACT_PATH}.windows.powershell.path`,
      ),
    };
  }
  if (value.fonts !== undefined) {
    shared.fonts = {
      manifest: relativeSourcePath(
        value.fonts.manifest,
        `${BYOR_CONTRACT_PATH}.windows.fonts.manifest`,
      ),
    };
  }
  if (value.registry !== undefined) {
    shared.registry = {
      path: relativeSourcePath(value.registry.path, `${BYOR_CONTRACT_PATH}.windows.registry.path`),
    };
  }
  return shared;
}

function decodeContractRoot(value: ByorContractValue): DecodedContract {
  const decoded = decodeByorContract(value);
  if (Result.isFailure(decoded)) {
    const detail = decoded.failure.message.trim();
    throw new Error(
      detail.length > 0
        ? `${BYOR_CONTRACT_PATH} is invalid:\n${detail}`
        : `${BYOR_CONTRACT_PATH} must match schema ${BYOR_CONTRACT_SCHEMA}.`,
    );
  }
  if (Object.keys(decoded.success.profiles).length === 0) {
    throw new Error(`${BYOR_CONTRACT_PATH}.profiles must contain at least one profile.`);
  }
  return decoded.success;
}

interface ParsedProfileEntry {
  name: string;
  profile: ByorProfileDeclaration;
}

function parseProfileEntry(
  rawName: string,
  valueForProfile: DecodedContract["profiles"][string],
): ParsedProfileEntry {
  const name = profileName(rawName, `${BYOR_CONTRACT_PATH}.profiles profile name`);
  const profile: ByorProfileDeclaration = {};
  if (valueForProfile.linux !== undefined) {
    profile.linux = parseLinuxProfile(valueForProfile.linux, `${name}.linux`);
  }
  if (valueForProfile.windows !== undefined) {
    profile.windows = parseWindowsProfile(valueForProfile.windows, `${name}.windows`);
  }
  if (valueForProfile.macos !== undefined) {
    profile.macos = parseMacosProfile(valueForProfile.macos, `${name}.macos`);
  }
  if (profile.linux === undefined && profile.windows === undefined && profile.macos === undefined) {
    throw new Error(`${name} must declare linux, windows, and/or macos.`);
  }
  return { name, profile };
}

function parseOptionalWindowsShared(
  raw: DecodedWindowsShared | undefined,
  profiles: Record<string, ByorProfileDeclaration>,
): ByorWindowsShared | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const windows = parseWindowsShared(raw);
  for (const name of windows.defaultProfiles ?? []) {
    if (profiles[name]?.windows === undefined) {
      throw new Error(
        `${BYOR_CONTRACT_PATH}.windows.defaultProfiles references unknown Windows profile \`${name}\`.`,
      );
    }
  }
  return windows;
}

/** Parse and validate profile declarations and shared Windows paths. */
export function parseByorContract(value: ByorContractValue): ByorContract {
  const contract = decodeContractRoot(value);
  const profiles: Record<string, ByorProfileDeclaration> = {};
  for (const [rawName, valueForProfile] of Object.entries(contract.profiles)) {
    const parsed = parseProfileEntry(rawName, valueForProfile);
    profiles[parsed.name] = parsed.profile;
  }
  const windows = parseOptionalWindowsShared(contract.windows, profiles);
  const backups = contract.backups === undefined ? undefined : normalizeBackups(contract.backups);
  const result: ByorContract = {
    schema: BYOR_CONTRACT_SCHEMA,
    profiles,
  };
  if (windows !== undefined) {
    result.windows = windows;
  }
  if (backups !== undefined) {
    result.backups = backups;
  }
  return result;
}

/** Parse a JSON repository manifest with an error that names its actual path. */
export function parseByorContractJson(contents: string, path = BYOR_CONTRACT_PATH): ByorContract {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(contents) as JsonValue;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON.`, { cause });
  }
  try {
    return parseByorContract(parsed);
  } catch (cause) {
    throw new Error(`${path} is an invalid BYOR manifest: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

/** Read a repo-side manifest, allowing only paths that resolve inside the checkout. */
export async function readByorContractFile(
  root: string,
  path = BYOR_CONTRACT_PATH,
): Promise<ByorContract> {
  const manifestPath = relativeSourcePath(path, "BYOR manifest path");
  const realRoot = await realpath(root);
  let filePath: string;
  try {
    filePath = await realpath(join(realRoot, manifestPath));
  } catch (cause) {
    throw new Error(`BYOR manifest \`${manifestPath}\` is missing from ${realRoot}.`, { cause });
  }
  const fromRoot = relative(realRoot, filePath);
  if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`BYOR manifest \`${manifestPath}\` resolves outside the repository.`);
  }
  if (!(await stat(filePath)).isFile()) {
    throw new Error(`BYOR manifest \`${manifestPath}\` is not a regular file.`);
  }
  return parseByorContractJson(await readFile(filePath, "utf8"), manifestPath);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function fileOrDirectoryExists(path: string): Promise<boolean> {
  try {
    const entry = await stat(path);
    return entry.isFile() || entry.isDirectory();
  } catch {
    return false;
  }
}

/** Profile names declaring the given platform, in declaration order. */
export function profileNames(contract: ByorContract | undefined, platform: HostPlatform): string[] {
  return Object.entries(contract?.profiles ?? {})
    .filter(([, profile]) => profile[platform] !== undefined)
    .map(([name]) => name);
}

/** Shared Windows artifact paths without the manifest-only `defaultProfiles` selection. */
export function windowsSharedArtifacts(
  shared: ByorWindowsShared | undefined,
): Omit<ByorWindowsShared, "defaultProfiles"> | undefined {
  const { defaultProfiles: _defaultProfiles, ...artifacts } = shared ?? {};
  return Object.keys(artifacts).length > 0 ? artifacts : undefined;
}

/** Default darwin.nix path relative to the repository root for a macOS flake. */
export function macosDarwinRelativePath(nix: MacosNixDeclaration): string {
  return nix.darwin ?? `${nix.flake}/darwin.nix`;
}

/**
 * Repository-relative files and complete flake directory a macOS profile fetches.
 */
export function macosPathsFromProfile(decl: MacosProfileDeclaration): string[] {
  const paths = [decl.nix.flake, macosDarwinRelativePath(decl.nix)];
  if (decl.brewfile !== undefined) {
    paths.push(decl.brewfile);
  }
  if (decl.fonts !== undefined) {
    paths.push(decl.fonts.manifest);
  }
  if (decl.paths !== undefined) {
    paths.push(...decl.paths);
  }
  return paths;
}

/**
 * Select the one active profile for an exclusive platform: the requested name, or the only
 * declared profile. Shared by validation and flake resolution so messages stay identical.
 */
function selectExclusiveProfile<Platform extends "linux" | "macos">(
  contract: ByorContract,
  platform: Platform,
  requested: string | undefined,
) {
  const label = platformLabel(platform);
  const names = profileNames(contract, platform);
  const [only, ...others] = names;
  if (only === undefined) {
    throw new Error(`${BYOR_CONTRACT_PATH} does not declare any ${label} profiles.`);
  }
  if (requested === undefined && others.length > 0) {
    throw new Error(
      `The BYOR repository defines multiple profiles. Pass --profile (${names.join(", ")}).`,
    );
  }
  const name = requested === undefined ? only : profileName(requested, "--profile");
  const declaration = contract.profiles[name]?.[platform];
  if (declaration === undefined) {
    throw new Error(`Unknown BYOR ${label} profile \`${name}\`. Choose: ${names.join(", ")}.`);
  }
  return { name, declaration };
}

export function selectByorProfile(
  contract: ByorContract,
  requested: string | undefined,
): SelectedByorProfile {
  const { name, declaration } = selectExclusiveProfile(contract, "linux", requested);
  return { name, linux: declaration };
}

export function selectMacosByorProfile(
  contract: ByorContract,
  requested: string | undefined,
): SelectedMacosByorProfile {
  const { name, declaration } = selectExclusiveProfile(contract, "macos", requested);
  return { name, macos: declaration };
}

/**
 * Select one or more Windows profiles from a parsed contract.
 * Supports comma-composed names (Windows profiles are composable).
 */
export function selectWindowsByorProfiles(
  contract: ByorContract,
  requested: string[] | undefined,
): SelectedWindowsByorProfiles {
  const available = profileNames(contract, "windows");
  if (available.length === 0) {
    throw new Error(`${BYOR_CONTRACT_PATH} does not declare any Windows profiles.`);
  }

  const rawRequested =
    requested === undefined || requested.length === 0
      ? (contract.windows?.defaultProfiles ?? available)
      : requested.flatMap((value) => value.split(","));
  const names = [...new Set(rawRequested.map((value) => profileName(value, "--profile")))];

  const wingetPaths: Record<string, string> = {};
  for (const name of names) {
    const profile = contract.profiles[name];
    if (profile?.windows === undefined) {
      throw new Error(`Unknown BYOR Windows profile \`${name}\`. Choose: ${available.join(", ")}.`);
    }
    wingetPaths[name] = profile.windows.winget.manifest;
  }

  return { names, wingetPaths, shared: contract.windows };
}

function pushUnique(paths: string[], path: string): void {
  if (!paths.includes(path)) {
    paths.push(path);
  }
}

/** Repository-relative files and flake directories a Linux profile declares. */
export function linuxPathsFromProfile(decl: LinuxProfileDeclaration): string[] {
  const paths: string[] = [];
  if (decl.apt !== undefined) {
    pushUnique(paths, decl.apt.manifest);
  }
  if (decl.pacman !== undefined) {
    pushUnique(paths, decl.pacman.manifest);
  }
  if (decl.nix !== undefined) {
    pushUnique(paths, decl.nix.flake);
  }
  for (const path of decl.paths ?? []) {
    pushUnique(paths, path);
  }
  return paths;
}

/**
 * Repository-relative Windows files for the selected profiles.
 * Shared scoop, PowerShell, fonts, and registry paths are included only when declared.
 */
export function windowsPathsFromContract(
  contract: ByorContract,
  requested: string[] | undefined,
): string[] {
  const selected = selectWindowsByorProfiles(contract, requested);
  const paths: string[] = [];
  for (const manifest of Object.values(selected.wingetPaths)) {
    pushUnique(paths, manifest);
  }
  const shared = selected.shared;
  if (shared?.scoop !== undefined) {
    pushUnique(paths, shared.scoop.manifest);
  }
  if (shared?.powershell !== undefined) {
    pushUnique(paths, shared.powershell.path);
  }
  if (shared?.fonts !== undefined) {
    pushUnique(paths, shared.fonts.manifest);
  }
  if (shared?.registry !== undefined) {
    pushUnique(paths, shared.registry.path);
  }
  return paths;
}

async function validatePackageBackend(options: {
  root: string;
  profile: string;
  backend: LinuxPackageBackend;
  declaration: LinuxPackageDeclaration;
}): Promise<void> {
  const manifestPath = join(options.root, options.declaration.manifest);
  if (!(await fileExists(manifestPath))) {
    throw new Error(
      `BYOR profile \`${options.profile}\` declares ${options.backend} manifest ${options.declaration.manifest}, but the file is missing.`,
    );
  }
  let packages: string[];
  try {
    packages = parseLinuxPackageManifest(await readFile(manifestPath, "utf8"));
  } catch (cause) {
    throw new Error(
      `BYOR profile \`${options.profile}\` has an invalid ${options.backend} manifest ${options.declaration.manifest}: ${errorMessage(cause)}`,
      { cause },
    );
  }
  if (packages.length === 0) {
    throw new Error(
      `BYOR profile \`${options.profile}\` has an empty ${options.backend} manifest: ${options.declaration.manifest}.`,
    );
  }
}

/** Read a profile's `<flake>/flake.nix`, failing when it is missing or empty. */
async function readDeclaredFlake(root: string, profile: string, flake: string): Promise<string> {
  const flakePath = join(root, flake, "flake.nix");
  if (!(await fileExists(flakePath))) {
    throw new Error(
      `BYOR profile \`${profile}\` declares Nix flake ${flake}, but flake.nix is missing.`,
    );
  }
  const content = await readFile(flakePath, "utf8");
  if (content.trim().length === 0) {
    throw new Error(`BYOR profile \`${profile}\` has an empty Nix flake: ${flakePath}.`);
  }
  return content;
}

/** Read a declared repository file, failing as `subject` when it is missing or empty. */
async function readDeclaredFile(
  root: string,
  relativePath: string,
  subject: string,
): Promise<string> {
  const path = join(root, relativePath);
  if (!(await fileExists(path))) {
    throw new Error(`${subject} declares ${relativePath}, but the file is missing.`);
  }
  const content = await readFile(path, "utf8");
  if (content.trim().length === 0) {
    throw new Error(`${subject} is empty: ${relativePath}.`);
  }
  return content;
}

async function validateWingetManifest(options: {
  root: string;
  profile: string;
  manifest: string;
}): Promise<void> {
  const manifestPath = join(options.root, options.manifest);
  if (!(await fileExists(manifestPath))) {
    throw new Error(
      `BYOR profile \`${options.profile}\` declares winget manifest ${options.manifest}, but the file is missing.`,
    );
  }
  let packages: ReturnType<typeof parseWindowsPackageList>;
  try {
    packages = parseWindowsPackageList(await readFile(manifestPath, "utf8"), options.manifest);
  } catch (cause) {
    throw new Error(
      `BYOR profile \`${options.profile}\` has an invalid winget manifest ${options.manifest}: ${errorMessage(cause)}`,
      { cause },
    );
  }
  if (packages.length === 0) {
    throw new Error(
      `BYOR profile \`${options.profile}\` has an empty winget manifest: ${options.manifest}.`,
    );
  }
}

async function validateOptionalSharedFile(options: {
  root: string;
  label: string;
  relative: string;
  parse?: (content: string) => void;
}): Promise<void> {
  const subject = `BYOR windows.${options.label}`;
  const content = await readDeclaredFile(options.root, options.relative, subject);
  try {
    options.parse?.(content);
  } catch (cause) {
    throw new Error(`${subject} is invalid (${options.relative}): ${errorMessage(cause)}`, {
      cause,
    });
  }
}

async function resolveByorRoot(candidate: string): Promise<string> {
  let root: string;
  try {
    root = await realpath(candidate);
  } catch (cause) {
    throw new Error(`BYOR repository does not exist: ${candidate}.`, { cause });
  }
  if (!(await stat(root)).isDirectory()) {
    throw new Error(`BYOR repository is not a directory: ${root}.`);
  }
  return root;
}

/** Validate a user-provided Linux BYOR repository without changing the host. */
export async function validateLinuxByorSource(options: {
  root: string;
  contract: ByorContract;
  profile?: string;
}): Promise<ValidatedLinuxByorProfile> {
  const root = await resolveByorRoot(options.root);
  const contract = options.contract;
  const selected = selectByorProfile(contract, options.profile);
  const backends: Array<LinuxPackageBackend | "nix"> = [];

  for (const backend of ["apt", "pacman"] as const) {
    const declaration = selected.linux[backend];
    if (declaration !== undefined) {
      await validatePackageBackend({ root, profile: selected.name, backend, declaration });
      backends.push(backend);
    }
  }

  if (selected.linux.nix !== undefined) {
    await readDeclaredFlake(root, selected.name, selected.linux.nix.flake);
    backends.push("nix");
  }

  for (const path of selected.linux.paths ?? []) {
    if (!(await fileOrDirectoryExists(join(root, path)))) {
      throw new Error(
        `BYOR Linux profile \`${selected.name}\` declares missing repository path \`${path}\`.`,
      );
    }
  }

  return {
    root,
    profile: selected.name,
    contract,
    linux: selected.linux,
    backends,
  };
}

export async function validateWindowsSharedArtifacts(
  root: string,
  shared: ByorWindowsShared | undefined,
): Promise<void> {
  if (shared === undefined) {
    return;
  }
  if (shared.scoop !== undefined) {
    const { parseScoopManifest } = await import("@/update/scoop");
    await validateOptionalSharedFile({
      root,
      label: "scoop",
      relative: shared.scoop.manifest,
      parse: (content) => {
        parseScoopManifest(content);
      },
    });
  }
  if (shared.powershell !== undefined) {
    await validateOptionalSharedFile({
      root,
      label: "powershell",
      relative: shared.powershell.path,
    });
  }
  if (shared.fonts !== undefined) {
    await validateOptionalSharedFile({
      root,
      label: "fonts",
      relative: shared.fonts.manifest,
    });
  }
  if (
    shared.registry !== undefined &&
    !(await fileOrDirectoryExists(join(root, shared.registry.path)))
  ) {
    throw new Error(
      `BYOR windows.registry declares ${shared.registry.path}, but the path is missing.`,
    );
  }
}

/** Validate a user-provided Windows BYOR repository without changing the host. */
export async function validateWindowsByorSource(options: {
  root: string;
  contract: ByorContract;
  profiles?: string[];
}): Promise<ValidatedWindowsByorSource> {
  const root = await resolveByorRoot(options.root);
  const contract = options.contract;
  const selected = selectWindowsByorProfiles(contract, options.profiles);

  for (const [profile, manifest] of Object.entries(selected.wingetPaths)) {
    await validateWingetManifest({ root, profile, manifest });
  }
  await validateWindowsSharedArtifacts(root, selected.shared);

  return {
    root,
    names: selected.names,
    wingetPaths: selected.wingetPaths,
    shared: selected.shared,
    contract,
  };
}

/** Validate a user-provided macOS BYOR repository without changing the host. */
export async function validateMacosByorSource(options: {
  root: string;
  contract: ByorContract;
  profile?: string;
}): Promise<ValidatedMacosByorProfile> {
  const root = await resolveByorRoot(options.root);
  const contract = options.contract;
  const selected = selectMacosByorProfile(contract, options.profile);
  const flakeContent = await readDeclaredFlake(root, selected.name, selected.macos.nix.flake);
  if (!/\bdarwinConfigurations\s*=/.test(flakeContent)) {
    throw new Error(
      `BYOR profile \`${selected.name}\` has an invalid flake.nix: darwinConfigurations is required.`,
    );
  }

  const darwinRelative = macosDarwinRelativePath(selected.macos.nix);
  const darwinNixPath = join(root, darwinRelative);
  if (!(await fileExists(darwinNixPath))) {
    throw new Error(
      `BYOR profile \`${selected.name}\` declares darwin path ${darwinRelative}, but the file is missing.`,
    );
  }

  if (selected.macos.brewfile !== undefined) {
    await readDeclaredFile(
      root,
      selected.macos.brewfile,
      `BYOR profile \`${selected.name}\` brewfile`,
    );
  }
  if (selected.macos.fonts !== undefined) {
    await readDeclaredFile(
      root,
      selected.macos.fonts.manifest,
      `BYOR profile \`${selected.name}\` fonts.manifest`,
    );
  }
  if (selected.macos.paths !== undefined) {
    for (const relativePath of selected.macos.paths) {
      const path = join(root, relativePath);
      if (!(await fileExists(path))) {
        throw new Error(
          `BYOR profile \`${selected.name}\` declares path ${relativePath}, but the file is missing.`,
        );
      }
    }
  }

  return {
    root,
    profile: selected.name,
    contract,
    macos: selected.macos,
    flakePath: join(root, selected.macos.nix.flake),
    darwinNixPath,
    systemAttr: selected.macos.nix.attribute,
  };
}

/**
 * Validate the selected platform profile in a source root. Windows accepts a
 * comma-separated profile list; the other platforms take one profile name.
 */
export async function validateByorSource(
  root: string,
  platform: HostPlatform,
  profile: string | undefined,
  contract: ByorContract,
): Promise<void> {
  switch (platform) {
    case "linux":
      await validateLinuxByorSource({ root, profile, contract });
      return;
    case "macos":
      await validateMacosByorSource({ root, profile, contract });
      return;
    case "windows":
      await validateWindowsByorSource({ root, profiles: profile?.split(","), contract });
      return;
    default: {
      const exhaustive: never = platform;
      return exhaustive;
    }
  }
}
