import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import { composeBackupProfile } from "@/backups/composition";
import { sparseSourceRoot } from "@/config/paths";
import { configuredProfile } from "@/config/profile";
import type { ManagerConfig } from "@/config/types";
import { isNotFound, errorMessage } from "@/errors";
import {
  classifyGitHubRepository,
  readGitHubBlobs,
  type GitHubRepository,
  type ManifestFetcher,
} from "@/fetch/github";
import type { HostPlatform } from "@/platform";
import { runCommand } from "@/process";
import {
  BYOR_CONTRACT_SCHEMA,
  linuxPathsFromProfile,
  macosPathsFromProfile,
  selectByorProfile,
  selectMacosByorProfile,
  selectWindowsByorProfiles,
  windowsPathsFromContract,
  type ByorContract,
  relativeSourcePath,
  validateByorSource,
  windowsSharedArtifacts,
} from "@/source/contract";
import { gitModeToFileMode, selectSourceTreeEntries, type SourceTreeEntry } from "@/source/tree";

export interface ByorSourceFile {
  path: string;
  source: "network" | "cache";
  warning?: string;
}

export interface ByorSourceResult {
  root: string;
  files: ByorSourceFile[];
}

async function replaceSourceTree(staged: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const backup = await mkdtemp(join(dirname(target), ".outfitting-source-backup-"));
  await rm(backup, { recursive: true, force: true });

  let movedExisting = false;
  try {
    await rename(target, backup);
    movedExisting = true;
  } catch (cause) {
    if (!isNotFound(cause)) {
      throw cause;
    }
  }

  try {
    await rename(staged, target);
  } catch (cause) {
    if (movedExisting) {
      try {
        await rename(backup, target);
      } catch (restoreCause) {
        throw new Error(
          `Could not publish the refreshed source and could not restore the previous source. Previous source remains at ${backup}. Publish error: ${errorMessage(cause)}. Restore error: ${errorMessage(restoreCause)}.`,
          { cause: restoreCause },
        );
      }
    }
    throw cause;
  }

  if (movedExisting) {
    // Publication has committed. Cleanup failure must not report a failed refresh
    // while leaving the new source active; keep the backup for manual recovery.
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface ByorSparseSourceOptions {
  config: ManagerConfig;
  platform: HostPlatform;
  /** Selected profile. Windows accepts comma-separated names. */
  profile?: string;
  sourceRoot?: string;
  fetcher?: ManifestFetcher;
  run?: typeof runCommand;
  offline?: boolean;
}

interface StagedFiles {
  revision: string;
  paths: string[];
}

interface ByorSourceMetadata {
  format: "outfitting-source-v1";
  repository: string;
  ref: string;
  revision: string;
  declarationHash: string;
}

const SOURCE_METADATA_PATH = ".outfitting-source.json";
const ByorSourceMetadataSchema = Schema.Struct({
  format: Schema.Literal("outfitting-source-v1"),
  repository: Schema.String,
  ref: Schema.String,
  revision: Schema.String,
  declarationHash: Schema.String,
});
const decodeByorSourceMetadata = Schema.decodeUnknownSync(ByorSourceMetadataSchema);

function byorClosure(
  contract: ByorContract,
  platform: HostPlatform,
  profile: string | undefined,
  additionalFiles: ReadonlyArray<string> = [],
): string[] {
  const base = (() => {
    switch (platform) {
      case "macos":
        return macosPathsFromProfile(selectMacosByorProfile(contract, profile).macos);
      case "linux":
        return linuxPathsFromProfile(selectByorProfile(contract, profile).linux);
      case "windows":
        return windowsPathsFromContract(
          contract,
          profile === undefined ? undefined : profile.split(","),
        );
      default: {
        const exhaustive: never = platform;
        return exhaustive;
      }
    }
  })();
  return [...new Set([...base, ...additionalFiles])];
}

function requiredContract(config: ManagerConfig): ByorContract {
  if (config.declarations === undefined) {
    throw new Error(`No profile declarations are configured in ${config.configPath}.`);
  }
  return config.declarations;
}

function declarationHash(options: ByorSparseSourceOptions, contract: ByorContract): string {
  const {
    logDirectory: _logDirectory,
    credentials: _credentials,
    scheduleLabel: _scheduleLabel,
    alertsDisabled: _alertsDisabled,
    ...backups
  } = options.config.backups ?? {};
  const hashInput = JSON.stringify({
    contract: selectedContract(contract, options),
    backups: options.config.backups === undefined ? undefined : backups,
    platform: options.platform,
    profile: configuredProfile(options.config, options.platform, options.profile),
  });
  return createHash("sha256").update(hashInput).digest("hex");
}

function backupFiles(options: ByorSparseSourceOptions): string[] {
  return Object.values(options.config.backups?.profiles ?? {})
    .filter((profile) => profile.platform === options.platform)
    .flatMap((profile) => profile.files);
}

export async function validateBackups(
  root: string,
  options: Pick<ByorSparseSourceOptions, "config" | "platform">,
): Promise<void> {
  for (const [profile, declaration] of Object.entries(options.config.backups?.profiles ?? {})) {
    if (declaration.platform === options.platform) {
      await composeBackupProfile({ root, profile, declaration });
    }
  }
}

async function runGit(
  run: typeof runCommand,
  cwd: string,
  args: ReadonlyArray<string>,
): Promise<string> {
  const result = await run("git", args, { cwd, inherit: false });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `git ${args.join(" ")} failed (exit ${result.code})${detail.length > 0 ? `: ${detail}` : "."}`,
    );
  }
  return result.stdout;
}

