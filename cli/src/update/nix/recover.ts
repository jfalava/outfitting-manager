import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { Console, Effect } from "effect";

import { loadConfig, type ManagerConfig } from "@/config";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { pushLockfile } from "@/sync";
import { setTerminalPhase, TerminalSession } from "@/terminal-alert";
import { ui } from "@/ui";
import { activateHomeManager, activateNixSystem } from "@/update/nix/activate";
import {
  clearNixRecovery,
  defaultNixRecoveryDir,
  readNixRecovery,
  setNixRecoveryPhase,
  type NixRecoveryState,
} from "@/update/nix/recovery";
import { NIX_LOCK_KIND } from "@/update/nix/types";

export interface RecoverNixOptions {
  config?: ManagerConfig;
  recoveryDir?: string;
  activate?: typeof activateNixSystem;
  activateHomeManager?: typeof activateHomeManager;
  push?: typeof pushLockfile;
}

function recoveryIfMatch(baseHash: string): string | undefined {
  return /^[0-9a-f]{64}$/i.test(baseHash) ? baseHash : undefined;
}

function activatePreparedNix(
  options: RecoverNixOptions,
  state: NixRecoveryState,
  recoveryDir: string,
) {
  return Effect.gen(function* () {
    if (
      state.platform === undefined ||
      state.systemConfig === undefined ||
      !isAbsolute(state.systemConfig) ||
      (state.platform === "linux" && (state.repoRoot === undefined || !isAbsolute(state.repoRoot)))
    ) {
      return yield* new CliFailure({
        message:
          "Legacy prepared Nix checkpoint has no pinned build and cannot safely activate. Inspect the checkpoint before recovering it manually.",
      });
    }
    const available = yield* Effect.promise(async () =>
      stat(state.systemConfig!).then(
        (info) => info.isDirectory(),
        () => false,
      ),
    );
    if (!available) {
      return yield* new CliFailure({
        message: `Pinned Nix build no longer exists: ${state.systemConfig}. Checkpoint retained; refusing to rebuild from a changed source.`,
      });
    }
    const activate = options.activate ?? activateNixSystem;
    yield* setTerminalPhase("Activating recovered profile");
    if (state.platform === "linux") {
      const activateHomeManagerFn = options.activateHomeManager ?? activateHomeManager;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        OUTFITTING_REPO: state.repoRoot,
      };
      yield* Console.log(ui.heading("Activating the recovered Home Manager profile…"));
      yield* tryPromise(() =>
        activateHomeManagerFn({ activationPackage: state.systemConfig!, env }),
      );
    } else {
      const session = yield* TerminalSession;
      yield* Console.log(ui.heading("Activating the recovered nix-darwin system…"));
      yield* tryPromise(() =>
        activate({
          systemConfig: state.systemConfig!,
          alert: session.alert,
          resume: session.resume,
        }),
      );
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
      yield* activatePreparedNix(options, state, recoveryDir);
    }

    yield* setTerminalPhase("Publishing recovered Nix lock");
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
