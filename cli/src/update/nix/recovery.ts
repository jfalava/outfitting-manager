import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Schema } from "effect";

import { envValue } from "@/secrets";
import { isNixRecoveryPhase, type NixRecoveryPhase } from "@/update/nix/types";

export interface NixRecoveryState {
  dir: string;
  lockPath: string;
  baseHash: string;
  phase: NixRecoveryPhase;
  machine?: string;
  platform?: "linux" | "macos";
  profile?: string;
  systemConfig?: string;
  repoRoot?: string;
}

const NixRecoveryContextSchema = Schema.Struct({
  machine: Schema.optionalKey(Schema.String),
  platform: Schema.optionalKey(Schema.Literals(["linux", "macos"] as const)),
  profile: Schema.optionalKey(Schema.String),
  systemConfig: Schema.optionalKey(Schema.String),
  repoRoot: Schema.optionalKey(Schema.String),
});
const decodeNixRecoveryContext = Schema.decodeUnknownSync(NixRecoveryContextSchema);
type NixRecoveryContext = Schema.Schema.Type<typeof NixRecoveryContextSchema>;

function isNotFound(cause: unknown): boolean {
  return (
    cause instanceof Error && "code" in cause && (cause as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function readRecoveryContext(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
}

function decodeRecoveryContext(raw: string | undefined): NixRecoveryContext | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(raw);
  return decodeNixRecoveryContext(parsed);
}

export function defaultNixRecoveryDir(home = homedir()): string {
  const xdg = envValue("XDG_STATE_HOME");
  const stateHome = xdg ?? join(home, ".local", "state");
  return join(stateHome, "outfitting", "nix-lock-recovery");
}

export async function hasNixRecovery(dir = defaultNixRecoveryDir()): Promise<boolean> {
  try {
    const phase = await readFile(join(dir, "phase"), "utf8");
    return phase.trim().length > 0;
  } catch {
    return false;
  }
}

export async function readNixRecovery(
  dir = defaultNixRecoveryDir(),
): Promise<NixRecoveryState | undefined> {
  try {
    const [lockBody, baseHashRaw, phaseRaw, contextRaw] = await Promise.all([
      readFile(join(dir, "flake.lock")),
      readFile(join(dir, "base-hash"), "utf8"),
      readFile(join(dir, "phase"), "utf8"),
      readRecoveryContext(join(dir, "context.json")),
    ]);
    void lockBody;
    const phase = phaseRaw.trim();
    if (!isNixRecoveryPhase(phase)) {
      throw new Error(`Unknown Nix recovery phase: ${phase}`);
    }
    const context = decodeRecoveryContext(contextRaw);
    const state: NixRecoveryState = {
      ...context,
      dir,
      lockPath: join(dir, "flake.lock"),
      baseHash: baseHashRaw.trim(),
      phase,
    };
    return state;
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
}

/**
 * Atomically stage a recovery checkpoint (prepared).
 * Fails if a checkpoint directory already exists.
 */
export async function prepareNixRecovery(params: {
  lockPath: string;
  baseHash: string;
  machine?: string;
  platform?: "linux" | "macos";
  profile?: string;
  systemConfig?: string;
  repoRoot?: string;
  recoveryDir?: string;
}): Promise<NixRecoveryState> {
  const recoveryDir = params.recoveryDir ?? defaultNixRecoveryDir();
  if (await hasNixRecovery(recoveryDir)) {
    throw new Error(
      `An unfinished Nix upgrade already exists at ${recoveryDir}. Recover or clear it before continuing.`,
    );
  }

  const parent = dirname(recoveryDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".nix-lock-recovery."));
  await chmod(staging, 0o700);

  try {
    const lockBytes = await readFile(params.lockPath);
    await writeFile(join(staging, "flake.lock"), lockBytes, { mode: 0o600 });
    await writeFile(join(staging, "base-hash"), `${params.baseHash}\n`, {
      mode: 0o600,
    });
    await writeFile(join(staging, "phase"), "prepared\n", { mode: 0o600 });
    if (
      params.machine !== undefined ||
      params.platform !== undefined ||
      params.profile !== undefined ||
      params.systemConfig !== undefined ||
      params.repoRoot !== undefined
    ) {
      await writeFile(
        join(staging, "context.json"),
        `${JSON.stringify({
          machine: params.machine,
          platform: params.platform,
          profile: params.profile,
          systemConfig: params.systemConfig,
          repoRoot: params.repoRoot,
        })}\n`,
        { mode: 0o600 },
      );
    }
    await rename(staging, recoveryDir);
  } catch (cause) {
    await rm(staging, { force: true, recursive: true });
    throw cause;
  }

  return {
    dir: recoveryDir,
    lockPath: join(recoveryDir, "flake.lock"),
    baseHash: params.baseHash,
    phase: "prepared",
    machine: params.machine,
    platform: params.platform,
    profile: params.profile,
    systemConfig: params.systemConfig,
    repoRoot: params.repoRoot,
  };
}

export async function setNixRecoveryPhase(
  phase: NixRecoveryPhase,
  recoveryDir = defaultNixRecoveryDir(),
): Promise<void> {
  const tmp = join(recoveryDir, `.phase.${process.pid}`);
  await writeFile(tmp, `${phase}\n`, { mode: 0o600 });
  await rename(tmp, join(recoveryDir, "phase"));
}

export async function clearNixRecovery(recoveryDir = defaultNixRecoveryDir()): Promise<void> {
  await rm(recoveryDir, { force: true, recursive: true });
}

/** Pure transition table for recovery phases (used by recover + tests). */
export function nextRecoveryAction(phase: NixRecoveryPhase): "activate" | "publish" {
  switch (phase) {
    case "prepared":
      return "activate";
    case "activated":
      return "publish";
    default: {
      const exhaustive: never = phase;
      return exhaustive;
    }
  }
}
