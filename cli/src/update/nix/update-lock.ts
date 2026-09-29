import { access } from "node:fs/promises";

import type { OutfittingRepo } from "@/config/repo";
import { runCommand, type RunCommandResult } from "@/process";

export interface UpdateNixLockOptions {
  repo: OutfittingRepo;
  referenceLockPath?: string;
  outputLockPath: string;
  run?: typeof runCommand;
}

/** Update every input in the selected flake into an isolated candidate lock. */
export async function updateNixLock(options: UpdateNixLockOptions): Promise<void> {
  const run = options.run ?? runCommand;
  if (options.repo.flakeKind === "none" || options.repo.flakePath.length === 0) {
    throw new Error("No Nix flake is declared for the selected BYOR profile.");
  }

  const args = ["flake", "update", "--impure"];
  if (options.referenceLockPath !== undefined) {
    args.push("--reference-lock-file", options.referenceLockPath);
  }
  args.push("--output-lock-file", options.outputLockPath);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OUTFITTING_REPO: options.repo.root,
  };
  delete env.NIX_PATH;

  const result: RunCommandResult = await run("nix", args, {
    cwd: options.repo.flakePath,
    env,
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
