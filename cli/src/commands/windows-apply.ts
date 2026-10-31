import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { Console, Effect, Option, Predicate, Schema } from "effect";
import { Command, Flag, Prompt } from "effect/cli";

import { configuredProfile, loadConfig, type ManagerConfig } from "@/config";
import { toError, tryPromise } from "@/effect";
import { CliFailure, errorMessage } from "@/errors";
import { runCommand, which } from "@/process";
import { envValue } from "@/secrets";
import { syncByorSparseSource } from "@/setup/source";
import { validateWindowsByorSource, type SelectedWindowsByorProfiles } from "@/source/contract";
import { parseWindowsPackageList, type WindowsWingetPackage } from "@/source/windows-manifest";
import { TerminalSession, withTerminalInput } from "@/terminal-alert";
import { ui } from "@/ui";
import { logCommandOutput, withProgress, type ProgressRenderer } from "@/ui/progress";
import {
  normalizeBucketUrl,
  parseScoopManifest,
  scoopExport,
  type ScoopBucket,
  type ScoopManifest,
} from "@/update/scoop";
import { runScoopCommand } from "@/update/scoop-command";
import type { ScoopExportApp, ScoopExportState } from "@/update/scoop-export";
import {
  isWingetAlreadyInstalledExitCode,
  isWingetPackageAbsentExitCode,
  readWindowsLock,
  recordWindowsOperation,
  scoopPackageName,
  wingetIdentity,
  wingetSource,
  writeWindowsLock,
  type WindowsLock,
  type WindowsLockOperationInput,
  type WindowsPackageRecord,
} from "@/update/windows-lock";
import { reportPackageFailure } from "@/update/windows-report";
import { wingetPackageArgs } from "@/update/winget";

export type { WindowsWingetPackage };
export { parseWindowsPackageList };

export interface WindowsSourceResolution {
  root: string;
  /** When set, winget paths come from the contract — never from template substitution. */
  byor: SelectedWindowsByorProfiles;
}

async function windowsSourceRoot(
  config: ManagerConfig,
  profiles: ReadonlyArray<string> | undefined,
  localOverride: string | undefined,
): Promise<string> {
  const localRoot =
    localOverride ?? (config.source?.kind === "local" ? config.source.path : undefined);
  if (localRoot !== undefined) {
    return localRoot;
  }
  if (config.source?.kind === "remote") {
    const source = await syncByorSparseSource({
      config,
      platform: "windows",
      profile: profiles?.join(","),
      offline: true,
    });
    return source.root;
  }
  throw new Error(`Windows source is not configured in ${config.configPath}.`);
}

/** Resolve the selected Windows BYOR profile from the published/local source. */
export async function resolveWindowsSource(
  config: ManagerConfig,
  profiles?: ReadonlyArray<string>,
  repoOverride?: string,
): Promise<WindowsSourceResolution> {
  const localOverride = repoOverride ?? envValue("OUTFITTING_REPO");
  if (config.declarations === undefined) {
    throw new Error(`No profile declarations are configured in ${config.configPath}.`);
  }
  const selectedProfiles = configuredProfile(config, "windows", profiles?.join(","))?.split(",");
  const repo = await windowsSourceRoot(config, selectedProfiles, localOverride);
  const validated = await validateWindowsByorSource({
    root: repo,
    profiles: selectedProfiles,
    contract: config.declarations,
  });
  return {
    root: validated.root,
    byor: {
      names: validated.names,
      wingetPaths: validated.wingetPaths,
      shared: validated.shared,
    },
  };
}

export function windowsWingetProfilePath(profile: string, source: WindowsSourceResolution): string {
  const path = source.byor.wingetPaths[profile];
  if (path === undefined) {
    throw new Error(
      `Unknown BYOR Windows profile \`${profile}\`. Choose: ${source.byor.names.join(", ")}.`,
    );
  }
  return path;
}

export function windowsScoopPath(source: WindowsSourceResolution): string | undefined {
  return source.byor.shared?.scoop?.manifest;
}

export interface WindowsApplyOptions<ConfirmR = never> {
  config?: ManagerConfig;
  /** Invocation-local checkout override. */
  repo?: string;
  profiles?: ReadonlyArray<string>;
  wingetOnly?: boolean;
  strict?: boolean;
  prune?: boolean;
  yes?: boolean;
  run?: typeof runCommand;
  which?: typeof which;
  confirm?: Effect.Effect<boolean, never, ConfirmR>;
}

interface OwnedWingetPackage extends WindowsWingetPackage {
  owners: string[];
}

type ApplyRemoval =
  | { manager: "winget"; record: WindowsPackageRecord }
  | { manager: "scoop"; record: WindowsPackageRecord; scoopPath: string };

