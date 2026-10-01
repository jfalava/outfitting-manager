import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Console, Effect, Schema } from "effect";

import { configuredProfile, loadConfig, type ManagerConfig } from "@/config";
import { validateOutfittingRepo } from "@/config/repo";
import { CliFailure, toCliFailure } from "@/errors";
import type { ManifestFetcher } from "@/fetch/github";
import { tryPromise } from "@/lockfiles/effect";
import {
  detectLinuxPackageManager,
  type DetectLinuxPackageManagerOptions,
  type LinuxPackageManager,
} from "@/platform/linux";
import { runCommand, which, type RunCommandResult } from "@/process";
import { selectByorProfile, validateLinuxByorSource } from "@/source/contract";
import { parseLinuxPackageManifest } from "@/source/linux-manifest";
import { ui } from "@/ui";
import { withProgress, type ProgressRenderer } from "@/ui/progress";
import {
  isLinuxProfile,
  prepareLinuxSource,
  readLinuxManifest,
  type LinuxProfile,
  type LinuxSource,
} from "@/update/linux-source";

export { isLinuxProfile, type LinuxProfile } from "@/update/linux-source";

const LINUX_OWNERSHIP_FILE = "linux-package-ownership.json";

interface LinuxOwnershipState {
  version: 2;
  profiles: Record<string, Partial<Record<LinuxPackageManager, string[]>>>;
}

const ManagerOwnershipSchema = Schema.Struct({
  apt: Schema.optionalKey(Schema.Array(Schema.String)),
  pacman: Schema.optionalKey(Schema.Array(Schema.String)),
});

const LinuxOwnershipSchema = Schema.Struct({
  version: Schema.Literals([1, 2] as const),
  profiles: Schema.Record(Schema.String, ManagerOwnershipSchema),
});

const decodeLinuxOwnership = Schema.decodeUnknownPromise(LinuxOwnershipSchema);

export { parseLinuxPackageManifest } from "@/source/linux-manifest";

export type LinuxPackageAction = "update" | "upgrade" | "install" | "remove";

export interface LinuxPackageInventoryOptions {
  run?: typeof runCommand;
  which?: typeof which;
}

/** Drop a version pin but retain an explicit apt architecture. */
export function linuxPackageIdentity(packageSpec: string): string {
  return packageSpec.split("=", 1)[0]!.toLowerCase();
}

function linuxInventoryArgs(manager: LinuxPackageManager): string[] {
  return manager === "apt" ? ["-W", "-f=${Package}\\t${Architecture}\\t${Status}\\n"] : ["-Qq"];
}

export type LinuxPackageInventory =
  | { manager: "apt"; nativeArchitecture: string; installed: ReadonlySet<string> }
  | { manager: "pacman"; installed: ReadonlySet<string> };

function parseInstalledLinuxPackages(manager: LinuxPackageManager, output: string): Set<string> {
  const installed = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    if (manager === "apt") {
      const [name, architecture, status] = line.split("\t");
      if (name && architecture && status === "install ok installed") {
        installed.add(`${name.toLowerCase()}:${architecture.toLowerCase()}`);
      }
    } else if (line.trim()) {
      installed.add(linuxPackageIdentity(line.trim()));
    }
  }
  return installed;
}

async function nativeDpkgArchitecture(
  run: typeof runCommand,
  whichFn: typeof which,
): Promise<string> {
  const dpkg = await whichFn("dpkg");
  if (dpkg === undefined) {
    throw new Error("dpkg is not installed or not in PATH.");
  }
  const result = await run(dpkg, ["--print-architecture"], { inherit: false });
  const architecture = result.stdout.trim().toLowerCase();
  if (result.code !== 0 || !/^[a-z0-9][a-z0-9_-]*$/.test(architecture)) {
    throw new Error("Could not determine the native dpkg architecture.");
  }
  return architecture;
}

