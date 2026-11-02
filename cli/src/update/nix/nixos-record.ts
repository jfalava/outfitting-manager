import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { isNotFound } from "@/errors";
import { envValue } from "@/secrets";

/** Last NixOS system outfitting-manager activated, used to detect out-of-band switches. */
export function defaultNixosRecordPath(home = homedir()): string {
  const stateHome = envValue("XDG_STATE_HOME") ?? join(home, ".local", "state");
  return join(stateHome, "outfitting", "nixos-activation");
}

export async function recordNixosActivation(
  system: string,
  path = defaultNixosRecordPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${system}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export interface NixosDrift {
  recorded: string;
  /** Whether the running system or the system profile differs from the recorded one. */
  changed: boolean;
  /** Booted generation target the system profile points at. */
  profile: string | undefined;
  /** Running system. */
  current: string | undefined;
}

async function resolved(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
}

/**
 * Compare the running system and system profile with the last activation this CLI
 * recorded. Returns undefined when no activation has been recorded yet.
 */
export async function nixosDrift(
  options: { recordPath?: string; currentPath?: string; profilePath?: string } = {},
): Promise<NixosDrift | undefined> {
  let recorded: string | undefined;
  try {
    recorded = (await readFile(options.recordPath ?? defaultNixosRecordPath(), "utf8")).trim();
  } catch (cause) {
    if (!isNotFound(cause)) {
      throw cause;
    }
  }
  if (recorded === undefined || recorded.length === 0) {
    return undefined;
  }
  const current = await resolved(options.currentPath ?? "/run/current-system");
  const profile = await resolved(options.profilePath ?? "/nix/var/nix/profiles/system");
  return { recorded, current, profile, changed: current !== recorded || profile !== recorded };
}

export function describeNixosDrift(drift: NixosDrift): string {
  return [
    "The NixOS system changed outside outfitting-manager.",
    `  last activated by outfitting-manager: ${drift.recorded}`,
    `  running (/run/current-system):        ${drift.current ?? "missing"}`,
    `  system profile:                       ${drift.profile ?? "missing"}`,
    "Run `outfitting-manager nix switch` on this host to return to the managed system.",
  ].join("\n");
}