interface ApplyPlan {
  wingetInstalls: OwnedWingetPackage[];
  scoopBuckets: ScoopBucket[];
  scoopInstalls: string[];
  scoopRepairs: ScoopRepair[];
  scoopWarnings: string[];
  removals: ApplyRemoval[];
}

interface ScoopRepair {
  packageSpec: string;
  scope: "local" | "global";
  missingTargets: ScoopBinTarget[];
}

function planSize(plan: ApplyPlan): number {
  return (
    plan.wingetInstalls.length +
    plan.scoopBuckets.length +
    plan.scoopInstalls.length +
    plan.scoopRepairs.length +
    plan.removals.length
  );
}

async function readDeclaration(
  source: WindowsSourceResolution,
  path: string,
): Promise<{ text: string; path: string }> {
  const absolutePath = join(source.root, path);
  return { text: await readFile(absolutePath, "utf8"), path: absolutePath };
}

const loadDeclarations = Effect.fn("loadWindowsDeclarations")(function* (
  profiles: ReadonlyArray<string>,
  source: WindowsSourceResolution,
  wingetOnly: boolean,
) {
  const byIdentity = new Map<string, OwnedWingetPackage>();
  for (const profile of profiles) {
    const manifest = yield* tryPromise(() =>
      readDeclaration(source, windowsWingetProfilePath(profile, source)),
    );
    const entries = yield* Effect.try({
      try: () => parseWindowsPackageList(manifest.text, manifest.path),
      catch: toError,
    });
    for (const entry of entries) {
      const identity = wingetIdentity(entry.name, entry.source);
      const existing = byIdentity.get(identity);
      if (existing === undefined) {
        byIdentity.set(identity, { ...entry, owners: [profile] });
      } else {
        existing.owners.push(profile);
      }
    }
  }

  const winget = [...byIdentity.values()];
  const scoopPath = wingetOnly ? undefined : windowsScoopPath(source);
  if (scoopPath === undefined) {
    return { winget, scoop: undefined };
  }
  const scoopManifest = yield* tryPromise(() => readDeclaration(source, scoopPath));
  const scoop = yield* Effect.try({
    try: () => parseScoopManifest(scoopManifest.text),
    catch: toError,
  });
  return { winget, scoop };
});

async function wingetInstalled(
  run: typeof runCommand,
  executable: string,
  packageInfo: WindowsWingetPackage,
): Promise<boolean> {
  const result = await run(
    executable,
    [
      "list",
      "--id",
      packageInfo.name,
      "--exact",
      "--source",
      packageInfo.source ?? "winget",
      "--accept-source-agreements",
    ],
    { inherit: false },
  );
  if (result.code === 0) {
    return true;
  }
  if (isWingetPackageAbsentExitCode(result.code)) {
    return false;
  }
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(
    `winget list ${packageInfo.name} failed (exit ${result.code})${detail ? `: ${detail}` : "."}`,
  );
}

function provenPruneCandidates(
  current: WindowsLock,
  profiles: ReadonlyArray<string>,
  winget: ReadonlyArray<WindowsWingetPackage>,
  scoop: ApplyScoop | undefined,
): ApplyRemoval[] {
  const active = new Set(profiles);
  const desiredWinget = new Set(winget.map((entry) => wingetIdentity(entry.name, entry.source)));
  const desiredScoop = new Set(
    (scoop?.manifest.packages ?? []).map((entry) => scoopPackageName(entry).toLowerCase()),
  );
  const removable = (record: WindowsPackageRecord) =>
    record.origin === "baseline" &&
    record.installedBy === "outfitting" &&
    record.owners !== undefined &&
    record.owners.length > 0 &&
    record.owners.every((owner) => active.has(owner));
  return [
    ...current.packages.winget
      .filter(
        (record) =>
          removable(record) &&
          !desiredWinget.has(wingetIdentity(record.name, wingetSource(record.args))),
      )
      .map((record) => ({ manager: "winget" as const, record })),
    ...(scoop === undefined
      ? []
      : current.packages.scoop
          .filter((record) => removable(record) && !desiredScoop.has(record.name.toLowerCase()))
          .map((record) => ({ manager: "scoop" as const, record, scoopPath: scoop.path }))),
  ];
}