export async function listInstalledLinuxPackages(
  manager: LinuxPackageManager,
  options: LinuxPackageInventoryOptions = {},
): Promise<LinuxPackageInventory> {
  const run = options.run ?? runCommand;
  const whichFn = options.which ?? which;
  const nativeArchitecture =
    manager === "apt" ? await nativeDpkgArchitecture(run, whichFn) : undefined;
  const executableName = manager === "apt" ? "dpkg-query" : "pacman";
  const executable = await whichFn(executableName);
  if (executable === undefined) {
    throw new Error(`${executableName} is not installed or not in PATH.`);
  }
  const result = await run(executable, linuxInventoryArgs(manager), { inherit: false });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `${executableName} package inventory failed (exit ${result.code})${detail ? `: ${detail}` : "."}`,
    );
  }
  const installed = parseInstalledLinuxPackages(manager, result.stdout);
  return manager === "apt"
    ? { manager, nativeArchitecture: nativeArchitecture!, installed }
    : { manager, installed };
}

function installedIdentity(spec: string, inventory: LinuxPackageInventory): string | undefined {
  const identity = linuxPackageIdentity(spec);
  if (inventory.manager === "pacman") {
    return inventory.installed.has(identity) ? identity : undefined;
  }
  const [name, architecture = inventory.nativeArchitecture] = identity.split(":");
  const qualified = `${name}:${architecture}`;
  if (inventory.installed.has(qualified)) {
    return qualified;
  }
  const all = `${name}:all`;
  return architecture === inventory.nativeArchitecture && inventory.installed.has(all)
    ? all
    : undefined;
}

