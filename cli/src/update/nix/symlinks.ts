import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { NixFlakeRepo } from "@/config/repo";
import { isNotFound } from "@/errors";

async function ensureSymlink(linkPath: string, target: string): Promise<void> {
  let existing: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    existing = await lstat(linkPath);
  } catch (cause) {
    if (!isNotFound(cause)) {
      throw cause;
    }
  }

  await mkdir(dirname(linkPath), { recursive: true });
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `Refusing to replace existing non-symlink at ${linkPath}. Move or remove it, then retry.`,
      );
    }
    if ((await readlink(linkPath)) === target) {
      return;
    }
    await rm(linkPath);
  }
  await symlink(target, linkPath);
}

/**
 * Ensure profile symlinks for the active flake.
 * macOS: ~/.nixpkgs/darwin-configuration.nix + ~/.config/home-manager → declared flake root
 * Home Manager: ~/.config/home-manager → declared flake root only
 */
export async function ensureNixSymlinks(repo: NixFlakeRepo, home = homedir()): Promise<void> {
  await mkdir(join(home, ".config"), { recursive: true });
  await ensureSymlink(join(home, ".config", "home-manager"), repo.flakePath);

  if (repo.flakeKind === "macos") {
    await mkdir(join(home, ".nixpkgs"), { recursive: true });
    await ensureSymlink(join(home, ".nixpkgs", "darwin-configuration.nix"), repo.darwinNixPath);
  }
}