const printPlan = Effect.fn("printWindowsApplyPlan")(function* (plan: ApplyPlan) {
  yield* Console.log(ui.heading("Windows apply plan:"));
  for (const warning of plan.scoopWarnings) {
    yield* Console.log(ui.muted(`  could not verify Scoop package: ${warning}`));
  }
  if (planSize(plan) === 0) {
    yield* Console.log(ui.muted("  No package changes."));
    return;
  }
  for (const entry of plan.wingetInstalls) {
    yield* Console.log(`  install WinGet: ${entry.source ?? "winget"}:${entry.name}`);
  }
  for (const bucket of plan.scoopBuckets) {
    yield* Console.log(`  add Scoop bucket: ${bucket.name}`);
  }
  for (const entry of plan.scoopInstalls) {
    yield* Console.log(`  install Scoop: ${entry}`);
  }
  for (const repair of plan.scoopRepairs) {
    yield* Console.log(
      `  repair Scoop (${repair.scope}): ${scoopPackageName(repair.packageSpec)} (missing ${repair.missingTargets.map(({ path }) => path).join(", ")})`,
    );
  }
  for (const entry of plan.removals) {
    yield* Console.log(`  remove ${entry.manager}: ${entry.record.name}`);
  }
  if (plan.removals.length > 0) {
    yield* Console.log(
      ui.warning(
        "Removal ownership comes from the local lockfile. An external uninstall and reinstall cannot be detected; review these removals before continuing.",
      ),
    );
  }
});

const confirmPlan = Effect.fn("confirmWindowsApplyPlan")(function* <R>(
  plan: ApplyPlan,
  yes: boolean,
  confirmation: Effect.Effect<boolean, never, R> | undefined,
) {
  yield* printPlan(plan);
  if (planSize(plan) === 0 || yes) {
    return true;
  }
  if (confirmation === undefined) {
    return yield* new CliFailure({
      message: "Confirmation is required to apply package changes; rerun with --yes.",
    });
  }
  const confirmed = yield* confirmation;
  if (!confirmed) {
    (yield* TerminalSession).cancel();
    yield* Console.log(ui.muted("Aborted. No package changes were made."));
  }
  return confirmed;
});

function scoopInstalledScopes(
  apps: ReadonlyArray<ScoopExportApp>,
): Map<string, "local" | "global"> {
  const scopes = new Map<string, "local" | "global">();
  for (const app of apps) {
    const name = app.Name.toLowerCase();
    const scope = app.Info.toLowerCase().includes("global install") ? "global" : "local";
    if (!scopes.has(name) || scope === "local") {
      scopes.set(name, scope);
    }
  }
  return scopes;
}

type ScoopBinaryHealth =
  | { kind: "healthy" | "no-binaries" }
  | { kind: "missing"; targets: ScoopBinTarget[] }
  | { kind: "unknown"; reason: string };

const ScoopBinEntrySchema = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const ScoopBinSchema = Schema.Union([Schema.String, Schema.Array(ScoopBinEntrySchema)]);
const ScoopInstalledManifestSchema = Schema.Struct({
  bin: Schema.optionalKey(ScoopBinSchema),
  architecture: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Struct({ bin: Schema.optionalKey(ScoopBinSchema) })),
  ),
});
const ScoopInstallMetadataSchema = Schema.Struct({
  architecture: Schema.optionalKey(Schema.String),
});
const decodeScoopInstalledManifest = Schema.decodeUnknownOption(ScoopInstalledManifestSchema);
const decodeScoopInstallMetadata = Schema.decodeUnknownOption(ScoopInstallMetadataSchema);

interface ScoopBinTarget {
  path: string;
  command: string;
}

type ScoopBin = Schema.Schema.Type<typeof ScoopBinSchema>;

function makeScoopBinTarget(path: string, command?: string): ScoopBinTarget {
  const filename = path.split(/[\\/]/).at(-1) ?? path;
  return {
    path,
    command: command || filename.replace(/\.[^.]+$/, ""),
  };
}

function scoopBinTargets(bin: ScoopBin): ScoopBinTarget[] | undefined {
  if (Predicate.isString(bin)) {
    return [makeScoopBinTarget(bin)];
  }
  const targets: ScoopBinTarget[] = [];
  for (const entry of bin) {
    if (Predicate.isString(entry)) {
      targets.push(makeScoopBinTarget(entry));
      continue;
    }
    const path = entry.at(0);
    if (path === undefined) {
      return undefined;
    }
    const command = entry.at(1);
    targets.push(makeScoopBinTarget(path, command));
  }
  return targets;
}

function isMissingPathError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    ["ENOENT", "ENOTDIR"].includes(String((cause as NodeJS.ErrnoException).code))
  );
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return false;
    }
    throw cause;
  }
}

type ScoopBinInspection =
  | { kind: "no-binaries" }
  | { kind: "unknown"; reason: string }
  | { kind: "targets"; targets: ScoopBinTarget[] };

