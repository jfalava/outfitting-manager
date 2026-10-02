import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

import { Console, Effect, Option, Predicate, Schema } from "effect";
import { Command, Flag, Prompt } from "effect/cli";

import { configuredProfile, loadConfig, type ManagerConfig } from "@/config";
import { CliFailure } from "@/errors";
import { tryPromise } from "@/lockfiles/effect";
import { runCommand, which } from "@/process";
import { envValue } from "@/secrets";
import { syncByorSparseSource } from "@/setup/source";
import { validateWindowsByorSource, type SelectedWindowsByorProfiles } from "@/source/contract";
import { parseWindowsPackageList, type WindowsWingetPackage } from "@/source/windows-manifest";
import { ui } from "@/ui";
import { logCommandOutput, withProgress, type ProgressRenderer } from "@/ui/progress";
import { parseScoopManifest, type ScoopBucket, type ScoopManifest } from "@/update/scoop";
import { runScoopCommand } from "@/update/scoop-command";
import {
  isWingetAlreadyInstalledExitCode,
  isWingetPackageAbsentExitCode,
  readWindowsLock,
  recordWindowsOperation,
  wingetIdentity,
  wingetSource,
  writeWindowsLock,
  type WindowsLock,
  type WindowsPackageRecord,
} from "@/update/windows-lock";
import { parseScoopExport } from "@/update/windows-snapshot";
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

