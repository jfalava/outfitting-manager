import { Console, Effect } from "effect";

import {
  configuredProfile,
  ensureStateRoot,
  loadConfig,
  validateOutfittingRepo,
  type OutfittingRepo,
} from "@/config";
import { type ManagerConfig } from "@/config/types";
import { tryPromise } from "@/effect";
import type { ManifestFetcher } from "@/fetch/github";
import { hostPlatform, type HostPlatform } from "@/platform";
import type { runCommand } from "@/process";
import { envValue } from "@/secrets";
import { syncByorSparseSource, validateBackups } from "@/setup/source";
import { validateByorSource } from "@/source/contract";
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

/** Resolve an invocation-local checkout override or the configured TOML source. */
export async function resolveSetupSource(options: SetupOptions): Promise<SetupOptions> {
  const config =
    options.config ??
    (await loadConfig({
      stateRoot: options.stateRoot,
      configPath: options.configPath,
      machineId: options.machineId,
    }));
  const repo = setupRepo(config, options);
  const platform = setupPlatform(options);
  const selectedProfile = configuredProfile(config, platform, options.repoProfile);

  if (config.declarations === undefined) {
    throw new Error(`No profile declarations are configured in ${config.configPath}.`);
  }
  if (repo === undefined && config.source?.kind !== "remote") {
    throw new Error(
      `No source is configured. Set [source] in ${config.configPath} or pass --repo/OUTFITTING_REPO for a local checkout.`,
    );
  }
  return { ...options, repo, platform, repoProfile: selectedProfile, config };
}

/** Materialize the selected source, state root, config, and optional nix symlinks. */
export const runSetup = (input: SetupOptions = {}) =>
  Effect.gen(function* () {
    const options = yield* tryPromise(() => resolveSetupSource(input));
    const root = yield* tryPromise(() =>
      options.stateRoot === undefined ? ensureStateRoot() : ensureStateRoot(options.stateRoot),
    );
    const config =
      options.config ??
      (yield* tryPromise(() =>
        loadConfig({
          stateRoot: root,
          configPath: options.configPath,
          machineId: options.machineId,
        }),
      ));
    yield* Console.log(ui.success(`State root ready: ${config.stateRoot}`));
    yield* Console.log(ui.muted(`machine id: ${config.machineId}`));
    yield* Console.log(ui.muted(`config: ${config.configPath}`));

    let selectedRepo = options.repo;
    if (selectedRepo === undefined) {
      yield* Console.log(
        ui.heading(
          options.refreshSource === false || options.offline === true
            ? "Validating cached source…"
            : "Refreshing remote source…",
        ),
      );
      const source = yield* tryPromise(() =>
        syncByorSparseSource({
          config,
          platform: options.platform!,
          profile: options.repoProfile,
          sourceRoot: options.sourceRoot,
          fetcher: options.fetcher,
          run: options.run,
          offline: options.offline || options.refreshSource === false,
        }),
      );
      selectedRepo = source.root;
      for (const item of source.files) {
        yield* Console.log(ui.success(`${item.path} (${item.source}) → ${source.root}`));
      }
    }

    const platform = options.platform!;
    if (options.repo !== undefined) {
      // A synced remote source was already validated by syncByorSparseSource.
      yield* tryPromise(async () => {
        await validateBackups(selectedRepo!, { config, platform });
        await validateByorSource(
          selectedRepo!,
          platform,
          options.repoProfile,
          config.declarations!,
        );
      });
    }

    const selected = yield* tryPromise(() =>
      validateOutfittingRepo(selectedRepo!, {
        contract: config.declarations!,
        profile: options.repoProfile,
        platform,
      }),
    );
    yield* Console.log(ui.success(`Source path: ${selected.root}`));

    if (options.ensureSymlinks !== undefined && options.skipSymlinks !== true) {
      yield* tryPromise(() => options.ensureSymlinks!(selected));
      yield* Console.log(ui.success(`nix-darwin symlinks ensured for ${selected.root}`));
    }

    yield* Console.log("");
    yield* Console.log(ui.muted(options.nextCommand ?? "Next: outfitting-manager apply"));
    return selected;
  });
