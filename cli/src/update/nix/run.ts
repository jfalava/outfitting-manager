import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Console, Effect } from "effect";

import { configuredProfile, loadConfig, type ManagerConfig } from "@/config";
import {
  physicalPath,
  resolveOutfittingRepo,
  type NixFlakeRepo,
  type OutfittingRepo,
} from "@/config/repo";
import { tryPromise } from "@/effect";
import { CliFailure, toCliFailure } from "@/errors";
import type { ManifestFetcher } from "@/fetch/github";
import { which } from "@/process";
import { resolveSetupSource } from "@/setup/run";
import { syncByorSparseSource } from "@/setup/source";
import { validateMacosByorSource } from "@/source/contract";
import { pullLockfile, pushLockfile, resolveLockfileCredentials } from "@/sync";
import { isGitTrackedFile } from "@/sync/files";
import { setTerminalPhase, TerminalSession } from "@/terminal-alert";
import { ui } from "@/ui";
import { prepareLinuxSource, resolveLinuxProfile } from "@/update/linux-source";
import { activateHomeManager, activateNixSystem } from "@/update/nix/activate";
import { buildNixSystem } from "@/update/nix/build";
import { closeNixLock, openNixLock, type NixLock } from "@/update/nix/lock";
import {
  clearNixRecovery,
  prepareNixRecovery,
  readNixRecovery,
  setNixRecoveryPhase,
} from "@/update/nix/recovery";
import { ensureNixSymlinks } from "@/update/nix/symlinks";
import { NIX_LOCK_KIND, type NixAction } from "@/update/nix/types";
import { updateNixLock } from "@/update/nix/update-lock";

export interface UpdateNixOptions {
  action: NixAction;
  config?: ManagerConfig;
  sourceFetcher?: ManifestFetcher;
  /** Override the platform profile used to pick the flake. */
  profile?: string;
  /** Use the selected local source without fetching remote changes. */
  noRefresh?: boolean;
  /** Skip Linux Nix actions when the selected profile has no Nix declaration. */
  ifConfigured?: boolean;
  /** Skip publishing the related Nix lock after a successful action. */
  noPush?: boolean;
}

type NixSelection =
  | { platform: "macos"; profile: string | undefined }
  | { platform: "linux"; profile: string };

function selectNixProfile(
  config: ManagerConfig,
  override: string | undefined,
): Effect.Effect<NixSelection, CliFailure> {
  if (process.platform === "darwin") {
    return Effect.succeed({
      platform: "macos",
      profile: configuredProfile(config, "macos", override),
    });
  }
  return Effect.try({
    try: (): NixSelection => ({
      platform: "linux",
      profile: resolveLinuxProfile(config, override),
    }),
    catch: toCliFailure,
  });
}

function resolveMacosRepo(
  options: UpdateNixOptions,
  config: ManagerConfig,
  profile: string | undefined,
) {
  return Effect.gen(function* () {
    const selected = yield* tryPromise(() => resolveSetupSource({ platform: "macos", config }));
    if (selected.repo !== undefined) {
      const repo = yield* tryPromise(() =>
        resolveOutfittingRepo({ config, envRepo: selected.repo, profile, platform: "macos" }),
      );
      yield* tryPromise(() =>
        validateMacosByorSource({ root: repo.root, profile, contract: config.declarations! }),
      );
      return repo;
    }

    yield* setTerminalPhase("Refreshing source");
    yield* Console.log(ui.heading("Refreshing remote source…"));
    const source = yield* tryPromise(() =>
      syncByorSparseSource({
        config,
        platform: "macos",
        profile,
        fetcher: options.sourceFetcher,
        offline: options.noRefresh === true,
      }),
    );
    return yield* tryPromise(() =>
      resolveOutfittingRepo({ config, envRepo: source.root, profile, platform: "macos" }),
    );
  });
}

function resolveActiveRepo(
  options: UpdateNixOptions,
  config: ManagerConfig,
  selection: NixSelection,
): Effect.Effect<OutfittingRepo, CliFailure> {
  if (selection.platform === "macos") {
    return resolveMacosRepo(options, config, selection.profile);
  }
  return tryPromise(() =>
    prepareLinuxSource({
      config,
      profile: selection.profile,
      refresh: options.noRefresh !== true,
      fetcher: options.sourceFetcher,
    }),
  ).pipe(Effect.map((source) => source.repo));
}

function nixTargetLabel(repo: NixFlakeRepo): string {
  return repo.flakeKind === "macos"
    ? "nix-darwin system"
    : `Home Manager (${repo.homeManagerName})`;
}

async function localFlakeLockPath(repo: NixFlakeRepo): Promise<string | undefined> {
  const lockPath = join(repo.flakePath, "flake.lock");
  try {
    await access(lockPath);
    return lockPath;
  } catch {
    return undefined;
  }
}