async function readScoopBinTargets(prefix: string): Promise<ScoopBinInspection> {
  try {
    const [manifestText, installText] = await Promise.all([
      readFile(join(prefix, "manifest.json"), "utf8"),
      readFile(join(prefix, "install.json"), "utf8"),
    ]);
    const manifest = decodeScoopInstalledManifest(JSON.parse(manifestText) as unknown);
    const install = decodeScoopInstallMetadata(JSON.parse(installText) as unknown);
    if (Option.isNone(manifest) || Option.isNone(install)) {
      return { kind: "unknown", reason: "installed Scoop metadata has an unsupported shape" };
    }

    const architecture = install.value.architecture;
    const bin =
      (architecture === undefined ? undefined : manifest.value.architecture?.[architecture]?.bin) ??
      manifest.value.bin;
    if (bin === undefined) {
      return { kind: "no-binaries" };
    }
    const targets = scoopBinTargets(bin);
    if (targets === undefined) {
      return { kind: "unknown", reason: "installed Scoop manifest has an empty bin target" };
    }
    return targets.length === 0 ? { kind: "no-binaries" } : { kind: "targets", targets };
  } catch (cause) {
    return { kind: "unknown", reason: errorMessage(cause) };
  }
}

const isPeExecutable = (path: string) => [".exe", ".com"].includes(extname(path).toLowerCase());

type ScoopShimTarget = { kind: "missing" } | { kind: "invalid" } | { kind: "target"; path: string };

/** Read the absolute target recorded beside a Scoop shim executable. */
async function readScoopShimTarget(shimExecutable: string): Promise<ScoopShimTarget> {
  if (!isPeExecutable(shimExecutable)) {
    return { kind: "invalid" };
  }
  if (!(await isFile(shimExecutable))) {
    return { kind: "missing" };
  }
  const shimPath = shimExecutable.replace(/\.[^.\\/]+$/, ".shim");
  try {
    const shim = await readFile(shimPath, "utf8");
    const path = /^path\s*=\s*"([^"\r\n]+)"\s*$/im.exec(shim)?.[1];
    return path === undefined || !isAbsolute(path) ? { kind: "invalid" } : { kind: "target", path };
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return { kind: "missing" };
    }
    throw cause;
  }
}

/** `undefined` means the shim could not be attributed to this installed target. */
async function scoopBinTargetExists(
  target: ScoopBinTarget,
  prefix: string,
  whichFn: typeof which,
  requireCommandResolution: boolean,
): Promise<boolean | undefined> {
  if (!isPeExecutable(target.path)) {
    return undefined;
  }
  const resolvedPrefix = await realpath(prefix);
  // `resolve` keeps absolute targets as-is; relative ones may resolve through the prefix symlink.
  const targetPath = resolve(resolvedPrefix, target.path);
  const acceptedTargets = [targetPath, resolve(prefix, target.path)];
  const commandPath = requireCommandResolution ? await whichFn(target.command) : undefined;
  const shimDirectory = resolve(resolvedPrefix, "..", "..", "..", "shims");
  if (
    commandPath !== undefined &&
    dirname(resolve(commandPath)).toLowerCase() !== shimDirectory.toLowerCase()
  ) {
    return undefined;
  }
  const shim = await readScoopShimTarget(
    commandPath ?? join(shimDirectory, `${target.command}.exe`),
  );
  if (shim.kind !== "target") {
    return shim.kind === "missing" ? false : undefined;
  }
  const shimTarget = resolve(shim.path).toLowerCase();
  if (!acceptedTargets.some((path) => path.toLowerCase() === shimTarget)) {
    return undefined;
  }
  if (!(await isFile(targetPath))) {
    return false;
  }
  return commandPath === undefined && requireCommandResolution ? undefined : true;
}

async function inspectScoopBinTargets(
  prefix: string,
  targets: ReadonlyArray<ScoopBinTarget>,
  whichFn: typeof which,
  requireCommandResolution = true,
): Promise<ScoopBinaryHealth> {
  const missing: ScoopBinTarget[] = [];
  let unknownReason: string | undefined;
  for (const target of targets) {
    let exists: boolean | undefined;
    try {
      exists = await scoopBinTargetExists(target, prefix, whichFn, requireCommandResolution);
    } catch (cause) {
      unknownReason ??= errorMessage(cause);
      continue;
    }
    if (exists === undefined) {
      unknownReason ??= `could not resolve installed Scoop command ${target.command}`;
      continue;
    }
    if (!exists) {
      missing.push(target);
    }
  }
  if (missing.length > 0) {
    return { kind: "missing", targets: missing };
  }
  return unknownReason === undefined
    ? { kind: "healthy" }
    : { kind: "unknown", reason: unknownReason };
}