function parseGitTree(output: string): SourceTreeEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      if (tab < 0) {
        throw new Error("Git returned a malformed tree entry.");
      }
      const [mode, type, object] = record.slice(0, tab).split(" ");
      if (mode === undefined || type === undefined || object === undefined) {
        throw new Error("Git returned a malformed tree entry.");
      }
      return { mode, type, path: record.slice(tab + 1) };
    });
}

/** Shallow-fetch `ref` into an empty repository at `checkout` and list its pinned tree. */
async function fetchPinnedTree(
  run: typeof runCommand,
  checkout: string,
  repository: string,
  ref: string,
): Promise<{ revision: string; entries: SourceTreeEntry[] }> {
  await runGit(run, checkout, ["init", "--quiet"]);
  await runGit(run, checkout, ["remote", "add", "origin", repository]);
  await runGit(run, checkout, ["fetch", "--depth=1", "--no-tags", "origin", ref]);
  const revision = (
    await runGit(run, checkout, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
  ).trim();
  if (!/^[0-9a-f]{40,64}$/i.test(revision)) {
    throw new Error("Git returned an invalid fetched revision.");
  }
  const entries = parseGitTree(
    await runGit(run, checkout, ["ls-tree", "--full-tree", "-rz", "-r", revision]),
  );
  return { revision, entries };
}

/** Read one file from a Git remote at a pinned fetched revision without materializing a checkout. */
export async function readGitFile(options: {
  repository: string;
  ref: string;
  path: string;
  run?: typeof runCommand;
}): Promise<string> {
  const path = relativeSourcePath(options.path, "Git manifest path");
  const checkout = await mkdtemp(join(tmpdir(), ".outfitting-git-manifest-"));
  const run = options.run ?? runCommand;
  try {
    const { revision, entries } = await fetchPinnedTree(
      run,
      checkout,
      options.repository,
      options.ref,
    );
    const entry = entries.find((candidate) => candidate.path === path);
    if (entry === undefined || entry.type !== "blob") {
      throw new Error(`Git manifest \`${path}\` is missing or is not a file.`);
    }
    if (gitModeToFileMode(entry.mode) === undefined) {
      throw new Error(`Git manifest \`${path}\` uses unsupported mode ${entry.mode}.`);
    }
    return await runGit(run, checkout, ["show", `${revision}:${path}`]);
  } finally {
    await rm(checkout, { force: true, recursive: true });
  }
}

async function copyGitSourceFiles(options: {
  repository: string;
  ref: string;
  paths: ReadonlyArray<string>;
  run: typeof runCommand;
  staged: string;
}): Promise<StagedFiles> {
  const checkout = await mkdtemp(join(dirname(options.staged), ".outfitting-git-"));
  try {
    const { revision, entries } = await fetchPinnedTree(
      options.run,
      checkout,
      options.repository,
      options.ref,
    );
    const selected = selectSourceTreeEntries(entries, options.paths, "Git");
    const roots = [...new Set(options.paths.map((path) => relativeSourcePath(path, "BYOR path")))];
    await runGit(options.run, checkout, ["checkout", revision, "--", ...roots]);

    for (const entry of selected) {
      const sourcePath = join(checkout, entry.path);
      const info = await lstat(sourcePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Git checkout produced an unsupported file at ${entry.path}.`);
      }
      const destination = join(options.staged, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(sourcePath, destination);
      await chmod(destination, entry.fileMode);
    }
    return { revision, paths: selected.map((entry) => entry.path) };
  } finally {
    await rm(checkout, { force: true, recursive: true });
  }
}

function selectedContract(contract: ByorContract, options: ByorSparseSourceOptions): ByorContract {
  switch (options.platform) {
    case "linux": {
      const selected = selectByorProfile(contract, options.profile);
      return {
        schema: BYOR_CONTRACT_SCHEMA,
        profiles: { [selected.name]: { linux: selected.linux } },
      };
    }
    case "macos": {
      const selected = selectMacosByorProfile(contract, options.profile);
      return {
        schema: BYOR_CONTRACT_SCHEMA,
        profiles: { [selected.name]: { macos: selected.macos } },
      };
    }
    case "windows": {
      const selected = selectWindowsByorProfiles(contract, options.profile?.split(","));
      const shared = windowsSharedArtifacts(contract.windows);
      const narrowedContract: ByorContract = {
        schema: BYOR_CONTRACT_SCHEMA,
        profiles: Object.fromEntries(
          selected.names.map((name) => [name, { windows: contract.profiles[name]!.windows! }]),
        ),
      };
      if (shared !== undefined) {
        narrowedContract.windows = shared;
      }
      return narrowedContract;
    }
  }
}

async function stageGitHubFiles(options: {
  repository: GitHubRepository;
  ref: string;
  paths: ReadonlyArray<string>;
  run: typeof runCommand;
  fetcher: ManifestFetcher | undefined;
  staged: string;
}): Promise<StagedFiles> {
  const files = await readGitHubBlobs(options);
  for (const file of files) {
    const destination = join(options.staged, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.body, { mode: file.mode });
  }
  const revision = files[0]?.revision;
  if (revision === undefined) {
    throw new Error("The selected profile declarations do not resolve to any repository files.");
  }
  return { revision, paths: files.map((file) => file.path) };
}

async function stageByorFiles(args: {
  staged: string;
  options: ByorSparseSourceOptions;
  source: { repository: string; ref: string };
  contract: ByorContract;
  paths: ReadonlyArray<string>;
}): Promise<ByorSourceFile[]> {
  const { staged, options, contract, paths } = args;
  const { repository, ref } = args.source;
  const run = options.run ?? runCommand;
  const githubRepository = classifyGitHubRepository(repository);
  const files =
    githubRepository === undefined
      ? await copyGitSourceFiles({ repository, ref, paths, run, staged })
      : await stageGitHubFiles({
          repository: githubRepository,
          ref,
          paths,
          run,
          fetcher: options.fetcher,
          staged,
        });
  const metadata: ByorSourceMetadata = {
    format: "outfitting-source-v1",
    repository,
    ref,
    revision: files.revision,
    declarationHash: declarationHash(options, contract),
  };
  await writeFile(join(staged, SOURCE_METADATA_PATH), `${JSON.stringify(metadata, null, 2)}\n`);
  return files.paths.map((path) => ({ path, source: "network" }));
}

async function readSourceMetadata(root: string): Promise<ByorSourceMetadata> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, SOURCE_METADATA_PATH), "utf8"));
  } catch (cause) {
    throw new Error(
      `No cached remote source exists at ${root}. Run outfitting-manager init to fetch it.`,
      { cause },
    );
  }
  try {
    return decodeByorSourceMetadata(value);
  } catch (cause) {
    throw new Error(`Remote BYOR source metadata is invalid at ${root}.`, { cause });
  }
}

/**
 * Fetch and validate the local map's selected remote closure before replacing the managed tree.
 * Offline mode validates and reuses the existing snapshot only for the selected Git repository/ref.
 */
export async function syncByorSparseSource(
  options: ByorSparseSourceOptions,
): Promise<ByorSourceResult> {
  const target = options.sourceRoot ?? sparseSourceRoot(options.config.stateRoot);
  if (options.config.source?.kind !== "remote") {
    throw new Error(`A remote [source] is required in ${options.config.configPath}.`);
  }
  const contract = requiredContract(options.config);
  const profile = configuredProfile(options.config, options.platform, options.profile);
  const selectedOptions = { ...options, profile };
  const currentDeclarationHash = declarationHash(selectedOptions, contract);
  if (options.offline) {
    const metadata = await readSourceMetadata(target);
    if (
      metadata.repository !== options.config.source.repository ||
      metadata.ref !== options.config.source.ref ||
      metadata.declarationHash !== currentDeclarationHash
    ) {
      throw new Error(
        `The cached source does not match the current repository, ref, and profile declarations in ${options.config.configPath}. Run outfitting-manager init to refresh it.`,
      );
    }
    await validateByorSource(target, options.platform, profile, contract);
    await validateBackups(target, selectedOptions);
    const paths = byorClosure(contract, options.platform, profile, backupFiles(selectedOptions));
    return { root: target, files: paths.map((path) => ({ path, source: "cache" })) };
  }
  const selected = selectedContract(contract, selectedOptions);
  const paths = byorClosure(selected, options.platform, profile, backupFiles(selectedOptions));
  await mkdir(dirname(target), { recursive: true });
  const staged = await mkdtemp(join(dirname(target), ".outfitting-source-"));
  try {
    const files = await stageByorFiles({
      staged,
      options: selectedOptions,
      source: options.config.source,
      contract,
      paths,
    });
    await validateByorSource(staged, options.platform, profile, contract);
    await validateBackups(staged, selectedOptions);
    await replaceSourceTree(staged, target);
    return { root: target, files };
  } catch (cause) {
    await rm(staged, { recursive: true, force: true });
    throw cause;
  }
}
