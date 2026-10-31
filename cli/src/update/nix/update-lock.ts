import { access } from "node:fs/promises";

import type { NixFlakeRepo } from "@/config/repo";
import { runCommand, type RunCommandResult } from "@/process";
import { nixEnv } from "@/update/nix/types";

export interface UpdateNixLockOptions {
  repo: NixFlakeRepo;
  referenceLockPath?: string;
  outputLockPath: string;
  run?: typeof runCommand;
}

/** Update every input in the selected flake into an isolated candidate lock. */
export async function updateNixLock(options: UpdateNixLockOptions): Promise<void> {
  const run = options.run ?? runCommand;

  const args = ["flake", "update", "--impure"];
  if (options.referenceLockPath !== undefined) {
    args.push("--reference-lock-file", options.referenceLockPath);
  }
  args.push("--output-lock-file", options.outputLockPath);

  const result: RunCommandResult = await run("nix", args, {
    cwd: options.repo.flakePath,
    env: nixEnv(options.repo.root),
  });

  if (result.code !== 0) {
    throw new Error(`nix flake update failed (exit ${result.code}).`);
  }

  try {
    await access(options.outputLockPath);
  } catch {
    throw new Error("nix flake update succeeded but produced no candidate flake.lock.");
  }
}