async function inspectScoopPackageBins(
  run: typeof runCommand,
  scoopPath: string,
  name: string,
  options: {
    which: typeof which;
    targetsToVerify?: ReadonlyArray<ScoopBinTarget>;
    requireCommandResolution?: boolean;
  },
): Promise<ScoopBinaryHealth> {
  const { which: whichFn, targetsToVerify, requireCommandResolution = true } = options;
  try {
    const prefixResult = await runScoopCommand(run, scoopPath, ["prefix", name], {
      inherit: false,
    });
    if (prefixResult.code !== 0) {
      return { kind: "unknown", reason: `scoop prefix failed (exit ${prefixResult.code})` };
    }
    const prefix = prefixResult.stdout.trim().replace(/^"(.*)"$/s, "$1");
    if (prefix.length === 0) {
      return { kind: "unknown", reason: "scoop prefix returned an empty path" };
    }
    const inspection = await readScoopBinTargets(prefix);
    if (inspection.kind !== "targets") {
      return inspection;
    }
    const targets = targetsToVerify ?? inspection.targets;
    if (
      targetsToVerify !== undefined &&
      targetsToVerify.some(
        (target) =>
          !inspection.targets.some(
            (installed) =>
              installed.path.toLowerCase() === target.path.toLowerCase() &&
              installed.command.toLowerCase() === target.command.toLowerCase(),
          ),
      )
    ) {
      return {
        kind: "unknown",
        reason: "repaired Scoop manifest no longer declares the missing target",
      };
    }
    return inspectScoopBinTargets(prefix, targets, whichFn, requireCommandResolution);
  } catch (cause) {
    return { kind: "unknown", reason: errorMessage(cause) };
  }
}

/** Successful installs during apply are baseline packages proven to be installed by Outfitting. */
function recordApplyOperation(input: WindowsLockOperationInput) {
  const claimed = input.action === "install" && input.status === "success";
  return recordWindowsOperation(
    claimed ? { ...input, origin: "baseline", installedBy: "outfitting" } : input,
  );
}

function reconcileOwners(
  lock: WindowsLock,
  { profiles, winget, scoop, prune }: ApplyContext,
): void {
  const active = new Set(profiles);
  const wingetOwners = new Map(
    winget.map((entry) => [wingetIdentity(entry.name, entry.source), entry.owners]),
  );
  const scoopOwners = new Map(
    (scoop === undefined ? [] : scoop.manifest.packages).map((entry) => [
      scoopPackageName(entry).toLowerCase(),
      [...profiles],
    ]),
  );
  for (const [manager, desired] of [
    ["winget", wingetOwners],
    ["scoop", scoopOwners],
  ] as const) {
    if (manager === "scoop" && scoop === undefined) {
      continue;
    }
    for (const record of lock.packages[manager]) {
      if (record.installedBy !== "outfitting" || record.owners === undefined) {
        continue;
      }
      const identity =
        manager === "winget"
          ? wingetIdentity(record.name, wingetSource(record.args))
          : record.name.toLowerCase();
      const activeOwners = desired.get(identity);
      if (activeOwners === undefined) {
        const remaining = record.owners.filter((owner) => !active.has(owner));
        if (prune && remaining.length > 0) {
          record.owners = remaining;
        }
        continue;
      }
      record.owners = [
        ...new Set([...record.owners.filter((owner) => !active.has(owner)), ...activeOwners]),
      ].toSorted();
    }
  }
}

/** Scoop declarations together with the executable that applies them. */
interface ApplyScoop {
  path: string;
  manifest: ScoopManifest;
}

interface ApplyContext {
  config: ManagerConfig;
  profiles: string[];
  winget: OwnedWingetPackage[];
  scoop: ApplyScoop | undefined;
  run: typeof runCommand;
  which: typeof which;
  wingetPath: string;
  plan: ApplyPlan;
  prune: boolean;
  strict: boolean;
}

function differentBucketSource(
  state: ScoopExportState,
  buckets: ReadonlyArray<ScoopBucket>,
): string | undefined {
  for (const bucket of buckets) {
    const existing = state.buckets.find(
      (entry) => entry.Name.toLowerCase() === bucket.name.toLowerCase(),
    );
    if (
      existing !== undefined &&
      normalizeBucketUrl(existing.Source) !== normalizeBucketUrl(bucket.url)
    ) {
      return `Scoop bucket ${bucket.name} is configured from ${existing.Source || "an unknown source"}, not ${bucket.url}. Refusing to install from a different source.`;
    }
  }
  return undefined;
}

