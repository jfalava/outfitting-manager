import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Console, Effect } from "effect";

import { configuredProfile, loadConfig, type ManagerConfig } from "@/config";
import { physicalPath, resolveOutfittingRepo, type OutfittingRepo } from "@/config/repo";
import { CliFailure } from "@/errors";
import type { ManifestFetcher } from "@/fetch/github";
import { pullLockfile, pushLockfile, resolveLockfileCredentials } from "@/lockfiles";
import { tryPromise } from "@/lockfiles/effect";
import { isGitTrackedFile } from "@/lockfiles/files";
import { which } from "@/process";
import { resolveSetupSource } from "@/setup/run";
import { syncByorSparseSource } from "@/setup/source";
import { validateLinuxByorSource, validateMacosByorSource } from "@/source/contract";
import { ui } from "@/ui";
import { isLinuxProfile, prepareLinuxSource } from "@/update/linux-source";
import { activateHomeManager, activateNixSystem } from "@/update/nix/activate";
import { buildNixSystem } from "@/update/nix/build";
import { closeNixLock, openNixLock } from "@/update/nix/lock";
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
  repo?: OutfittingRepo;
  sourceFetcher?: ManifestFetcher;
  offline?: boolean;
  /** Override Linux profile used to pick the Home Manager flake. */
  profile?: string;
  /** Use the selected local source without fetching remote changes. */
  noRefresh?: boolean;
  /** Skip Linux Nix actions when the selected profile has no Nix declaration. */
  ifConfigured?: boolean;
  /** Skip publishing the related Nix lock after a successful action. */
  noPush?: boolean;
}

function resolveMacosRepo(options: UpdateNixOptions, config: ManagerConfig) {
  return Effect.gen(function* () {
    const profile = configuredProfile(config, "macos", options.profile);
    if (options.repo !== undefined) {
      yield* tryPromise(() =>
        validateMacosByorSource({
          root: options.repo!.root,
          profile,
          contract: config.declarations!,
        }),
      );
      return options.repo;
    }
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

    yield* Console.log(ui.heading("Refreshing remote source…"));
    const source = yield* tryPromise(() =>
      syncByorSparseSource({
        config,
        platform: "macos",
        profile,
        fetcher: options.sourceFetcher,
        offline: options.offline === true || options.noRefresh === true,
      }),
    );
    return yield* tryPromise(() =>
      resolveOutfittingRepo({ config, envRepo: source.root, profile, platform: "macos" }),
    );
  });
}

function missingLinuxFlake(profile: string): CliFailure {
  return new CliFailure({
    message: `BYOR Linux profile \`${profile}\` does not declare a Nix flake.`,
  });
}

function requireLinuxFlakeRepo(
  repo: OutfittingRepo,
  profile: string,
): Effect.Effect<OutfittingRepo, CliFailure> {
  if (repo.flakeKind === "none" || repo.flakePath.length === 0) {
    return Effect.fail(missingLinuxFlake(profile));
  }
  return Effect.succeed(repo);
}

function resolveLinuxNixRepo(options: UpdateNixOptions, config: ManagerConfig) {
  return Effect.gen(function* () {
    const profile = configuredProfile(config, "linux", options.profile);
    if (profile === undefined) {
      return yield* new CliFailure({
        message: "No Linux BYOR profile is selected. Run init --profile <name> or pass --profile.",
      });
    }
    if (!isLinuxProfile(profile)) {
      return yield* new CliFailure({
        message: `Invalid Linux profile \`${profile}\`.`,
      });
    }
    const source = yield* tryPromise(() =>
      prepareLinuxSource({
        config,
        profile,
        refresh: options.noRefresh !== true,
        offline: options.offline,
        fetcher: options.sourceFetcher,
      }),
    );
    if (source.repo === undefined) {
      return yield* missingLinuxFlake(profile);
    }
    const validated = yield* tryPromise(() =>
      validateLinuxByorSource({ root: source.root, profile, contract: config.declarations! }),
    );
    if (validated.linux.nix === undefined) {
      return yield* missingLinuxFlake(profile);
    }
    return yield* requireLinuxFlakeRepo(source.repo, profile);
  });
}

