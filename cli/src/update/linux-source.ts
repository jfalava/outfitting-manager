import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { configuredProfile, type ManagerConfig } from "@/config";
import { validateOutfittingRepo, type OutfittingRepo } from "@/config/repo";
import type { ManifestFetcher } from "@/fetch/github";
import { platformLabel } from "@/platform";
import { runCommand } from "@/process";
import { envValue } from "@/secrets";
import { syncByorSparseSource } from "@/setup/source";
import { profileNames, validateByorSource, validateLinuxByorSource } from "@/source/contract";
import { isProfileName } from "@/source/profile-name";

export interface LinuxSourceOptions {
  config: ManagerConfig;
  profile: string;
  /** NixOS shares the Linux source flow but validates its own profile kind. */
  platform?: "linux" | "nixos";
  refresh?: boolean;
  fetcher?: ManifestFetcher;
  run?: typeof runCommand;
}

export interface LinuxSource {
  root: string;
  mode: "sparse" | "checkout";
  repo: OutfittingRepo;
}

/**
 * Select the Linux (or NixOS) profile: `override`, OUTFITTING_PROFILE, `<platform>.profile`
 * in config.toml, or the only declared profile for that platform.
 */
export function resolveLinuxProfile(
  config: ManagerConfig,
  override: string | undefined,
  platform: "linux" | "nixos" = "linux",
): string {
  const label = platformLabel(platform);
  const declared = profileNames(config.declarations, platform);
  const profile =
    configuredProfile(config, platform, override) ??
    (declared.length === 1 ? declared[0] : undefined);
  if (profile === undefined) {
    const choices = declared.length > 1 ? ` (${declared.join(", ")})` : "";
    throw new Error(
      `No ${label} BYOR profile is selected. Set ${platform}.profile in config.toml or pass --profile${choices}.`,
    );
  }
  if (!isProfileName(profile)) {
    throw new Error(
      `Invalid ${label} profile \`${profile}\`. Use letters, numbers, ., _, and - only.`,
    );
  }
  return profile;
}

function selectedLocalRoot(config: ManagerConfig): string | undefined {
  return (
    envValue("OUTFITTING_REPO") ??
    (config.source?.kind === "local" ? config.source.path : undefined)
  );
}

/** Use local checkouts directly; otherwise fetch the TOML-declared remote source. */
export async function prepareLinuxSource(options: LinuxSourceOptions): Promise<LinuxSource> {
  const platform = options.platform ?? "linux";
  const localRoot = selectedLocalRoot(options.config);
  if (localRoot !== undefined) {
    if (options.config.declarations === undefined) {
      throw new Error(`No profile declarations are configured in ${options.config.configPath}.`);
    }
    const repo = await validateOutfittingRepo(localRoot, {
      profile: options.profile,
      contract: options.config.declarations,
      platform,
    });
    await validateByorSource(repo.root, platform, options.profile, options.config.declarations);
    return { root: repo.root, mode: "checkout", repo };
  }

  const source = await syncByorSparseSource({
    config: options.config,
    platform,
    profile: options.profile,
    fetcher: options.fetcher,
    run: options.run,
    offline: options.refresh !== true,
  });
  const repo = await validateOutfittingRepo(source.root, {
    profile: options.profile,
    contract: options.config.declarations!,
    platform,
  });
  return { root: source.root, mode: "sparse", repo };
}

/** Read a Linux package declaration from the selected validated TOML source. */
export async function readLinuxManifest(
  config: ManagerConfig,
  profile: string,
  sourceRoot?: string,
  packageManager?: "apt" | "pacman",
): Promise<string> {
  if (config.declarations === undefined) {
    throw new Error(`No profile declarations are configured in ${config.configPath}.`);
  }
  let root = sourceRoot ?? selectedLocalRoot(config);
  if (root === undefined) {
    const source = await syncByorSparseSource({
      config,
      platform: "linux",
      profile,
      offline: true,
    });
    root = source.root;
  }
  const absolute = await realpath(isAbsolute(root) ? root : resolve(root));
  const validated = await validateLinuxByorSource({
    root: absolute,
    profile,
    contract: config.declarations,
  });
  const manager =
    packageManager ??
    (["apt", "pacman"] as const).find((candidate) => validated.linux[candidate] !== undefined);
  if (manager === undefined || validated.linux[manager] === undefined) {
    throw new Error(
      `BYOR profile \`${profile}\` does not declare a ${packageManager ?? "native"} package manifest.`,
    );
  }
  return readFile(join(absolute, validated.linux[manager].manifest), "utf8");
}
