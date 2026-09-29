import { join } from "node:path";

import { Console, Effect } from "effect";

import { configuredProfile, loadConfig, type ManagerConfig } from "@/config";
import { resolveOutfittingRepo, type OutfittingRepo } from "@/config/repo";
import { CliFailure } from "@/errors";
import { pushLockfile } from "@/lockfiles";
import { tryPromise } from "@/lockfiles/effect";
import { which } from "@/process";
import { ui } from "@/ui";
import { activateHomeManager, activateNixSystem } from "@/update/nix/activate";
import { buildNixSystem } from "@/update/nix/build";
import {
  clearNixRecovery,
  defaultNixRecoveryDir,
  readNixRecovery,
  setNixRecoveryPhase,
  type NixRecoveryState,
} from "@/update/nix/recovery";
import { ensureNixSymlinks } from "@/update/nix/symlinks";
import { NIX_LOCK_KIND } from "@/update/nix/types";

export interface RecoverNixOptions {
  config?: ManagerConfig;
  repo?: OutfittingRepo;
  recoveryDir?: string;
  which?: typeof which;
  build?: typeof buildNixSystem;
  activate?: typeof activateNixSystem;
  activateHomeManager?: typeof activateHomeManager;
  push?: typeof pushLockfile;
  ensureSymlinks?: typeof ensureNixSymlinks;
}

function validateRecoveryRepo(repo: OutfittingRepo): Effect.Effect<void, CliFailure> {
  if (repo.flakeKind === "none" || repo.flakePath.length === 0) {
    return Effect.fail(
      new CliFailure({
        message: "The recovery checkpoint's BYOR profile does not declare a Nix flake.",
      }),
    );
  }
  return Effect.void;
}

function recoveryIfMatch(baseHash: string): string | undefined {
  return /^[0-9a-f]{64}$/i.test(baseHash) ? baseHash : undefined;
}

function activatePreparedNix(
  options: RecoverNixOptions,
  config: ManagerConfig,
  state: NixRecoveryState,
  recoveryDir: string,
) {
  return Effect.gen(function* () {
    const whichFn = options.which ?? which;
    const nixPath = yield* tryPromise(() => whichFn("nix"));
    if (nixPath === undefined) {
      return yield* new CliFailure({ message: "nix is not installed or not in PATH." });
    }

    const platform = state.platform ?? (process.platform === "darwin" ? "macos" : "linux");
    const repo =
      options.repo ??
      (yield* tryPromise(() =>
        resolveOutfittingRepo({
          config,
          profile: configuredProfile(config, platform, state.profile),
          platform,
        }),
      ));
    yield* validateRecoveryRepo(repo);
    const ensureSymlinks = options.ensureSymlinks ?? ensureNixSymlinks;
    yield* tryPromise(() => ensureSymlinks(repo));

    const build = options.build ?? buildNixSystem;
    const activate = options.activate ?? activateNixSystem;
    yield* Console.log(ui.heading("Building the Nix recovery checkpoint…"));
    const systemConfig = yield* tryPromise(() =>
      build({
        repo,
        lockPath: state.lockPath,
        outputLockPath: join(recoveryDir, "build-flake.lock"),
        mode: "build",
      }),
    );
    if (repo.flakeKind === "home-manager") {
      const activateHomeManagerFn = options.activateHomeManager ?? activateHomeManager;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OUTFITTING_REPO: repo.root,
      };
      yield* Console.log(ui.heading("Activating the recovered Home Manager profile…"));
      yield* tryPromise(() => activateHomeManagerFn({ activationPackage: systemConfig, env }));
    } else {
      yield* Console.log(ui.heading("Activating the recovered nix-darwin system…"));
      yield* tryPromise(() => activate({ systemConfig }));
    }
    yield* tryPromise(() => setNixRecoveryPhase("activated", recoveryDir));
  });
}

/** Resume a prepared Nix checkpoint, then publish its lock with compare-and-swap. */
export const recoverNix = (options: RecoverNixOptions = {}) =>
  Effect.gen(function* () {
    const recoveryDir = options.recoveryDir ?? defaultNixRecoveryDir();
    const state = yield* tryPromise(() => readNixRecovery(recoveryDir));
    if (state === undefined) {
      return yield* new CliFailure({
        message: `No unfinished Nix recovery checkpoint exists at ${recoveryDir}.`,
      });
    }

    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    const platform = process.platform === "darwin" ? "macos" : "linux";
    if (state.platform !== undefined && state.platform !== platform) {
      return yield* new CliFailure({
        message: `Nix recovery checkpoint belongs to ${state.platform}, not ${platform}.`,
      });
    }
    if (state.machine !== undefined && state.machine !== config.machineId) {
      return yield* new CliFailure({
        message: `Nix recovery checkpoint belongs to ${state.machine}; current machine is ${config.machineId}.`,
      });
    }
    const push = options.push ?? pushLockfile;

    if (state.phase === "prepared") {
      yield* activatePreparedNix(options, config, state, recoveryDir);
    }

    yield* Console.log(ui.heading("Publishing the recovered Nix lock…"));
    yield* push({
      machine: config.machineId,
      kind: NIX_LOCK_KIND,
      path: state.lockPath,
      ifMatch: recoveryIfMatch(state.baseHash),
    });
    yield* tryPromise(() => clearNixRecovery(recoveryDir));
    yield* Console.log(ui.success("Nix recovery completed successfully."));
  });