/** Plan missing buckets, missing packages and binary repairs for the declared Scoop state. */
const inspectScoop = Effect.fn("inspectWindowsScoop")(function* (
  run: typeof runCommand,
  path: string,
  whichFn: typeof which,
  manifest: ScoopManifest,
) {
  const state = yield* tryPromise(() => scoopExport(run, path));
  const conflict = differentBucketSource(state, manifest.buckets);
  if (conflict !== undefined) {
    return yield* new CliFailure({ message: conflict });
  }
  const scopes = scoopInstalledScopes(state.apps);
  const installedBuckets = new Set(state.buckets.map((bucket) => bucket.Name.toLowerCase()));
  const repairs: ScoopRepair[] = [];
  const warnings: string[] = [];
  for (const packageSpec of manifest.packages) {
    const name = scoopPackageName(packageSpec);
    const scope = scopes.get(name.toLowerCase());
    if (scope === undefined) {
      continue;
    }
    const health = yield* tryPromise(() =>
      inspectScoopPackageBins(run, path, name, { which: whichFn }),
    );
    if (health.kind === "missing") {
      repairs.push({ packageSpec, scope, missingTargets: health.targets });
    } else if (health.kind === "unknown") {
      warnings.push(`${name}: ${health.reason}; leaving it unchanged.`);
    }
  }
  return {
    scoopBuckets: manifest.buckets.filter(
      (bucket) => !installedBuckets.has(bucket.name.toLowerCase()),
    ),
    scoopInstalls: manifest.packages.filter(
      (entry) => !scopes.has(scoopPackageName(entry).toLowerCase()),
    ),
    scoopRepairs: repairs,
    scoopWarnings: warnings,
  };
});

const NO_SCOOP_PLAN = { scoopBuckets: [], scoopInstalls: [], scoopRepairs: [], scoopWarnings: [] };

const resolveScoop = Effect.fn("resolveWindowsScoop")(function* (
  whichFn: typeof which,
  manifest: ScoopManifest | undefined,
) {
  if (manifest === undefined) {
    return undefined;
  }
  const path = yield* tryPromise(() => whichFn("scoop"));
  if (path === undefined) {
    return yield* new CliFailure({ message: "scoop is not installed or not in PATH." });
  }
  return { path, manifest };
});

function prepareApply<ConfirmR>(options: WindowsApplyOptions<ConfirmR>) {
  return Effect.gen(function* () {
    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    const current = yield* tryPromise(() => readWindowsLock(config));
    const source = yield* tryPromise(() =>
      resolveWindowsSource(config, options.profiles, options.repo),
    );
    const profiles = source.byor.names;
    const declarations = yield* loadDeclarations(profiles, source, options.wingetOnly === true);
    const run = options.run ?? runCommand;
    const whichFn = options.which ?? which;
    const wingetPath = yield* tryPromise(() => whichFn("winget"));
    if (wingetPath === undefined) {
      return yield* new CliFailure({ message: "winget is not installed or not in PATH." });
    }

    const wingetInstalls: OwnedWingetPackage[] = [];
    for (const entry of declarations.winget) {
      if (!(yield* tryPromise(() => wingetInstalled(run, wingetPath, entry)))) {
        wingetInstalls.push(entry);
      }
    }

    const scoop = yield* resolveScoop(whichFn, declarations.scoop);
    const prune = options.prune === true;
    return {
      config,
      profiles,
      winget: declarations.winget,
      scoop,
      run,
      which: whichFn,
      wingetPath,
      prune,
      strict: options.strict === true,
      plan: {
        wingetInstalls,
        ...(scoop === undefined
          ? NO_SCOOP_PLAN
          : yield* inspectScoop(run, scoop.path, whichFn, scoop.manifest)),
        removals: prune ? provenPruneCandidates(current, profiles, declarations.winget, scoop) : [],
      },
    } satisfies ApplyContext;
  });
}

const logTo = (progress: ProgressRenderer) => (message: string) =>
  Effect.sync(() => progress.log(message));

const installWinget = Effect.fn("installWindowsWinget")(function* (
  context: ApplyContext,
  progress: ProgressRenderer,
  failures: string[],
) {
  for (const entry of context.plan.wingetInstalls) {
    yield* progress.track(
      `WinGet install: ${entry.name}`,
      Effect.gen(function* () {
        const args = [
          ...wingetPackageArgs("install", entry.name, entry.source ?? "winget"),
          "--no-upgrade",
        ];
        const result = yield* tryPromise(() =>
          context.run(context.wingetPath, args, { inherit: false }),
        );
        logCommandOutput(progress, result);
        if (isWingetAlreadyInstalledExitCode(result.code)) {
          progress.log(
            ui.muted(`WinGet package became preexisting: ${entry.name}; ownership not claimed.`),
          );
          return;
        }
        yield* tryPromise(() =>
          recordApplyOperation({
            config: context.config,
            manager: "winget",
            action: "install",
            name: entry.name,
            args,
            status: result.code === 0 ? "success" : "failed",
            exitCode: result.code,
            owners: entry.owners,
          }),
        );
        if (result.code !== 0) {
          yield* reportPackageFailure(
            `winget install ${entry.name} failed (exit ${result.code})`,
            context.strict,
            failures,
            logTo(progress),
          );
        }
      }),
    );
  }
});

