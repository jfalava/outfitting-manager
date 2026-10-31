import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import type { ManagerConfig } from "@/config";
import { physicalPath } from "@/config/repo";
import { CliFailure, errorMessage } from "@/errors";
import { pullLockfile } from "@/sync";
import { WorkerResponseError } from "@/sync/request";
import { NIX_LOCK_KIND } from "@/update/nix/types";

export interface OpenedNixLock {
  /** Physical temp directory holding flake.lock; release it with `closeNixLock`. */
  lockDir: string;
  /** Path to the pulled or fallback flake.lock. */
  lockPath: string;
  /** Where the selected lock came from. */
  source: "remote" | "fallback";
  /** SHA-256 of the remote lock, for compare-and-swap publication. */
  baseHash?: string;
  /** Warning emitted when the remote lock was unavailable. */
  warning?: string;
}

/** Neither a remote nor a local lock exists yet (only with `allowMissing`). */
export interface MissingNixLock {
  lockDir?: undefined;
  lockPath?: undefined;
  source: "missing";
  baseHash?: undefined;
  warning: string;
}

export type NixLock = OpenedNixLock | MissingNixLock;

export interface OpenNixLockOptions {
  /** Local lock to stage when the remote head does not exist. */
  fallbackPath?: string;
  /** Continue without a lock when neither remote nor local state exists. */
  allowMissing?: boolean;
  /** Treat remote failures other than a missing lock as fatal. */
  failOnRemoteError?: boolean;
}

function responseStatus(cause: unknown): number | undefined {
  let current: unknown = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    if (Schema.is(WorkerResponseError)(current)) {
      return current.status;
    }
    if (current instanceof Error && "cause" in current) {
      current = current.cause;
      continue;
    }
    if (current instanceof CliFailure && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Pull the remote nix lock into a physical temp path.
 * Caller must invoke `closeNixLock` when done.
 */
export function openNixLock(
  config: ManagerConfig,
  pull?: typeof pullLockfile,
  options?: OpenNixLockOptions & { allowMissing?: false },
): Promise<OpenedNixLock>;
export function openNixLock(
  config: ManagerConfig,
  pull: typeof pullLockfile,
  options: OpenNixLockOptions,
): Promise<NixLock>;
export async function openNixLock(
  config: ManagerConfig,
  pull: typeof pullLockfile = pullLockfile,
  options: OpenNixLockOptions = {},
): Promise<NixLock> {
  const displayDir = await mkdtemp(join(tmpdir(), "outfitting-nix-lock-"));
  let lockDir: string;
  try {
    lockDir = await physicalPath(displayDir);
  } catch {
    await rm(displayDir, { force: true, recursive: true });
    throw new Error("Could not resolve a physical temporary Nix lock directory.");
  }

  const lockPath = join(lockDir, "flake.lock");

  try {
    await Effect.runPromise(
      pull({
        machine: config.machineId,
        kind: NIX_LOCK_KIND,
        outPath: lockPath,
      }),
    );
    const lock = await readFile(lockPath);
    return {
      lockDir,
      lockPath,
      source: "remote",
      baseHash: createHash("sha256").update(lock).digest("hex"),
    };
  } catch (cause) {
    const message = errorMessage(cause);
    const status = responseStatus(cause);

    if (options.failOnRemoteError && status !== 404) {
      await closeNixLock(lockDir);
      throw new Error(
        `Could not pull the remote Nix lock for ${config.machineId}: ${message}. Check the lockfile service configuration and connectivity, then retry.`,
        { cause },
      );
    }

    if (options.fallbackPath !== undefined) {
      try {
        await copyFile(options.fallbackPath, lockPath);
        return {
          lockDir,
          lockPath,
          source: "fallback",
          warning: `Remote Nix lock unavailable (${message}); using the local flake.lock and will publish it after success.`,
        };
      } catch {
        // Keep the original remote error below when the local fallback is also unavailable.
      }
    }

    if (options.allowMissing) {
      await closeNixLock(lockDir);
      return {
        source: "missing",
        warning: `Remote Nix lock unavailable (${message}); continuing with the local flake and will publish its lock after success.`,
      };
    }

    await closeNixLock(lockDir);
    throw new Error(
      `Could not pull the required remote Nix lock for ${config.machineId}: ${message}. Check the lockfile service configuration and connectivity, then retry.`,
      { cause },
    );
  }
}

export async function closeNixLock(lockDir: string): Promise<void> {
  await rm(lockDir, { force: true, recursive: true });
}