function resolveActiveRepo(options: UpdateNixOptions, config: ManagerConfig) {
  if (process.platform === "darwin") {
    if (options.repo !== undefined) {
      return Effect.succeed(options.repo);
    }
    return resolveMacosRepo(options, config);
  }
  return resolveLinuxNixRepo(options, config);
}

function nixTargetLabel(repo: OutfittingRepo): string {
  switch (repo.flakeKind) {
    case "macos":
      return "nix-darwin system";
    case "home-manager":
      return `Home Manager (${repo.homeManagerName ?? "profile"})`;
    case "none":
      return "Nix profile";
    default: {
      const exhaustive: never = repo.flakeKind;
      return exhaustive;
    }
  }
}

async function localFlakeLockPath(repo: OutfittingRepo): Promise<string | undefined> {
  if (repo.flakePath.length === 0) {
    return undefined;
  }
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

function openActionLock(repo: OutfittingRepo, config: ManagerConfig, failOnRemoteError = false) {
  return Effect.gen(function* () {
    const fallbackPath = yield* tryPromise(() => localFlakeLockPath(repo));
    const lock = yield* tryPromise(() =>
      openNixLock(config, pullLockfile, {
        fallbackPath,
        allowMissing: true,
        failOnRemoteError,
      }),
    );
    return {
      lockPath: lock.lockPath.length > 0 ? lock.lockPath : undefined,
      lockDir: lock.lockDir.length > 0 ? lock.lockDir : undefined,
      baseHash: lock.baseHash,
      source: lock.source,
      warning: lock.warning,
    };
  });
}

type NonUpdateNixAction = Exclude<NixAction, "update">;

function runNixAction(
  action: NonUpdateNixAction,
  repo: OutfittingRepo,
  lockPath: string | undefined,
  label: string,
) {
  return Effect.gen(function* () {
    switch (action) {
      case "build": {
        yield* Console.log(ui.heading(`Building ${label}…`));
        const path = yield* tryPromise(() => buildNixSystem({ repo, lockPath, mode: "build" }));
        yield* Console.log(ui.success(`Built ${path}`));
        return;
      }
      case "test": {
        yield* Console.log(ui.heading(`Testing ${label} build…`));
        yield* tryPromise(() => buildNixSystem({ repo, lockPath, mode: "test" }));
        yield* Console.log(ui.success("Build successful — ready to switch."));
        return;
      }
      case "dry-run": {
        yield* Console.log(ui.heading(`Dry-run ${label} build…`));
        yield* tryPromise(() => buildNixSystem({ repo, lockPath, mode: "dry" }));
        yield* Console.log(ui.success("Dry-run complete."));
        return;
      }
      case "switch": {
        yield* Console.log(ui.heading(`Building ${label}…`));
        const systemConfig = yield* tryPromise(() =>
          buildNixSystem({ repo, lockPath, mode: "build" }),
        );
        const isHomeManager = repo.flakeKind === "home-manager";
        yield* Console.log(
          ui.heading(isHomeManager ? "Activating Home Manager…" : "Activating nix-darwin system…"),
        );
        yield* tryPromise(() => activateNixProfile(repo, systemConfig));
        yield* Console.log(
          ui.success(
            isHomeManager ? "Home Manager switch complete." : "nix-darwin switch complete.",
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

function activateNixProfile(repo: OutfittingRepo, systemConfig: string) {
  if (repo.flakeKind === "home-manager") {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OUTFITTING_REPO: repo.root,
    };
    return activateHomeManager({ activationPackage: systemConfig, env });
  }
  return activateNixSystem({ systemConfig });
}

function runNixUpdate(
  options: UpdateNixOptions,
  config: ManagerConfig,
  repo: OutfittingRepo,
  lock: {
    lockPath?: string;
    baseHash?: string;
  },
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
      yield* Console.log(ui.heading(`Updating flake inputs for ${nixTargetLabel(repo)}…`));
      yield* tryPromise(() =>
        updateNixLock({
          repo,
          referenceLockPath: lock.lockPath,
          outputLockPath: candidateLockPath,
        }),
      );

      yield* Console.log(ui.heading(`Building updated ${nixTargetLabel(repo)}…`));
      const systemConfig = yield* tryPromise(() =>
        buildNixSystem({
          repo,
          lockPath: candidateLockPath,
          outputLockPath: buildLockPath,
          mode: "build",
        }),
      );

      const credentials = yield* tryPromise(() => resolveLockfileCredentials());
      const platform = process.platform === "darwin" ? "macos" : "linux";
      const checkpoint = yield* tryPromise(() =>
        prepareNixRecovery({
          lockPath: candidateLockPath,
          baseHash: lock.baseHash ?? "",
          machine: config.machineId,
          platform,
          profile: configuredProfile(config, platform, options.profile),
          systemConfig,
          repoRoot: repo.root,
        }),
      );

      yield* Console.log(
        ui.heading(
          repo.flakeKind === "home-manager"
            ? "Activating Home Manager…"
            : "Activating nix-darwin system…",
        ),
      );
      yield* tryPromise(() => activateNixProfile(repo, systemConfig));
      yield* tryPromise(() => setNixRecoveryPhase("activated", checkpoint.dir));

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

function validateLinuxNixProfile(
  options: UpdateNixOptions,
  config: ManagerConfig,
): Effect.Effect<void, CliFailure> {
  if (process.platform === "darwin" || options.repo !== undefined) {
    return Effect.void;
  }
  const profile = configuredProfile(config, "linux", options.profile);
  if (profile === undefined) {
    return Effect.fail(
      new CliFailure({
        message: "No Linux BYOR profile is selected. Run init --profile <name> or pass --profile.",
      }),
    );
  }
  if (!isLinuxProfile(profile)) {
    return Effect.fail(new CliFailure({ message: `Invalid Linux profile \`${profile}\`.` }));
  }
  return Effect.void;
}

function validateNixUpdateOptions(options: UpdateNixOptions, config: ManagerConfig) {
  return Effect.gen(function* () {
    if (options.action === "update" && options.noPush === true) {
      return yield* new CliFailure({
        message:
          "nix update must publish its lock after a successful switch; --no-push is not supported.",
      });
    }

    if (options.ifConfigured !== true) {
      return false;
    }
    const profile = configuredProfile(config, "linux", options.profile);
    const declaration =
      profile === undefined ? undefined : config.declarations?.profiles[profile]?.linux;
    if (declaration === undefined || declaration.nix !== undefined) {
      return false;
    }

    yield* Console.log(ui.muted(`No Nix flake is declared for ${profile}; skipping.`));
    return true;
  });
}

/** Build, activate, or update the selected platform's configured Nix flake. */
export const updateNix = (options: UpdateNixOptions) =>
  Effect.gen(function* () {
    const config = options.config ?? (yield* tryPromise(() => loadConfig()));

    // Validate the selected BYOR profile before probing Nix.
    yield* validateLinuxNixProfile(options, config);

    if (yield* validateNixUpdateOptions(options, config)) {
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

    const repo = yield* resolveActiveRepo(options, config);
    if (repo.flakeKind === "none" || repo.flakePath.length === 0) {
      return yield* new CliFailure({
        message: "The selected BYOR source does not declare a Nix flake.",
      });
    }

    yield* tryPromise(() => ensureNixSymlinks(repo));
    yield* runNixActionWithPublish(options, config, repo);
  });

function runNixActionWithPublish(
  options: UpdateNixOptions,
  config: ManagerConfig,
  repo: OutfittingRepo,
) {
  return Effect.gen(function* () {
    const lock = yield* openActionLock(repo, config, options.action === "update");
    const { lockPath, lockDir, warning } = lock;
    let stagedLockDir: string | undefined;
    try {
      if (warning !== undefined) {
        yield* Console.log(ui.muted(warning));
      }
      if (options.action === "update") {
        yield* runNixUpdate(options, config, repo, lock);
        return;
      }
      yield* runNixAction(options.action, repo, lockPath, nixTargetLabel(repo));

      if (options.noPush === true) {
        yield* Console.log(ui.muted("Skipped Nix lock upload (--no-push)."));
        return;
      }

      const publishPath = lockPath ?? (yield* tryPromise(() => localFlakeLockPath(repo)));
      if (publishPath === undefined) {
        return yield* new CliFailure({
          message: "Nix action succeeded but no flake.lock was available to publish.",
        });
      }
      const stagedLock = yield* tryPromise(() => stageNixLockForPush(publishPath));
      stagedLockDir = stagedLock.directory;
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
      if (lockDir !== undefined) {
        yield* tryPromise(() => closeNixLock(lockDir));
      }
    }
  });
}