export function windowsPowerShellProfilePath(source: WindowsSourceResolution): string | undefined {
  return source.byor.shared?.powershell?.path;
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

interface ApplyRemoval {
  manager: "winget" | "scoop";
  record: WindowsPackageRecord;
}

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

function packageName(value: string): string {
  return value.split("/").at(-1) ?? value;
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
  options: WindowsApplyOptions<unknown>,
) {
  const byIdentity = new Map<string, OwnedWingetPackage>();
  for (const profile of profiles) {
    const manifest = yield* tryPromise(() =>
      readDeclaration(source, windowsWingetProfilePath(profile, source)),
    );
    const entries = yield* Effect.try({
      try: () => parseWindowsPackageList(manifest.text, manifest.path),
      catch: (cause) =>
        new CliFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
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

  if (options.wingetOnly) {
    return { winget: [...byIdentity.values()], scoop: undefined };
  }
  const scoopPath = windowsScoopPath(source);
  if (scoopPath === undefined) {
    return { winget: [...byIdentity.values()], scoop: undefined };
  }
  const scoopManifest = yield* tryPromise(() => readDeclaration(source, scoopPath));
  const scoop = yield* Effect.try({
    try: () => parseScoopManifest(scoopManifest.text),
    catch: (cause) =>
      new CliFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
  return { winget: [...byIdentity.values()], scoop };
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
  scoop: ScoopManifest | undefined,
): ApplyRemoval[] {
  const active = new Set(profiles);
  const desiredWinget = new Set(winget.map((entry) => wingetIdentity(entry.name, entry.source)));
  const desiredScoop = new Set(
    (scoop?.packages ?? []).map((entry) => packageName(entry).toLowerCase()),
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
          .map((record) => ({ manager: "scoop" as const, record }))),
  ];
}

const printPlan = Effect.fn("printWindowsApplyPlan")(function* (plan: ApplyPlan) {
  yield* Console.log(ui.heading("Windows apply plan:"));
  for (const warning of plan.scoopWarnings) {
    yield* Console.log(ui.muted(`  could not verify Scoop package: ${warning}`));
  }
  if (
    plan.wingetInstalls.length +
      plan.scoopBuckets.length +
      plan.scoopInstalls.length +
      plan.scoopRepairs.length +
      plan.removals.length ===
    0
  ) {
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
      `  repair Scoop (${repair.scope}): ${packageName(repair.packageSpec)} (missing ${repair.missingTargets.map(({ path }) => path).join(", ")})`,
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
  const hasChanges =
    plan.wingetInstalls.length +
      plan.scoopBuckets.length +
      plan.scoopInstalls.length +
      plan.scoopRepairs.length +
      plan.removals.length >
    0;
  if (!hasChanges || yes) {
    return true;
  }
  if (confirmation === undefined) {
    return yield* new CliFailure({ message: "Confirmation is required to apply package changes." });
  }
  const confirmed = yield* confirmation;
  if (!confirmed) {
    yield* Console.log(ui.muted("Aborted. No package changes were made."));
  }
  return confirmed;
});

function scoopInstalledScopes(
  apps: ReturnType<typeof parseScoopExport>["apps"],
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

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
    return { kind: "unknown", reason: errorText(cause) };
  }
}

async function scoopBinTargetExists(
  target: ScoopBinTarget,
  prefix: string,
  whichFn: typeof which,
  requireCommandResolution: boolean,
): Promise<boolean | undefined> {
  if (![".exe", ".com"].includes(extname(target.path).toLowerCase())) {
    return undefined;
  }
  const resolvedPrefix = await realpath(prefix);
  const targetPaths = isAbsolute(target.path)
    ? [resolve(target.path)]
    : [resolve(resolvedPrefix, target.path), resolve(prefix, target.path)];
  const targetPath = isAbsolute(target.path)
    ? resolve(target.path)
    : resolve(resolvedPrefix, target.path);
  const commandPath = requireCommandResolution ? await whichFn(target.command) : undefined;
  const shimDirectory = resolve(resolvedPrefix, "..", "..", "..", "shims");
  if (
    commandPath !== undefined &&
    dirname(resolve(commandPath)).toLowerCase() !== shimDirectory.toLowerCase()
  ) {
    return undefined;
  }
  return inspectScoopShim(target, {
    targetPaths,
    targetPath,
    shimDirectory,
    commandPath,
    requireCommandResolution,
  });
}

type ScoopShimMetadata =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "target"; path: string };

async function readScoopShimMetadata(shimPath: string): Promise<ScoopShimMetadata> {
  try {
    const shim = await readFile(shimPath, "utf8");
    const path = /^path\s*=\s*"([^"\r\n]+)"\s*$/im.exec(shim)?.[1];
    return path === undefined ? { kind: "invalid" } : { kind: "target", path };
  } catch (cause) {
    if (isMissingPathError(cause)) {
      return { kind: "missing" };
    }
    throw cause;
  }
}

async function inspectScoopShim(
  target: ScoopBinTarget,
  options: {
    targetPaths: ReadonlyArray<string>;
    targetPath: string;
    shimDirectory: string;
    commandPath: string | undefined;
    requireCommandResolution: boolean;
  },
): Promise<boolean | undefined> {
  const { targetPaths, targetPath, shimDirectory, commandPath, requireCommandResolution } = options;
  const shimExecutable = commandPath ?? join(shimDirectory, `${target.command}.exe`);
  const extension = extname(shimExecutable);
  if (![".exe", ".com"].includes(extension.toLowerCase())) {
    return undefined;
  }
  if (!(await isFile(shimExecutable))) {
    return false;
  }
  const shimPath = `${shimExecutable.slice(0, shimExecutable.length - extension.length)}.shim`;
  const metadata = await readScoopShimMetadata(shimPath);
  if (metadata.kind === "missing") {
    return false;
  }
  if (metadata.kind === "invalid") {
    return undefined;
  }
  if (!isAbsolute(metadata.path)) {
    return undefined;
  }
  if (!targetPaths.some((path) => resolve(metadata.path).toLowerCase() === path.toLowerCase())) {
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
      unknownReason ??= errorText(cause);
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
    return { kind: "unknown", reason: errorText(cause) };
  }
}

const recordApplyOperation = (input: {
  config: ManagerConfig;
  manager: "winget" | "scoop";
  action: "install" | "uninstall" | "upgrade";
  name: string;
  args: string[];
  status: "success" | "failed";
  exitCode: number;
  owners?: ReadonlyArray<string>;
}) => {
  const successfulInstall = input.action === "install" && input.status === "success";
  return recordWindowsOperation({
    ...input,
    origin: successfulInstall ? "baseline" : undefined,
    installedBy: successfulInstall ? "outfitting" : undefined,
    owners: successfulInstall ? input.owners : undefined,
  });
};

function reconcileOwners(
  lock: WindowsLock,
  { profiles, declarations: { winget, scoop }, prune }: ApplyContext,
): void {
  const active = new Set(profiles);
  const wingetOwners = new Map(
    winget.map((entry) => [wingetIdentity(entry.name, entry.source), entry.owners]),
  );
  const scoopOwners = new Map(
    (scoop === undefined ? [] : scoop.packages).map((entry) => [
      packageName(entry).toLowerCase(),
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

interface ApplyContext {
  config: ManagerConfig;
  profiles: string[];
  declarations: { winget: OwnedWingetPackage[]; scoop: ScoopManifest | undefined };
  run: typeof runCommand;
  which: typeof which;
  wingetPath: string;
  scoopPath: string | undefined;
  plan: ApplyPlan;
  prune: boolean;
  strict: boolean;
}

function normalizedBucketSource(value: string): string {
  return value
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

const inspectScoop = Effect.fn("inspectWindowsScoop")(function* (
  run: typeof runCommand,
  whichFn: typeof which,
  packages: ReadonlyArray<string>,
  buckets: ReadonlyArray<ScoopBucket>,
) {
  const path = yield* tryPromise(() => whichFn("scoop"));
  if (path === undefined) {
    return yield* new CliFailure({ message: "scoop is not installed or not in PATH." });
  }
  const exported = yield* tryPromise(() =>
    runScoopCommand(run, path, ["export"], { inherit: false }),
  );
  if (exported.code !== 0) {
    return yield* new CliFailure({ message: `scoop export failed (exit ${exported.code}).` });
  }
  const state = yield* Effect.try({
    try: () => parseScoopExport(exported.stdout),
    catch: (cause) =>
      new CliFailure({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
  for (const bucket of buckets) {
    const existing = state.buckets.find(
      (entry) => entry.Name.toLowerCase() === bucket.name.toLowerCase(),
    );
    if (
      existing !== undefined &&
      normalizedBucketSource(existing.Source) !== normalizedBucketSource(bucket.url)
    ) {
      return yield* new CliFailure({
        message: `Scoop bucket ${bucket.name} is configured from ${existing.Source || "an unknown source"}, not ${bucket.url}. Refusing to install from a different source.`,
      });
    }
  }
  const scopes = scoopInstalledScopes(state.apps);
  const installed = new Set(scopes.keys());
  const repairs: ScoopRepair[] = [];
  const warnings: string[] = [];
  for (const packageSpec of packages) {
    const name = packageName(packageSpec);
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
    path,
    installed,
    buckets: new Set(state.buckets.map((bucket) => bucket.Name.toLowerCase())),
    repairs,
    warnings,
  };
});

function buildApplyPlan(options: {
  current: WindowsLock;
  profiles: ReadonlyArray<string>;
  declarations: ApplyContext["declarations"];
  wingetInstalls: OwnedWingetPackage[];
  installedScoop: ReadonlySet<string>;
  scoopBuckets: ReadonlySet<string>;
  scoopRepairs: ScoopRepair[];
  scoopWarnings: string[];
  prune: boolean;
}): ApplyPlan {
  const {
    current,
    profiles,
    declarations,
    wingetInstalls,
    installedScoop,
    scoopBuckets,
    scoopRepairs,
    scoopWarnings,
    prune,
  } = options;
  const scoopInstalls = (declarations.scoop?.packages ?? []).filter(
    (entry) => !installedScoop.has(packageName(entry).toLowerCase()),
  );
  const missingBuckets = (declarations.scoop?.buckets ?? []).filter(
    (bucket) => !scoopBuckets.has(bucket.name.toLowerCase()),
  );
  const removals = prune
    ? provenPruneCandidates(current, profiles, declarations.winget, declarations.scoop)
    : [];
  return {
    wingetInstalls,
    scoopBuckets: missingBuckets,
    scoopInstalls,
    scoopRepairs,
    scoopWarnings,
    removals,
  };
}

function prepareApply<ConfirmR>(options: WindowsApplyOptions<ConfirmR>) {
  return Effect.gen(function* () {
    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    const current = yield* tryPromise(() => readWindowsLock(config));
    const source = yield* tryPromise(() =>
      resolveWindowsSource(config, options.profiles, options.repo),
    );
    const profiles = source.byor.names;
    const declarations = yield* loadDeclarations(profiles, source, options);
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

    let scoopPath: string | undefined;
    let installedScoop = new Set<string>();
    let scoopBuckets = new Set<string>();
    let scoopRepairs: ScoopRepair[] = [];
    let scoopWarnings: string[] = [];
    if (!options.wingetOnly && declarations.scoop !== undefined) {
      const scoop = yield* inspectScoop(
        run,
        whichFn,
        declarations.scoop.packages,
        declarations.scoop.buckets,
      );
      scoopPath = scoop.path;
      installedScoop = scoop.installed;
      scoopBuckets = scoop.buckets;
      scoopRepairs = scoop.repairs;
      scoopWarnings = scoop.warnings;
    }
    return {
      config,
      profiles,
      declarations,
      run,
      which: whichFn,
      wingetPath,
      scoopPath,
      prune: options.prune === true,
      strict: options.strict === true,
      plan: buildApplyPlan({
        current,
        profiles,
        declarations,
        wingetInstalls,
        installedScoop,
        scoopBuckets,
        scoopRepairs,
        scoopWarnings,
        prune: options.prune === true,
      }),
    } satisfies ApplyContext;
  });
}

const installWinget = Effect.fn("installWindowsWinget")(function* (
  context: ApplyContext,
  progress: ProgressRenderer,
) {
  const failures: string[] = [];
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
        const alreadyInstalled = isWingetAlreadyInstalledExitCode(result.code);
        if (alreadyInstalled) {
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
          const failure = `winget install ${entry.name} failed (exit ${result.code})`;
          if (context.strict) {
            return yield* new CliFailure({ message: `${failure}.` });
          }
          failures.push(failure);
          progress.log(ui.warning(`${failure}; continuing.`));
        }
      }),
    );
  }
  return failures;
});

function scoopRepairFailure(
  packageSpec: string,
  exitCode: number,
  health: ScoopBinaryHealth | undefined,
): string {
  if (exitCode !== 0) {
    return `scoop update ${packageSpec} --force failed (exit ${exitCode})`;
  }
  const missingTargets =
    health?.kind === "missing"
      ? ` (${health.targets.map(({ path }) => path).join(", ")} still missing)`
      : "";
  return `scoop update ${packageSpec} --force did not restore declared binaries${missingTargets}`;
}

const repairScoopPackage = Effect.fn("repairWindowsScoopPackage")(function* (
  context: ApplyContext,
  repair: ScoopRepair,
  progress: ProgressRenderer,
) {
  const name = packageName(repair.packageSpec);
  return yield* progress.track(
    `Scoop repair: ${name}`,
    Effect.gen(function* () {
      const args = ["update", name, "--force", ...(repair.scope === "global" ? ["--global"] : [])];
      const result = yield* tryPromise(() =>
        runScoopCommand(context.run, context.scoopPath!, args, { inherit: false }),
      );
      logCommandOutput(progress, result);
      const health =
        result.code === 0
          ? yield* tryPromise(() =>
              inspectScoopPackageBins(context.run, context.scoopPath!, name, {
                which: context.which,
                targetsToVerify: repair.missingTargets,
                requireCommandResolution: false,
              }),
            )
          : undefined;
      const restored = health?.kind === "healthy";
      const failure = restored
        ? undefined
        : scoopRepairFailure(repair.packageSpec, result.code, health);
      yield* tryPromise(() =>
        recordApplyOperation({
          config: context.config,
          manager: "scoop",
          action: "upgrade",
          name,
          args,
          status: restored ? "success" : "failed",
          exitCode: restored ? 0 : result.code === 0 ? 1 : result.code,
        }),
      );
      if (failure === undefined) {
        return undefined;
      }
      if (context.strict) {
        return yield* new CliFailure({ message: `${failure}.` });
      }
      progress.log(ui.warning(`${failure}; continuing.`));
      return failure;
    }),
  );
});

const repairScoop = Effect.fn("repairWindowsScoopPackages")(function* (
  context: ApplyContext,
  progress: ProgressRenderer,
) {
  const failures: string[] = [];
  for (const repair of context.plan.scoopRepairs) {
    const failure = yield* repairScoopPackage(context, repair, progress);
    if (failure !== undefined) {
      failures.push(failure);
    }
  }
  return failures;
});

const installScoop = Effect.fn("installWindowsScoop")(function* (
  context: ApplyContext,
  progress: ProgressRenderer,
) {
  if (context.scoopPath === undefined || context.declarations.scoop === undefined) {
    return [];
  }
  for (const bucket of context.plan.scoopBuckets) {
    const result = yield* progress.track(
      `Scoop bucket: ${bucket.name}`,
      tryPromise(() =>
        runScoopCommand(
          context.run,
          context.scoopPath!,
          ["bucket", "add", bucket.name, bucket.url],
          {
            inherit: false,
          },
        ),
      ),
    );
    logCommandOutput(progress, result);
    if (result.code !== 0) {
      return yield* new CliFailure({
        message: `scoop bucket add ${bucket.name} failed (exit ${result.code}).`,
      });
    }
  }
  const failures: string[] = [];
  for (const spec of context.plan.scoopInstalls) {
    yield* progress.track(
      `Scoop install: ${spec}`,
      Effect.gen(function* () {
        const args = ["install", spec];
        const result = yield* tryPromise(() =>
          runScoopCommand(context.run, context.scoopPath!, args, { inherit: false }),
        );
        logCommandOutput(progress, result);
        yield* tryPromise(() =>
          recordApplyOperation({
            config: context.config,
            manager: "scoop",
            action: "install",
            name: packageName(spec),
            args,
            status: result.code === 0 ? "success" : "failed",
            exitCode: result.code,
            owners: context.profiles,
          }),
        );
        if (result.code !== 0) {
          const failure = `scoop install ${spec} failed (exit ${result.code})`;
          if (context.strict) {
            return yield* new CliFailure({ message: `${failure}.` });
          }
          failures.push(failure);
          progress.log(ui.warning(`${failure}; continuing.`));
        }
      }),
    );
  }
  return failures.concat(yield* repairScoop(context, progress));
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
            : runScoopCommand(context.run, context.scoopPath!, args, { inherit: false }),
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
    context.plan.scoopInstalls.map((entry) => packageName(entry).toLowerCase()),
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
    const operationCount =
      context.plan.wingetInstalls.length +
      context.plan.scoopBuckets.length +
      context.plan.scoopInstalls.length +
      context.plan.scoopRepairs.length +
      context.plan.removals.length;
    const completed = yield* withProgress("Windows apply", operationCount, (progress) =>
      Effect.gen(function* () {
        yield* persistApply(context);
        const failures = [
          ...(yield* installWinget(context, progress)),
          ...(yield* installScoop(context, progress)),
        ];
        if (failures.length > 0) {
          progress.finish();
          yield* Console.log(
            ui.muted(
              `Windows apply was partial; failed package operations: ${failures.join("; ")}. Rerun apply after fixing them. Requested pruning was skipped.`,
            ),
          );
          return false;
        }
        yield* executeRemovals(context, progress);
        yield* persistAppliedProfiles(context);
        return true;
      }),
    );
    if (completed) {
      yield* Console.log(ui.success("Windows declarations applied locally."));
    } else {
      return yield* new CliFailure({
        message: "Windows apply was partial; one or more package operations failed.",
      });
    }
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
      confirm: Prompt.Confirm({ message: "Apply this plan?", initial: false }).pipe(Effect.orDie),
    }),
).pipe(
  Command.withDescription(
    "Install missing locally declared Windows packages; optionally prune recorded ownership.",
  ),
);