function scoopRepairFailure(
  packageSpec: string,
  exitCode: number,
  health: ScoopBinaryHealth | undefined,
): string | undefined {
  if (exitCode !== 0) {
    return `scoop update ${packageSpec} --force failed (exit ${exitCode})`;
  }
  if (health?.kind === "healthy") {
    return undefined;
  }
  const missingTargets =
    health?.kind === "missing"
      ? ` (${health.targets.map(({ path }) => path).join(", ")} still missing)`
      : "";
  return `scoop update ${packageSpec} --force did not restore declared binaries${missingTargets}`;
}

const repairScoopPackage = Effect.fn("repairWindowsScoopPackage")(function* (
  context: ApplyContext,
  scoopPath: string,
  repair: ScoopRepair,
  progress: ProgressRenderer,
) {
  const name = scoopPackageName(repair.packageSpec);
  const args = ["update", name, "--force", ...(repair.scope === "global" ? ["--global"] : [])];
  const result = yield* tryPromise(() =>
    runScoopCommand(context.run, scoopPath, args, { inherit: false }),
  );
  logCommandOutput(progress, result);
  const health =
    result.code === 0
      ? yield* tryPromise(() =>
          inspectScoopPackageBins(context.run, scoopPath, name, {
            which: context.which,
            targetsToVerify: repair.missingTargets,
            requireCommandResolution: false,
          }),
        )
      : undefined;
  const failure = scoopRepairFailure(repair.packageSpec, result.code, health);
  yield* tryPromise(() =>
    recordApplyOperation({
      config: context.config,
      manager: "scoop",
      action: "upgrade",
      name,
      args,
      status: failure === undefined ? "success" : "failed",
      exitCode: failure === undefined ? 0 : result.code === 0 ? 1 : result.code,
    }),
  );
  return failure;
});

const installScoopPackage = Effect.fn("installWindowsScoopPackage")(function* (
  context: ApplyContext,
  scoopPath: string,
  spec: string,
  progress: ProgressRenderer,
) {
  const args = ["install", spec];
  const result = yield* tryPromise(() =>
    runScoopCommand(context.run, scoopPath, args, { inherit: false }),
  );
  logCommandOutput(progress, result);
  yield* tryPromise(() =>
    recordApplyOperation({
      config: context.config,
      manager: "scoop",
      action: "install",
      name: scoopPackageName(spec),
      args,
      status: result.code === 0 ? "success" : "failed",
      exitCode: result.code,
      owners: context.profiles,
    }),
  );
  return result.code === 0 ? undefined : `scoop install ${spec} failed (exit ${result.code})`;
});

const installScoop = Effect.fn("installWindowsScoop")(function* (
  context: ApplyContext,
  progress: ProgressRenderer,
  failures: string[],
) {
  if (context.scoop === undefined) {
    return;
  }
  const scoopPath = context.scoop.path;
  for (const bucket of context.plan.scoopBuckets) {
    const result = yield* progress.track(
      `Scoop bucket: ${bucket.name}`,
      tryPromise(() =>
        runScoopCommand(context.run, scoopPath, ["bucket", "add", bucket.name, bucket.url], {
          inherit: false,
        }),
      ),
    );
    logCommandOutput(progress, result);
    if (result.code !== 0) {
      return yield* new CliFailure({
        message: `scoop bucket add ${bucket.name} failed (exit ${result.code}).`,
      });
    }
  }
  const operations = [
    ...context.plan.scoopInstalls.map((spec) => ({
      label: `Scoop install: ${spec}`,
      run: installScoopPackage(context, scoopPath, spec, progress),
    })),
    ...context.plan.scoopRepairs.map((repair) => ({
      label: `Scoop repair: ${scoopPackageName(repair.packageSpec)}`,
      run: repairScoopPackage(context, scoopPath, repair, progress),
    })),
  ];
  for (const operation of operations) {
    const failure = yield* progress.track(operation.label, operation.run);
    if (failure !== undefined) {
      yield* reportPackageFailure(failure, context.strict, failures, logTo(progress));
    }
  }
});

