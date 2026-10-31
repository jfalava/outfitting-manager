import { Console, Effect } from "effect";

import {
  configuredProfile,
  ensureStateRoot,
  loadConfig,
  validateOutfittingRepo,
  type OutfittingRepo,
} from "@/config";
import type { ManagerConfig } from "@/config/types";
import { tryPromise } from "@/effect";
import type { ManifestFetcher } from "@/fetch/github";
import { hostPlatform, type HostPlatform } from "@/platform";
import type { runCommand } from "@/process";
import { envValue } from "@/secrets";
import { syncByorSparseSource, validateBackups } from "@/setup/source";
import { validateByorSource, type ByorContract } from "@/source/contract";
import { ui } from "@/ui";

export interface SetupOptions {
  /** Explicit platform for platform-specific entrypoints, including cross-platform tests. */
  platform?: HostPlatform;
  machineId?: string;
  /** Local checkout override. It takes precedence over the TOML source for this invocation. */
  repo?: string;
  /** Profile used to select and validate repository-owned configuration. */
  repoProfile?: string;
  /** Refresh the configured remote Git source; defaults to true. */
  refreshSource?: boolean;
  sourceRoot?: string;
  skipSymlinks?: boolean;
  ensureSymlinks?: (repo: OutfittingRepo) => Promise<void>;
  nextCommand?: string;
  stateRoot?: string;
  configPath?: string;
  config?: ManagerConfig;
  fetcher?: ManifestFetcher;
  run?: typeof runCommand;
  offline?: boolean;
}

function setupPlatform(options: SetupOptions): HostPlatform {
  return options.platform ?? hostPlatform();
}

function setupRepo(config: ManagerConfig, options: SetupOptions): string | undefined {
  const explicitRepo = options.repo ?? envValue("OUTFITTING_REPO");
  if (explicitRepo !== undefined) {
    return explicitRepo;
  }
  return config.source?.kind === "local" ? config.source.path : undefined;
}

export interface ResolvedSetupSource {
  config: ManagerConfig;
  contract: ByorContract;
  platform: HostPlatform;
  /** Local checkout (override or `[source] path`); undefined selects the remote source cache. */
  repo: string | undefined;
  repoProfile: string | undefined;
}

/** Resolve an invocation-local checkout override or the configured TOML source. */
export async function resolveSetupSource(options: SetupOptions): Promise<ResolvedSetupSource> {
  const config =
    options.config ??
    (await loadConfig({
      stateRoot: options.stateRoot,
      configPath: options.configPath,
      machineId: options.machineId,
    }));
  const repo = setupRepo(config, options);
  const platform = setupPlatform(options);

  if (config.declarations === undefined) {
    throw new Error(`No profile declarations are configured in ${config.configPath}.`);
  }
  if (repo === undefined && config.source?.kind !== "remote") {
    throw new Error(
      `No source is configured. Set [source] in ${config.configPath} or pass --repo/OUTFITTING_REPO for a local checkout.`,
    );
  }
  return {
    config,
    contract: config.declarations,
    platform,
    repo,
    repoProfile: configuredProfile(config, platform, options.repoProfile),
  };
}

/** Refresh (or, offline, revalidate) the configured remote source cache and return its root. */
function syncRemoteSource(options: SetupOptions, source: ResolvedSetupSource) {
  return Effect.gen(function* () {
    const offline = options.offline === true || options.refreshSource === false;
    yield* Console.log(
      ui.heading(offline ? "Validating cached source…" : "Refreshing remote source…"),
    );
    const synced = yield* tryPromise(() =>
      syncByorSparseSource({
        config: source.config,
        platform: source.platform,
        profile: source.repoProfile,
        sourceRoot: options.sourceRoot,
        fetcher: options.fetcher,
        run: options.run,
        offline,
      }),
    );
    for (const item of synced.files) {
      yield* Console.log(ui.success(`${item.path} (${item.source}) → ${synced.root}`));
    }
    return synced.root;
  });
}

/** Validate a local checkout; a synced remote source is validated by syncByorSparseSource. */
function validateLocalSource(root: string, source: ResolvedSetupSource) {
  return tryPromise(async () => {
    await validateBackups(root, { config: source.config, platform: source.platform });
    await validateByorSource(root, source.platform, source.repoProfile, source.contract);
    return root;
  });
}

/** Materialize the selected source, state root, config, and optional nix symlinks. */
export const runSetup = (options: SetupOptions = {}) =>
  Effect.gen(function* () {
    const source = yield* tryPromise(() => resolveSetupSource(options));
    const { config } = source;
    yield* tryPromise(() => ensureStateRoot(config.stateRoot));
    yield* Console.log(ui.success(`State root ready: ${config.stateRoot}`));
    yield* Console.log(ui.muted(`machine id: ${config.machineId}`));
    yield* Console.log(ui.muted(`config: ${config.configPath}`));

    const root =
      source.repo === undefined
        ? yield* syncRemoteSource(options, source)
        : yield* validateLocalSource(source.repo, source);
    const selected = yield* tryPromise(() =>
      validateOutfittingRepo(root, {
        contract: source.contract,
        profile: source.repoProfile,
        platform: source.platform,
      }),
    );
    yield* Console.log(ui.success(`Source path: ${selected.root}`));

    const { ensureSymlinks } = options;
    if (ensureSymlinks !== undefined && options.skipSymlinks !== true) {
      yield* tryPromise(() => ensureSymlinks(selected));
      yield* Console.log(ui.success(`nix-darwin symlinks ensured for ${selected.root}`));
    }

    yield* Console.log("");
    yield* Console.log(ui.muted(options.nextCommand ?? "Next: outfitting-manager apply"));
    return selected;
  });