async function stageNixLockForPush(lockPath: string): Promise<{
  path: string;
  directory?: string;
}> {
  if (!(await isGitTrackedFile(lockPath))) {
    return { path: lockPath };
  }

  const directory = await mkdtemp(join(tmpdir(), "outfitting-nix-push-"));
  const path = join(directory, "flake.lock");
  try {
    await copyFile(lockPath, path);
    return { path, directory };
  } catch (cause) {
    await rm(directory, { force: true, recursive: true });
    throw cause;
  }
}

function activateNixProfile(repo: NixFlakeRepo, systemConfig: string) {
  return Effect.gen(function* () {
    yield* setTerminalPhase("Activating");
    if (repo.flakeKind === "home-manager") {
      yield* Console.log(ui.heading("Activating Home Manager…"));
      yield* tryPromise(() =>
        activateHomeManager({ activationPackage: systemConfig, repoRoot: repo.root }),
      );
      return;
    }
    yield* Console.log(ui.heading("Activating nix-darwin system…"));
    const session = yield* TerminalSession;
    yield* tryPromise(() =>
      activateNixSystem({ systemConfig, alert: session.alert, resume: session.resume }),
    );
  });
}

function runNixAction(
  action: Exclude<NixAction, "update">,
  repo: NixFlakeRepo,
  lockPath: string | undefined,
) {
  return Effect.gen(function* () {
    const label = nixTargetLabel(repo);
    switch (action) {
      case "build": {
        yield* setTerminalPhase("Building");
        yield* Console.log(ui.heading(`Building ${label}…`));
        const path = yield* tryPromise(() => buildNixSystem({ repo, lockPath, mode: "build" }));
        yield* Console.log(ui.success(`Built ${path}`));
        return;
      }
      case "test": {
        yield* setTerminalPhase("Testing build");
        yield* Console.log(ui.heading(`Testing ${label} build…`));
        yield* tryPromise(() => buildNixSystem({ repo, lockPath, mode: "test" }));
        yield* Console.log(ui.success("Build successful — ready to switch."));
        return;
      }
      case "dry-run": {
        yield* setTerminalPhase("Dry-run build");
        yield* Console.log(ui.heading(`Dry-run ${label} build…`));
        yield* tryPromise(() => buildNixSystem({ repo, lockPath, mode: "dry" }));
        yield* Console.log(ui.success("Dry-run complete."));
        return;
      }
      case "switch": {
        yield* setTerminalPhase("Building");
        yield* Console.log(ui.heading(`Building ${label}…`));
        const systemConfig = yield* tryPromise(() =>
          buildNixSystem({ repo, lockPath, mode: "build" }),
        );
        yield* activateNixProfile(repo, systemConfig);
        yield* Console.log(
          ui.success(
            repo.flakeKind === "home-manager"
              ? "Home Manager switch complete."
              : "nix-darwin switch complete.",
          ),
        );
        return;
      }
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  });
}

function runNixUpdate(
  config: ManagerConfig,
  selection: NixSelection,
  repo: NixFlakeRepo,
  lock: NixLock,
) {
  return Effect.gen(function* () {
    const paths = yield* tryPromise(async () => {
      const displayDir = await mkdtemp(join(tmpdir(), "outfitting-nix-update-"));
      try {
        return { displayDir, physicalDir: await physicalPath(displayDir) };
      } catch (cause) {
        await rm(displayDir, { force: true, recursive: true });
        throw cause;
      }
    });
    const candidateLockPath = join(paths.physicalDir, "updated-flake.lock");
    const buildLockPath = join(paths.physicalDir, "build-flake.lock");

    try {
      yield* setTerminalPhase("Updating flake inputs");
      yield* Console.log(ui.heading(`Updating flake inputs for ${nixTargetLabel(repo)}…`));
      yield* tryPromise(() =>
        updateNixLock({
          repo,
          referenceLockPath: lock.lockPath,
          outputLockPath: candidateLockPath,
        }),
      );

      yield* setTerminalPhase("Building updated profile");
      yield* Console.log(ui.heading(`Building updated ${nixTargetLabel(repo)}…`));
      const systemConfig = yield* tryPromise(() =>
        buildNixSystem({
          repo,
          lockPath: candidateLockPath,
          outputLockPath: buildLockPath,
          mode: "build",
        }),
      );

      const credentials = yield* resolveLockfileCredentials;
      const checkpoint = yield* tryPromise(() =>
        prepareNixRecovery({
          lockPath: candidateLockPath,
          baseHash: lock.baseHash,
          machine: config.machineId,
          platform: selection.platform,
          profile: selection.profile,
          systemConfig,
          repoRoot: repo.root,
        }),
      );

      yield* activateNixProfile(repo, systemConfig);
      yield* tryPromise(() => setNixRecoveryPhase("activated", checkpoint.dir));

      yield* setTerminalPhase("Publishing Nix lock");
      yield* Console.log(ui.heading(`Publishing ${config.machineId}/${NIX_LOCK_KIND}…`));
      yield* pushLockfile({
        machine: config.machineId,
        kind: NIX_LOCK_KIND,
        path: checkpoint.lockPath,
        ifMatch: lock.baseHash,
        credentials,
      });
      yield* tryPromise(() => clearNixRecovery(checkpoint.dir));
      yield* Console.log(ui.success(`Updated and switched ${nixTargetLabel(repo)}.`));
    } finally {
      yield* tryPromise(() => rm(paths.displayDir, { force: true, recursive: true }));
    }
  });
}

function skipUnconfiguredLinuxNix(
  options: UpdateNixOptions,
  config: ManagerConfig,
  selection: NixSelection,
): Effect.Effect<boolean> {
  const declaration =
    selection.platform === "linux"
      ? config.declarations?.profiles[selection.profile]?.linux
      : undefined;
  if (options.ifConfigured !== true || declaration === undefined || declaration.nix !== undefined) {
    return Effect.succeed(false);
  }
  return Console.log(ui.muted(`No Nix flake is declared for ${selection.profile}; skipping.`)).pipe(
    Effect.as(true),
  );
}

function requireNixFlake(
  repo: OutfittingRepo,
  profile: string | undefined,
): Effect.Effect<NixFlakeRepo, CliFailure> {
  if (repo.flakeKind !== "none") {
    return Effect.succeed(repo);
  }
  return Effect.fail(
    new CliFailure({
      message:
        profile === undefined
          ? "The selected BYOR source does not declare a Nix flake."
          : `BYOR profile \`${profile}\` does not declare a Nix flake.`,
    }),
  );
}

/** Build, activate, or update the selected platform's configured Nix flake. */
export const updateNix = (options: UpdateNixOptions) =>
  Effect.gen(function* () {
    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    if (options.action === "update" && options.noPush === true) {
      return yield* new CliFailure({
        message:
          "nix update must publish its lock after a successful switch; --no-push is not supported.",
      });
    }
    const selection = yield* selectNixProfile(config, options.profile);
    if (yield* skipUnconfiguredLinuxNix(options, config, selection)) {
      return;
    }

    const nixPath = yield* tryPromise(() => which("nix"));
    if (nixPath === undefined) {
      return yield* new CliFailure({ message: "nix is not installed or not in PATH." });
    }

    const recovery = yield* tryPromise(() => readNixRecovery());
    if (recovery !== undefined) {
      return yield* new CliFailure({
        message: `An unfinished Nix recovery checkpoint exists at ${recovery.dir}. Run: outfitting-manager recover nix`,
      });
    }

    yield* setTerminalPhase("Preparing source");
    const repo = yield* requireNixFlake(
      yield* resolveActiveRepo(options, config, selection),
      selection.profile,
    );

    yield* tryPromise(() => ensureNixSymlinks(repo));
    yield* runNixActionWithPublish(options, config, selection, repo);
  });

function runNixActionWithPublish(
  options: UpdateNixOptions,
  config: ManagerConfig,
  selection: NixSelection,
  repo: NixFlakeRepo,
) {
  return Effect.gen(function* () {
    yield* setTerminalPhase("Loading Nix lock");
    const lock = yield* tryPromise(async () =>
      openNixLock(config, pullLockfile, {
        fallbackPath: await localFlakeLockPath(repo),
        allowMissing: true,
        failOnRemoteError: options.action === "update",
      }),
    );
    let stagedLockDir: string | undefined;
    try {
      if (lock.warning !== undefined) {
        yield* Console.log(ui.muted(lock.warning));
      }
      if (options.action === "update") {
        yield* runNixUpdate(config, selection, repo, lock);
        return;
      }
      yield* runNixAction(options.action, repo, lock.lockPath);

      if (options.noPush === true) {
        yield* Console.log(ui.muted("Skipped Nix lock upload (--no-push)."));
        return;
      }

      const publishPath = lock.lockPath ?? (yield* tryPromise(() => localFlakeLockPath(repo)));
      if (publishPath === undefined) {
        return yield* new CliFailure({
          message: "Nix action succeeded but no flake.lock was available to publish.",
        });
      }
      const stagedLock = yield* tryPromise(() => stageNixLockForPush(publishPath));
      stagedLockDir = stagedLock.directory;
      yield* setTerminalPhase("Publishing Nix lock");
      yield* Console.log(ui.heading(`Publishing ${config.machineId}/${NIX_LOCK_KIND}…`));
      yield* pushLockfile({
        machine: config.machineId,
        kind: NIX_LOCK_KIND,
        path: stagedLock.path,
      });
    } finally {
      const cleanupLockDir = stagedLockDir;
      if (cleanupLockDir !== undefined) {
        yield* tryPromise(() => rm(cleanupLockDir, { force: true, recursive: true }));
      }
      const { lockDir } = lock;
      if (lockDir !== undefined) {
        yield* tryPromise(() => closeNixLock(lockDir));
      }
    }
  });
}
