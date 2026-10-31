import type { NixAction } from "@/platform";

export type { NixAction };

export const NIX_LOCK_KIND = "nix";

/** Environment for Nix commands: exposes the repository and ignores channel lookups. */
export function nixEnv(repoRoot: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OUTFITTING_REPO: repoRoot };
  delete env.NIX_PATH;
  return env;
}

export type NixRecoveryPhase = "prepared" | "activated";

export const NIX_RECOVERY_PHASES = [
  "prepared",
  "activated",
] as const satisfies readonly NixRecoveryPhase[];

export function isNixRecoveryPhase(value: string): value is NixRecoveryPhase {
  return (NIX_RECOVERY_PHASES as readonly string[]).includes(value);
}
