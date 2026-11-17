import { readdir, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { Console, Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure, isNotFound } from "@/errors";
import { runCommand } from "@/process";
import { setTerminalPhase, TerminalSession } from "@/terminal-alert";
import { ui } from "@/ui";
import { activateNixos, NIXOS_SYSTEM_PROFILE } from "@/update/nix/activate";
import { hasNixRecovery } from "@/update/nix/recovery";

/**
 * Profile holding the system marked safe. install-grub lists every profile under
 * system-profiles/ whose name matches ^\w+$ as its own boot submenu, so the name
 * must not contain a hyphen. nh clean all does not descend into system-profiles/,
 * so mark-safe deletes the previous pins itself.
 */
export const NIXOS_SAFE_PROFILE = "/nix/var/nix/profiles/system-profiles/outfitting_safe";

export type RollbackTarget =
  | { kind: "previous" }
  | { kind: "generation"; number: number }
  | { kind: "safe" };

export interface RollbackSelection {
  systemConfig: string;
  label: string;
}

export interface RollbackPaths {
  systemProfile?: string;
  safeProfile?: string;
  currentSystem?: string;
}

async function resolvedOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
}

async function systemGenerations(systemProfile: string) {
  const name = basename(systemProfile);
  const pattern = new RegExp(`^${name}-(\\d+)-link$`);
  const generations = (await readdir(dirname(systemProfile)))
    .map((entry) => ({ entry, match: pattern.exec(entry) }))
    .filter((item) => item.match !== null)
    .map((item) => ({
      number: Number(item.match![1]),
      link: join(dirname(systemProfile), item.entry),
    }))
    .toSorted((a, b) => b.number - a.number);
  const current = pattern.exec(basename(await readlink(systemProfile)));
  return { generations, current: current === null ? undefined : Number(current[1]) };
}

/** Resolve which already-built system a rollback switches to. Never builds anything. */
export async function selectRollback(
  target: RollbackTarget,
  paths: RollbackPaths = {},
): Promise<RollbackSelection> {
  const systemProfile = paths.systemProfile ?? NIXOS_SYSTEM_PROFILE;
  if (target.kind === "safe") {
    const systemConfig = await resolvedOrUndefined(paths.safeProfile ?? NIXOS_SAFE_PROFILE);
    if (systemConfig === undefined) {
      throw new Error(
        "No system is marked safe. Run `outfitting-manager nix mark-safe` while running a system you trust.",
      );
    }
    return { systemConfig, label: "the system marked safe" };
  }

  const { generations, current } = await systemGenerations(systemProfile);
  if (target.kind === "generation") {
    const generation = generations.find((item) => item.number === target.number);
    if (generation === undefined) {
      const available = generations.map((item) => item.number).join(", ");
      throw new Error(
        `System generation ${target.number} does not exist (available: ${available || "none"}).`,
      );
    }
    return {
      systemConfig: await realpath(generation.link),
      label: `system generation ${generation.number}`,
    };
  }

  return selectPrevious(generations, current, systemProfile, paths.currentSystem);
}

async function selectPrevious(
  generations: { number: number; link: string }[],
  current: number | undefined,
  systemProfile: string,
  currentSystem = "/run/current-system",
): Promise<RollbackSelection> {
  if (current === undefined) {
    throw new Error(`Cannot tell which generation ${systemProfile} points at.`);
  }
  // Skip older generations that are the running system, such as one an earlier rollback added.
  const running = await resolvedOrUndefined(currentSystem);
  for (const generation of generations) {
    if (generation.number >= current) {
      continue;
    }
    const systemConfig = await realpath(generation.link);
    if (systemConfig !== running) {
      return { systemConfig, label: `system generation ${generation.number}` };
    }
  }
  throw new Error(
    `No system generation older than ${current} differs from the running system. Try \`outfitting-manager nix rollback --safe\`.`,
  );
}

/**
 * Switch this NixOS host back to an existing generation or the system marked safe.
 * It always adds a new generation: nh clean keeps the newest generations, not the one
 * the profile points at, so pointing the profile at an old generation would not survive it.
 */
export const rollbackNixos = (target: RollbackTarget) =>
  Effect.gen(function* () {
    const selection = yield* tryPromise(() => selectRollback(target));
    const left = yield* tryPromise(() => resolvedOrUndefined("/run/current-system"));
    const session = yield* TerminalSession;
    yield* setTerminalPhase("Rolling back");
    yield* Console.log(ui.heading(`Switching to ${selection.label}…`));
    yield* Console.log(ui.muted(selection.systemConfig));
    yield* tryPromise(() =>
      activateNixos({
        systemConfig: selection.systemConfig,
        alert: session.alert,
        resume: session.resume,
      }),
    );
    yield* Console.log(ui.success(`Rolled back to ${selection.label}.`));
    if (yield* tryPromise(() => hasNixRecovery())) {
      yield* Console.log(
        ui.warning(
          "An unfinished `nix update` checkpoint remains. `recover nix` would switch back to its build; abandon it with `outfitting-manager recover nix --clear`.",
        ),
      );
    }
    if (left === selection.systemConfig) {
      return;
    }
    yield* Console.log(
      ui.warning(
        "The flake source and the remote Nix lock still describe the system you left. The next `nix switch` or `nix update`, including scheduled ones, rebuilds it unless you fix or revert the cause first.",
      ),
    );
  });

/** Pin the running system in the safe profile so `nix rollback --safe` and the boot menu can return to it. */
export const markNixosSafe = (run: typeof runCommand = runCommand) =>
  Effect.gen(function* () {
    const system = yield* tryPromise(() => realpath("/run/current-system"));
    const booted = yield* tryPromise(() => resolvedOrUndefined("/run/booted-system"));
    if (booted !== system) {
      yield* Console.log(
        ui.warning("The running system has not been booted yet; marking it safe anyway."),
      );
    }
    yield* Console.log(ui.heading("Marking the running system safe…"));
    const nixEnv = ["-H", "env", "NIX_PATH=", "nix-env", "-p", NIXOS_SAFE_PROFILE];
    const steps = [
      ["mkdir", "-p", dirname(NIXOS_SAFE_PROFILE)],
      [...nixEnv, "--set", system],
      // Only the newest pin is needed; older ones would keep their systems out of GC forever.
      [...nixEnv, "--delete-generations", "old"],
    ];
    for (const args of steps) {
      const result = yield* tryPromise(() => run("sudo", args, { inherit: true }));
      if (result.code !== 0) {
        return yield* new CliFailure({
          message: `Marking the system safe failed (exit ${result.code}).`,
        });
      }
    }
    yield* Console.log(ui.success(`Marked safe: ${system}`));
    yield* Console.log(
      ui.muted(
        "The next system switch adds it to the boot menu as NixOS - Profile 'outfitting_safe'.",
      ),
    );
  });