const executeRemovals = Effect.fn("pruneWindowsPackages")(function* (
  context: ApplyContext,
  progress: ProgressRenderer,
) {
  for (const removal of context.plan.removals) {
    yield* progress.track(
      `Removing ${removal.record.name} with ${removal.manager}`,
      Effect.gen(function* () {
        const args =
          removal.manager === "winget"
            ? wingetPackageArgs("uninstall", removal.record.name, wingetSource(removal.record.args))
            : ["uninstall", removal.record.name];
        const result = yield* tryPromise(() =>
          removal.manager === "winget"
            ? context.run(context.wingetPath, args, { inherit: false })
            : runScoopCommand(context.run, removal.scoopPath, args, { inherit: false }),
        );
        logCommandOutput(progress, result);
        yield* tryPromise(() =>
          recordApplyOperation({
            config: context.config,
            manager: removal.manager,
            action: "uninstall",
            name: removal.record.name,
            args,
            status: result.code === 0 ? "success" : "failed",
            exitCode: result.code,
          }),
        );
        if (result.code !== 0) {
          return yield* new CliFailure({
            message: `${removal.manager} uninstall ${removal.record.name} failed (exit ${result.code}).`,
          });
        }
      }),
    );
  }
});

const persistApply = Effect.fn("persistWindowsApply")(function* (context: ApplyContext) {
  const updated = yield* tryPromise(() => readWindowsLock(context.config));
  // An observed absence invalidates old installation evidence, even if reinstall fails.
  const missingWinget = new Set(
    context.plan.wingetInstalls.map((entry) => wingetIdentity(entry.name, entry.source)),
  );
  const missingScoop = new Set(
    context.plan.scoopInstalls.map((entry) => scoopPackageName(entry).toLowerCase()),
  );
  updated.packages.winget = updated.packages.winget.filter(
    (entry) => !missingWinget.has(wingetIdentity(entry.name, wingetSource(entry.args))),
  );
  updated.packages.scoop = updated.packages.scoop.filter(
    (entry) => !missingScoop.has(entry.name.toLowerCase()),
  );
  reconcileOwners(updated, context);
  updated.machine = context.config.machineId;
  yield* tryPromise(() => writeWindowsLock(updated, { root: context.config.stateRoot }));
});

const persistAppliedProfiles = Effect.fn("persistWindowsAppliedProfiles")(function* (
  context: ApplyContext,
) {
  const updated = yield* tryPromise(() => readWindowsLock(context.config));
  updated.profiles = [...context.profiles];
  yield* tryPromise(() => writeWindowsLock(updated, { root: context.config.stateRoot }));
});

export const applyWindows = <ConfirmR = never>(options: WindowsApplyOptions<ConfirmR> = {}) =>
  Effect.gen(function* () {
    const context = yield* prepareApply(options);
    if (!(yield* confirmPlan(context.plan, options.yes === true, options.confirm))) {
      return;
    }
    const failures: string[] = [];
    yield* withProgress("Windows apply", planSize(context.plan), (progress) =>
      Effect.gen(function* () {
        yield* persistApply(context);
        yield* installWinget(context, progress, failures);
        yield* installScoop(context, progress, failures);
        if (failures.length > 0) {
          return yield* new CliFailure({
            message: `Windows apply was partial; failed package operations: ${failures.join("; ")}. Rerun apply after fixing them.${context.plan.removals.length > 0 ? " Requested pruning was skipped." : ""}`,
          });
        }
        yield* executeRemovals(context, progress);
        yield* persistAppliedProfiles(context);
      }),
    );
    yield* Console.log(ui.success("Windows declarations applied locally."));
  });

const profileFlag = Flag.String("profile").pipe(
  Flag.optional,
  Flag.withDescription("Comma-separated profiles from the configured repository."),
);

export const windowsApplyCommand = Command.make(
  "apply",
  {
    profile: profileFlag,
    repo: Flag.String("repo").pipe(
      Flag.optional,
      Flag.withDescription("Local source path override for this invocation."),
    ),
    wingetOnly: Flag.Boolean("winget-only").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Apply only WinGet declarations; skip Scoop even when installed."),
    ),
    prune: Flag.Boolean("prune").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Remove packages recorded as Outfitting-installed and no longer declared by active profiles.",
      ),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Apply the displayed plan without prompting."),
    ),
    strict: Flag.Boolean("strict").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Stop at the first package installation failure."),
    ),
  },
  ({ profile, repo, wingetOnly, prune, yes, strict }) =>
    applyWindows({
      repo: Option.getOrUndefined(repo),
      profiles: Option.isSome(profile) ? [profile.value] : undefined,
      wingetOnly,
      strict,
      prune,
      yes,
      confirm: process.stdin.isTTY
        ? withTerminalInput(
            Prompt.Confirm({ message: "Apply this plan?", initial: false }),
            "permission",
            "Apply this plan?",
          ).pipe(Effect.orDie)
        : undefined,
    }),
).pipe(
  Command.withDescription(
    "Install missing locally declared Windows packages; optionally prune recorded ownership.",
  ),
);
