import { readFile } from "node:fs/promises";

import type { OutfittingRepo } from "@/config/repo";
import { runCommand, type RunCommandResult } from "@/process";

export type NixBuildMode = "build" | "test" | "dry";

export interface NixBuildOptions {
  repo: OutfittingRepo;
  /** Remote lock path when available. */
  lockPath?: string;
  /** Write Nix's evaluated lock to this path instead of the source flake. */
  outputLockPath?: string;
  mode: NixBuildMode;
  run?: typeof runCommand;
}

function flakeRef(repo: OutfittingRepo): string {
  return `path:${repo.flakePath}#${repo.systemAttr}`;
}

function baseArgs(
  mode: NixBuildMode,
  lockPath: string | undefined,
  outputLockPath: string | undefined,
): string[] {
  const args = ["build", "--impure", "--no-link"];
  if (mode === "build" || mode === "test") {
    args.push("--print-out-paths");
  }
  if (mode === "dry") {
    args.push("--dry-run", "--no-write-lock-file");
  }
  if (lockPath !== undefined) {
    args.push("--reference-lock-file", lockPath);
  }
  if (outputLockPath !== undefined) {
    args.push("--output-lock-file", outputLockPath);
  } else if (lockPath !== undefined && mode !== "dry") {
    args.push("--no-write-lock-file");
  }
  return args;
}

async function verifyOutputLock(options: NixBuildOptions): Promise<void> {
  if (options.outputLockPath === undefined || options.lockPath === undefined) {
    return;
  }

  let referenceLock: Buffer;
  let buildLock: Buffer;
  try {
    [referenceLock, buildLock] = await Promise.all([
      readFile(options.lockPath),
      readFile(options.outputLockPath),
    ]);
  } catch (cause) {
    throw new Error("Nix build succeeded but did not produce its evaluated flake.lock.", {
      cause,
    });
  }
  if (!referenceLock.equals(buildLock)) {
    throw new Error(
      "Nix resolved a different flake.lock while building; refusing to activate or publish the update.",
    );
  }
}

/**
 * Build (or dry-run) the active flake derivation (nix-darwin system or HM activationPackage).
 * Returns the store path when mode is build|test; empty for dry.
 */
export async function buildNixSystem(options: NixBuildOptions): Promise<string> {
  const run = options.run ?? runCommand;
  if (options.repo.flakePath.length === 0 || options.repo.flakeKind === "none") {
    throw new Error("No Nix flake is declared for the selected BYOR profile.");
  }
  const args = [
    ...baseArgs(options.mode, options.lockPath, options.outputLockPath),
    flakeRef(options.repo),
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OUTFITTING_REPO: options.repo.root,
  };
  delete env.NIX_PATH;

  const result: RunCommandResult = await run("nix", args, {
    inherit: options.mode === "dry",
    env,
  });

  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`nix build failed (exit ${result.code})${detail ? `: ${detail}` : ""}`);
  }

  if (options.mode === "dry") {
    return "";
  }

  await verifyOutputLock(options);

  const outPath = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);

  if (outPath === undefined) {
    throw new Error("nix build succeeded but printed no output path.");
  }
  return outPath;
}
