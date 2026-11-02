import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

import { runCommand } from "@/process";
import { emitTerminalAlert, type TerminalAlert } from "@/terminal-alert";
import { recordNixosActivation } from "@/update/nix/nixos-record";
import { nixEnv } from "@/update/nix/types";

export interface ActivateNixSystemOptions {
  systemConfig: string;
  run?: typeof runCommand;
  alert?: (alert: TerminalAlert) => void;
  /** Resume the active phase after the first privileged command accepts authentication. */
  resume?: () => void;
  user?: string;
}

export interface ActivateHomeManagerOptions {
  /** Store path of the built homeConfigurations.*.activationPackage. */
  activationPackage: string;
  /** Repository root exposed to activation scripts as OUTFITTING_REPO. */
  repoRoot: string;
  run?: typeof runCommand;
}

function sudoEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.SUDO_HOME;
  delete env.NIX_PATH;
  return env;
}

/**
 * Activate a built nix-darwin system (matches outfit-activate-nix-system).
 * Checks sudo credentials without prompting, then leaves any needed password
 * prompt interactive for the privileged activation commands.
 */
export async function activateNixSystem(options: ActivateNixSystemOptions): Promise<void> {
  const run = options.run ?? runCommand;
  const alert = options.alert ?? emitTerminalAlert;
  const user = options.user ?? process.env.USER ?? process.env.LOGNAME ?? "";

  const sudoCheck = await run("sudo", ["-n", "-v"], { inherit: false });
  if (sudoCheck.code !== 0) {
    alert("password-required");
  }

  const setProfile = await run(
    "sudo",
    [
      "-H",
      "env",
      "HOME=/var/root",
      "NIX_PATH=",
      "nix-env",
      "-p",
      "/nix/var/nix/profiles/system",
      "--set",
      options.systemConfig,
    ],
    { inherit: true, env: sudoEnv({ HOME: "/var/root" }) },
  );
  if (setProfile.code !== 0) {
    throw new Error(`nix-env --set failed (exit ${setProfile.code}).`);
  }
  if (sudoCheck.code !== 0) {
    options.resume?.();
  }

  const activateArgs = ["-H", "env", "HOME=/var/root", "NIX_PATH="];
  const activateEnv = sudoEnv({ HOME: "/var/root" });
  if (user.length > 0) {
    activateArgs.push(`SUDO_USER=${user}`);
    activateEnv.SUDO_USER = user;
  }
  activateArgs.push(`${options.systemConfig}/sw/bin/darwin-rebuild`, "activate");

  const activate = await run("sudo", activateArgs, {
    inherit: true,
    env: activateEnv,
  });
  if (activate.code !== 0) {
    throw new Error(`darwin-rebuild activate failed (exit ${activate.code}).`);
  }
}

/** One-shot approval the NixOS pre-switch check consumes; it must name the incoming system. */
export const NIXOS_SWITCH_APPROVAL = "/run/outfitting-manager/approved-switch";

export interface ActivateNixosOptions {
  /** Store path of the built nixosConfigurations.*.config.system.build.toplevel. */
  systemConfig: string;
  run?: typeof runCommand;
  alert?: (alert: TerminalAlert) => void;
  resume?: () => void;
  exists?: (path: string) => Promise<boolean>;
  record?: (system: string) => Promise<void>;
}

const pathExists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Activate a built NixOS system on this host: approve the switch, set the system
 * profile, then run switch-to-configuration in a transient system unit so restarting
 * the caller's user units (agent sessions, SSH helpers) cannot interrupt activation.
 */
export async function activateNixos(options: ActivateNixosOptions): Promise<void> {
  const run = options.run ?? runCommand;
  const alert = options.alert ?? emitTerminalAlert;
  const exists = options.exists ?? pathExists;
  const system = options.systemConfig;

  if (!(await exists(join(system, "nixos-version")))) {
    throw new Error(`${system} is not a NixOS system build (no nixos-version).`);
  }

  const sudoCheck = await run("sudo", ["-n", "-v"], { inherit: false });
  if (sudoCheck.code !== 0) {
    alert("password-required");
  }

  const env = sudoEnv({});
  const approve = await run(
    "sudo",
    [
      "sh",
      "-c",
      `umask 077 && mkdir -p ${dirname(NIXOS_SWITCH_APPROVAL)} && printf %s "$1" > ${NIXOS_SWITCH_APPROVAL}`,
      "sh",
      system,
    ],
    { inherit: true, env },
  );
  if (approve.code !== 0) {
    throw new Error(`Approving the NixOS switch failed (exit ${approve.code}).`);
  }
  if (sudoCheck.code !== 0) {
    options.resume?.();
  }

  try {
    const setProfile = await run(
      "sudo",
      ["-H", "env", "NIX_PATH=", "nix-env", "-p", "/nix/var/nix/profiles/system", "--set", system],
      { inherit: true, env },
    );
    if (setProfile.code !== 0) {
      throw new Error(`nix-env --set failed (exit ${setProfile.code}).`);
    }
    const activate = await run(
      "sudo",
      [
        "systemd-run",
        "--collect",
        "--no-ask-password",
        "--pipe",
        "--quiet",
        "--wait",
        "--service-type=exec",
        "--unit=outfitting-nixos-switch",
        "--",
        `${system}/bin/switch-to-configuration`,
        "switch",
      ],
      { inherit: true, env },
    );
    if (activate.code !== 0) {
      throw new Error(`switch-to-configuration switch failed (exit ${activate.code}).`);
    }
    await (options.record ?? recordNixosActivation)(system);
  } finally {
    // The pre-switch check consumes the approval; drop it if activation never reached the check.
    await run("sudo", ["rm", "-f", NIXOS_SWITCH_APPROVAL], { inherit: false, env }).catch(
      () => undefined,
    );
  }
}

/**
 * Activate a built Home Manager activationPackage (no sudo).
 * Runs `<pkg>/activate` with OUTFITTING_REPO preserved in the environment.
 */
export async function activateHomeManager(options: ActivateHomeManagerOptions): Promise<void> {
  const run = options.run ?? runCommand;
  const activate = await run(`${options.activationPackage}/activate`, [], {
    inherit: true,
    env: nixEnv(options.repoRoot),
  });
  if (activate.code !== 0) {
    throw new Error(`Home Manager activate failed (exit ${activate.code}).`);
  }
}