export function missingLinuxPackages(
  declared: ReadonlyArray<string>,
  inventory: LinuxPackageInventory,
): string[] {
  const seen = new Set<string>();
  return declared.filter((spec) => {
    const identity = linuxPackageIdentity(spec);
    const key =
      inventory.manager === "apt" && !identity.includes(":")
        ? `${identity}:${inventory.nativeArchitecture}`
        : identity;
    if (seen.has(key) || installedIdentity(spec, inventory) !== undefined) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function aptPackageManagerArgs(
  action: LinuxPackageAction,
  packages: ReadonlyArray<string>,
  offline = false,
): string[] {
  switch (action) {
    case "update":
      return ["update"];
    case "upgrade":
      return ["upgrade", "-y"];
    case "install":
      return ["install", ...(offline ? ["--no-download"] : []), "-y", ...packages];
    case "remove":
      return ["remove", "-y", ...packages];
  }
}

function pacmanPackageManagerArgs(
  action: LinuxPackageAction,
  packages: ReadonlyArray<string>,
): string[] {
  switch (action) {
    case "update":
    case "upgrade":
      return ["-Syu", "--noconfirm"];
    case "install":
      return ["-S", "--needed", "--noconfirm", ...packages];
    case "remove":
      return ["-R", "--noconfirm", ...packages];
  }
}

export function linuxPackageManagerArgs(
  manager: LinuxPackageManager,
  action: LinuxPackageAction,
  packages: ReadonlyArray<string> = [],
  offline = false,
): string[] {
  if ((action === "install" || action === "remove") && packages.length === 0) {
    throw new Error(`${manager} ${action} requires at least one package.`);
  }
  if (offline && manager === "pacman" && action === "install") {
    throw new Error(
      "Offline pacman installs are refused: no safe cache-only install is supported.",
    );
  }
  return manager === "apt"
    ? aptPackageManagerArgs(action, packages, offline)
    : pacmanPackageManagerArgs(action, packages);
}

interface LinuxCommandOptions {
  manager: LinuxPackageManager;
  executable: string;
  run: typeof runCommand;
  which: typeof which;
}

interface LinuxPackageCommandBehavior {
  offline?: boolean;
  allowFailure?: boolean;
  progress?: ProgressRenderer;
}

function relayLinuxPackageOutput(progress: ProgressRenderer, result: RunCommandResult): void {
  if (result.stdout.trim()) {
    progress.log(ui.info(result.stdout));
  }
  if (result.stderr.trim()) {
    progress.log(result.code === 0 ? ui.note(result.stderr) : ui.error(result.stderr));
  }
}

async function runLinuxPackageCommand(
  options: LinuxCommandOptions,
  action: LinuxPackageAction,
  packages: ReadonlyArray<string> = [],
  behavior: LinuxPackageCommandBehavior = {},
): Promise<RunCommandResult> {
  const args = linuxPackageManagerArgs(options.manager, action, packages, behavior.offline);
  const sudo = process.getuid?.() !== 0 ? await options.which("sudo") : undefined;
  const command = sudo ?? options.executable;
  const commandArgs = sudo === undefined ? args : [options.executable, ...args];
  const result = await options.run(command, commandArgs, {
    inherit: behavior.progress === undefined,
  });
  if (behavior.progress !== undefined) {
    relayLinuxPackageOutput(behavior.progress, result);
  }
  if (result.code !== 0 && !behavior.allowFailure) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `${options.manager} ${action} failed (exit ${result.code})${detail ? `: ${detail}` : "."}`,
    );
  }
  return result;
}

export interface LinuxUpdateOptions {
  config?: ManagerConfig;
  packageManager?: LinuxPackageManager;
  offline?: boolean;
  run?: typeof runCommand;
  which?: typeof which;
  osReleasePath?: string;
  readOsRelease?: DetectLinuxPackageManagerOptions["readOsRelease"];
}

export interface LinuxApplyOptions<ConfirmR = never> extends LinuxUpdateOptions {
  profile?: string;
  strict?: boolean;
  prune?: boolean;
  yes?: boolean;
  /** Skip when the selected profile declares no native package manifests. */
  ifConfigured?: boolean;
  /** Use the selected local source without fetching remote changes. */
  noRefresh?: boolean;
  /** Already validated source root to use for this apply, including --repo overrides. */
  sourceRoot?: string;
  sourceFetcher?: ManifestFetcher;
  confirm?: Effect.Effect<boolean, never, ConfirmR>;
}

function skipUnconfiguredLinuxApply<ConfirmR>(
  options: LinuxApplyOptions<ConfirmR>,
  config: ManagerConfig,
  profile: LinuxProfile,
): Effect.Effect<boolean> {
  const declaration = config.declarations?.profiles[profile]?.linux;
  if (
    options.ifConfigured !== true ||
    declaration === undefined ||
    declaration.apt !== undefined ||
    declaration.pacman !== undefined
  ) {
    return Effect.succeed(false);
  }
  return Console.log(
    ui.muted(`No apt or pacman manifest is declared for ${profile}; skipping.`),
  ).pipe(Effect.as(true));
}

function resolveProfile(value: string | undefined, config?: ManagerConfig): LinuxProfile {
  const profile =
    config === undefined
      ? value
      : (configuredProfile(config, "linux", value) ??
        (config.declarations === undefined
          ? undefined
          : selectByorProfile(config.declarations, undefined).name));
  if (profile === undefined) {
    throw new Error(
      "No Linux profile is selected. Set linux.profile in config.toml or pass --profile.",
    );
  }
  if (!isLinuxProfile(profile)) {
    throw new Error(
      `Invalid Linux profile \`${profile}\`. Use letters, numbers, ., _, and - only.`,
    );
  }
  return profile;
}

async function resolveLinuxApplySource<ConfirmR>(
  options: LinuxApplyOptions<ConfirmR>,
  config: ManagerConfig,
  profile: LinuxProfile,
): Promise<LinuxSource | undefined> {
  if (options.sourceRoot !== undefined) {
    if (config.declarations === undefined) {
      throw new Error(`No profile declarations are configured in ${config.configPath}.`);
    }
    const repo = await validateOutfittingRepo(options.sourceRoot, {
      profile,
      contract: config.declarations,
    });
    await validateLinuxByorSource({ root: repo.root, profile, contract: config.declarations });
    return { root: repo.root, mode: "checkout", repo };
  }
  if (options.noRefresh === true) {
    return undefined;
  }
  return prepareLinuxSource({
    config,
    profile,
    refresh: true,
    offline: options.offline,
    fetcher: options.sourceFetcher,
    run: options.run,
  });
}

async function detectManager(options: LinuxUpdateOptions, config: ManagerConfig) {
  const whichFn = options.which ?? which;
  const manager = await detectLinuxPackageManager({
    requested: options.packageManager,
    osReleasePath: options.osReleasePath,
    readOsRelease: options.readOsRelease,
    which: whichFn,
  });
  const executable = await whichFn(manager);
  if (executable === undefined) {
    throw new Error(`Linux package manager \`${manager}\` is not installed or not in PATH.`);
  }
  return { manager, executable, run: options.run ?? runCommand, which: whichFn, config };
}

function emptyOwnership(): LinuxOwnershipState {
  return { version: 2, profiles: {} };
}

function validatedOwnershipProfile(
  profile: Readonly<Partial<Record<LinuxPackageManager, ReadonlyArray<string>>>>,
  version: 1 | 2,
) {
  for (const [manager, names] of Object.entries(profile)) {
    const identity =
      manager === "apt" && version === 2
        ? /^[a-z0-9][a-z0-9+._-]*:[a-z0-9][a-z0-9_-]*$/
        : /^[a-z0-9][a-z0-9+._-]*$/;
    if (names.some((name) => !identity.test(name))) {
      throw new Error("Invalid owned package identity.");
    }
  }
  return {
    apt: profile.apt === undefined ? undefined : version === 1 ? [] : [...profile.apt],
    pacman: profile.pacman === undefined ? undefined : [...profile.pacman],
  };
}

async function readOwnership(
  config: ManagerConfig,
): Promise<{ state: LinuxOwnershipState; migrated: boolean }> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(config.stateRoot, LINUX_OWNERSHIP_FILE), "utf8"),
    );
    const decoded = await decodeLinuxOwnership(parsed);
    const state = emptyOwnership();
    for (const [profile, decodedProfile] of Object.entries(decoded.profiles)) {
      state.profiles[profile] = validatedOwnershipProfile(decodedProfile, decoded.version);
    }
    const migrated =
      decoded.version === 1 &&
      Object.values(decoded.profiles).some((profile) => (profile.apt?.length ?? 0) > 0);
    return { state, migrated };
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { state: emptyOwnership(), migrated: false };
    }
    throw new Error(`Invalid ${LINUX_OWNERSHIP_FILE}; refusing to guess package ownership.`, {
      cause,
    });
  }
}

