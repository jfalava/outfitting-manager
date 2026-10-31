import { access, chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { Schema } from "effect";

import { isNotFound } from "@/errors";
import { envValue } from "@/secrets";
import { isNixRecoveryPhase, type NixRecoveryPhase } from "@/update/nix/types";

const NixRecoveryContextSchema = Schema.Struct({
  machine: Schema.String,
  platform: Schema.Literals(["linux", "macos"] as const),
  profile: Schema.optionalKey(Schema.String),
  /** Pinned store path built before activation; recovery never rebuilds. */
  systemConfig: Schema.String,
  /** Repository exposed to Home Manager activation as OUTFITTING_REPO. */
  repoRoot: Schema.String,
});
const decodeNixRecoveryContext = Schema.decodeUnknownSync(NixRecoveryContextSchema);
type NixRecoveryContext = Schema.Schema.Type<typeof NixRecoveryContextSchema>;

export interface NixRecoveryState extends NixRecoveryContext {
  dir: string;
  lockPath: string;
  /** SHA-256 of the remote lock the update started from; absent when none existed. */
  baseHash?: string;
  phase: NixRecoveryPhase;
}

const BASE_HASH = /^[0-9a-f]{64}$/;

function unsupportedCheckpoint(dir: string, cause?: unknown): Error {
  return new Error(
    `Unsupported Nix recovery checkpoint at ${dir} (written by an older outfitting-manager or damaged); inspect it, then run 'outfitting-manager recover nix --clear' before retrying.`,
    { cause },
  );
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
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
  } catch (cause) {
    if (isNotFound(cause)) {
      return false;
    }
    throw cause;
  }
}

export async function readNixRecovery(
  dir = defaultNixRecoveryDir(),
): Promise<NixRecoveryState | undefined> {
  const phaseRaw = await readOptionalFile(join(dir, "phase"));
  if (phaseRaw === undefined) {
    return undefined;
  }
  const phase = phaseRaw.trim();
  if (!isNixRecoveryPhase(phase)) {
    throw new Error(`Unknown Nix recovery phase: ${phase}`);
  }
  const lockPath = join(dir, "flake.lock");
  let context: NixRecoveryContext;
  let baseHash: string | undefined;
  try {
    await access(lockPath);
    const [contextRaw, baseHashRaw] = await Promise.all([
      readFile(join(dir, "context.json"), "utf8"),
      readOptionalFile(join(dir, "base-hash")),
    ]);
    context = decodeNixRecoveryContext(JSON.parse(contextRaw));
    baseHash = baseHashRaw?.trim();
  } catch (cause) {
    throw unsupportedCheckpoint(dir, cause);
  }
  if (
    !isAbsolute(context.systemConfig) ||
    !isAbsolute(context.repoRoot) ||
    (baseHash !== undefined && !BASE_HASH.test(baseHash))
  ) {
    throw unsupportedCheckpoint(dir);
  }
  return { ...context, dir, lockPath, baseHash, phase };
}

/**
 * Atomically stage a recovery checkpoint (prepared).
 * Fails if a checkpoint directory already exists.
 */
export async function prepareNixRecovery({
  lockPath,
  baseHash,
  recoveryDir = defaultNixRecoveryDir(),
  ...context
}: NixRecoveryContext & {
  lockPath: string;
  baseHash?: string;
  recoveryDir?: string;
}): Promise<NixRecoveryState> {
  if (await hasNixRecovery(recoveryDir)) {
    throw new Error(
      `An unfinished Nix upgrade already exists at ${recoveryDir}. Run 'outfitting-manager recover nix' (or --clear to abandon it) before continuing.`,
    );
  }

  const parent = dirname(recoveryDir);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, ".nix-lock-recovery."));
  await chmod(staging, 0o700);

  try {
    await writeFile(join(staging, "flake.lock"), await readFile(lockPath), { mode: 0o600 });
    if (baseHash !== undefined) {
      await writeFile(join(staging, "base-hash"), `${baseHash}\n`, { mode: 0o600 });
    }
    await writeFile(join(staging, "phase"), "prepared\n", { mode: 0o600 });
    await writeFile(join(staging, "context.json"), `${JSON.stringify(context)}\n`, {
      mode: 0o600,
    });
    await rename(staging, recoveryDir);
  } catch (cause) {
    await rm(staging, { force: true, recursive: true });
    throw cause;
  }

  return {
    ...context,
    dir: recoveryDir,
    lockPath: join(recoveryDir, "flake.lock"),
    baseHash,
    phase: "prepared",
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