async function writeOwnership(config: ManagerConfig, state: LinuxOwnershipState): Promise<void> {
  const path = join(config.stateRoot, LINUX_OWNERSHIP_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function owned(
  state: LinuxOwnershipState,
  profile: LinuxProfile,
  manager: LinuxPackageManager,
): string[] {
  return state.profiles[profile]?.[manager] ?? [];
}

function setOwned(
  state: LinuxOwnershipState,
  profile: LinuxProfile,
  manager: LinuxPackageManager,
  packages: ReadonlyArray<string>,
): void {
  const profileState = state.profiles[profile] ?? {};
  profileState[manager] = [...new Set(packages)].toSorted();
  state.profiles[profile] = profileState;
}

function otherOwners(
  state: LinuxOwnershipState,
  active: LinuxProfile,
  manager: LinuxPackageManager,
  name: string,
): LinuxProfile[] {
  return Object.keys(state.profiles).filter(
    (profile) => profile !== active && owned(state, profile, manager).includes(name),
  );
}

async function simulateRemoval(
  command: LinuxCommandOptions,
  packages: ReadonlyArray<string>,
  inventory: LinuxPackageInventory,
): Promise<string[]> {
  const args =
    command.manager === "apt"
      ? ["-s", "remove", ...packages]
      : ["-Rp", "--print-format", "%n", ...packages];
  const result = await command.run(command.executable, args, {
    inherit: false,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.code !== 0) {
    throw new Error(
      `${command.manager} removal simulation failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  if (command.manager === "apt") {
    return [...result.stdout.matchAll(/^Remv\s+(\S+)/gm)].map((match) => {
      const name = linuxPackageIdentity(match[1]!);
      if (name.includes(":")) {
        return name;
      }
      const candidates = [...inventory.installed].filter((installed) =>
        installed.startsWith(`${name}:`),
      );
      return candidates.length === 1 ? candidates[0]! : name;
    });
  }
  return result.stdout.split(/\s+/).filter(Boolean).map(linuxPackageIdentity);
}

interface LinuxApplyContext {
  config: ManagerConfig;
  profile: LinuxProfile;
  command: LinuxCommandOptions;
  ownership: LinuxOwnershipState;
  offline: boolean;
  strict: boolean;
}

function installMissingPackages(
  context: LinuxApplyContext,
  missing: ReadonlyArray<string>,
  progress: ProgressRenderer,
) {
  return Effect.gen(function* () {
    const { command, config, ownership, profile, offline, strict } = context;
    const failures: string[] = [];
    if (missing.length > 0 && command.manager === "apt" && !offline) {
      yield* progress.track(
        "Refreshing apt package lists",
        tryPromise(() => runLinuxPackageCommand(command, "update", [], { progress })),
      );
    }
    for (const packageSpec of missing) {
      const result = yield* progress.track(
        `Installing ${packageSpec} (${profile})`,
        tryPromise(() =>
          runLinuxPackageCommand(command, "install", [packageSpec], {
            offline,
            allowFailure: true,
            progress,
          }),
        ),
      );
      if (result.code !== 0) {
        const failure = `${command.manager} install ${packageSpec} failed (exit ${result.code})`;
        if (strict) {
          return yield* new CliFailure({ message: `${failure}.` });
        }
        failures.push(failure);
        progress.log(ui.warning(`${failure}; continuing.`));
        continue;
      }
      const observed = yield* tryPromise(() =>
        listInstalledLinuxPackages(command.manager, command),
      );
      const identity = installedIdentity(packageSpec, observed);
      if (identity === undefined) {
        const failure = `${command.manager} install ${packageSpec} returned success but the package is not installed`;
        if (strict) {
          return yield* new CliFailure({ message: `${failure}.` });
        }
        failures.push(failure);
        progress.log(ui.warning(`${failure}; continuing.`));
        continue;
      }
      setOwned(ownership, profile, command.manager, [
        ...owned(ownership, profile, command.manager),
        identity,
      ]);
      yield* tryPromise(() => writeOwnership(config, ownership));
    }
    return failures;
  });
}

function planLinuxPrune(
  context: LinuxApplyContext,
  declared: ReadonlyArray<string>,
  inventory: LinuxPackageInventory,
) {
  return Effect.gen(function* () {
    const { command, ownership, profile } = context;
    const desired = new Set(
      declared.flatMap((spec) => {
        const identity = installedIdentity(spec, inventory);
        return identity === undefined ? [] : [identity];
      }),
    );
    const stale = owned(ownership, profile, command.manager).filter((name) => !desired.has(name));
    const removable: string[] = [];
    for (const name of stale) {
      if (
        !inventory.installed.has(name) ||
        otherOwners(ownership, profile, command.manager, name).length > 0
      ) {
        setOwned(
          ownership,
          profile,
          command.manager,
          owned(ownership, profile, command.manager).filter((item) => item !== name),
        );
      } else {
        removable.push(name);
      }
    }
    if (removable.length === 0) {
      return [];
    }
    const simulation = yield* tryPromise(() => simulateRemoval(command, removable, inventory));
    yield* Console.log(ui.heading("Packages to be removed:"));
    for (const name of simulation) {
      yield* Console.log(`  ${command.manager}: ${name}`);
    }
    const unexpected = simulation.filter((name) => !removable.includes(name));
    if (unexpected.length > 0 || removable.some((name) => !simulation.includes(name))) {
      return yield* new CliFailure({
        message: `Refusing unsafe ${command.manager} removal; simulation does not match owned candidates. Unexpected: ${unexpected.join(", ") || "none (incomplete simulation)"}.`,
      });
    }
    yield* Console.log(
      ui.warning(
        "Ownership comes from local history. An external uninstall and reinstall cannot be detected; review these removals before continuing.",
      ),
    );
    return removable;
  });
}

/** Upgrade currently installed packages only; manifests and profiles are intentionally ignored. */
export const updateLinux = (options: LinuxUpdateOptions = {}) =>
  Effect.gen(function* () {
    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    const command = yield* tryPromise(() => detectManager(options, config));
    if (options.offline) {
      return yield* new CliFailure({
        message: `Offline ${command.manager} upgrades are refused because network-free resolution cannot be guaranteed.`,
      });
    }
    yield* Console.log(ui.heading(`Updating installed Linux packages with ${command.manager}…`));
    if (command.manager === "apt") {
      yield* tryPromise(() => runLinuxPackageCommand(command, "update"));
    }
    yield* tryPromise(() => runLinuxPackageCommand(command, "upgrade"));
    yield* Console.log(ui.success(`Linux ${command.manager} update complete.`));
  });

function reconcileOwnership(
  context: LinuxApplyContext,
  declared: string[],
  inventory: LinuxPackageInventory,
): void {
  const { ownership, profile, command } = context;
  // Forget absent installations before assigning shared ownership. Never claim manual installs.
  for (const owner of Object.keys(ownership.profiles)) {
    setOwned(
      ownership,
      owner,
      command.manager,
      owned(ownership, owner, command.manager).filter((name) => inventory.installed.has(name)),
    );
  }
  const shared = declared
    .map((spec) => installedIdentity(spec, inventory))
    .filter((name): name is string => name !== undefined)
    .filter((name) => otherOwners(ownership, profile, command.manager, name).length > 0);
  setOwned(ownership, profile, command.manager, [
    ...owned(ownership, profile, command.manager),
    ...shared,
  ]);
}

function executeLinuxApply(context: LinuxApplyContext, missing: string[], removals: string[]) {
  const updateLists =
    missing.length > 0 && context.command.manager === "apt" && !context.offline ? 1 : 0;
  return withProgress(
    "Linux apply",
    updateLists + missing.length + Number(removals.length > 0),
    (progress) =>
      Effect.gen(function* () {
        const { config, ownership, command, profile } = context;
        yield* tryPromise(() => writeOwnership(config, ownership));
        const failures = yield* installMissingPackages(context, missing, progress);
        if (failures.length > 0) {
          progress.finish();
          yield* Console.log(
            ui.muted(
              `Linux apply was partial; failed package installs: ${failures.join("; ")}. Rerun apply after fixing them. Requested pruning was skipped.`,
            ),
          );
          return false;
        }
        if (removals.length > 0) {
          const currentInventory = yield* tryPromise(() =>
            listInstalledLinuxPackages(command.manager, command),
          );
          const currentPlan = yield* tryPromise(() =>
            simulateRemoval(command, removals, currentInventory),
          );
          if (
            currentPlan.length !== removals.length ||
            currentPlan.some((name) => !removals.includes(name))
          ) {
            return yield* new CliFailure({
              message: "Removal plan changed after installation; rerun apply --prune to review it.",
            });
          }
          yield* progress.track(
            `Removing ${removals.length} packages with ${command.manager}`,
            tryPromise(() => runLinuxPackageCommand(command, "remove", removals, { progress })),
          );
          setOwned(
            ownership,
            profile,
            command.manager,
            owned(ownership, profile, command.manager).filter((name) => !removals.includes(name)),
          );
          yield* tryPromise(() => writeOwnership(config, ownership));
        }
        return true;
      }),
  );
}

/** Reconcile one local Linux profile and optionally prune recorded ownership. */
export const applyLinux = <ConfirmR = never>(options: LinuxApplyOptions<ConfirmR> = {}) =>
  Effect.gen(function* () {
    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    const profile = yield* Effect.try({
      try: () => resolveProfile(options.profile, config),
      catch: toCliFailure,
    });
    if (yield* skipUnconfiguredLinuxApply(options, config, profile)) {
      return;
    }
    const source = yield* tryPromise(() => resolveLinuxApplySource(options, config, profile));
    const command = yield* tryPromise(() => detectManager(options, config));
    const declared = yield* Effect.tryPromise({
      try: async () =>
        parseLinuxPackageManifest(
          await readLinuxManifest(config, profile, source?.root, command.manager),
        ),
      catch: toCliFailure,
    });
    const installed = yield* tryPromise(() => listInstalledLinuxPackages(command.manager, command));
    const missing = missingLinuxPackages(declared, installed);
    const { state: ownership, migrated } = yield* tryPromise(() => readOwnership(config));
    if (migrated) {
      yield* Console.log(
        ui.warning(
          "Legacy apt ownership lacked architecture; dropped old apt removal rights. Existing packages will not be pruned unless installed again by Outfitting.",
        ),
      );
    }
    const context = {
      config,
      profile,
      command,
      ownership,
      offline: options.offline === true,
      strict: options.strict === true,
    } satisfies LinuxApplyContext;
    reconcileOwnership(context, declared, installed);
    const removals = options.prune ? yield* planLinuxPrune(context, declared, installed) : [];
    for (const spec of missing) {
      yield* Console.log(`  install ${command.manager}: ${spec}`);
    }
    if ((missing.length > 0 || removals.length > 0) && !options.yes) {
      const confirmed = options.confirm === undefined ? false : yield* options.confirm;
      if (!confirmed) {
        yield* Console.log(ui.muted("Aborted. No package changes were made."));
        return;
      }
    }
    const complete = yield* executeLinuxApply(context, missing, removals);
    if (!complete) {
      return yield* new CliFailure({
        message: `Linux ${command.manager} apply was partial; one or more package installs failed.`,
      });
    }
    yield* Console.log(ui.success(`Linux ${command.manager} profile applied (${profile}).`));
  });
