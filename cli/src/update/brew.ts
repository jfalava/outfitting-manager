import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Console, Effect } from "effect";

import { configuredProfile, loadConfig, resolveOutfittingRepo, type ManagerConfig } from "@/config";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { runCommand, which } from "@/process";
import { selectMacosByorProfile, type ByorContract } from "@/source/contract";
import { setTerminalPhase, TerminalSession } from "@/terminal-alert";
import { ui } from "@/ui";
import { logCommandOutput, withProgress, type ProgressRenderer } from "@/ui/progress";
import { pushHomebrewInventory } from "@/update/snapshot";

export interface BrewfileManifest {
  taps: string[];
  formulae: string[];
  casks: string[];
}

/** Parse the direct Homebrew entries understood by the manager. */
export function parseBrewfileManifest(brewfile: string): BrewfileManifest {
  const manifest: BrewfileManifest = { taps: [], formulae: [], casks: [] };
  const seen = {
    taps: new Set<string>(),
    formulae: new Set<string>(),
    casks: new Set<string>(),
  };
  const pattern = /^\s*(tap|brew|cask)\s+['"]([^'"]+)['"]/gm;

  for (const match of brewfile.matchAll(pattern)) {
    const kind = match[1];
    const name = match[2]?.trim();
    if (name === undefined || name.length === 0) {
      continue;
    }
    const key = kind === "tap" ? "taps" : kind === "brew" ? "formulae" : "casks";
    if (seen[key].has(name.toLowerCase())) {
      continue;
    }
    seen[key].add(name.toLowerCase());
    manifest[key].push(name);
  }

  return manifest;
}

/** Extract tap names from Brewfile lines like `tap "owner/name", trusted: true`. */
export function parseBrewfileTaps(brewfile: string): string[] {
  return parseBrewfileManifest(brewfile).taps;
}

function trustTaps(
  taps: ReadonlyArray<string>,
  run: typeof runCommand,
  progress: ProgressRenderer,
) {
  return Effect.gen(function* () {
    for (const tap of taps) {
      yield* progress.track(
        `Trusting tap ${tap}`,
        tryPromise(() => run("brew", ["trust", "--tap", tap], { inherit: false })).pipe(
          Effect.tap((result) => {
            const output = `${result.stdout}${result.stderr}`.trim();
            return Effect.sync(() => {
              if (!output.includes("Already trusted")) {
                logCommandOutput(progress, result);
              }
            });
          }),
        ),
      );
    }
  });
}

/** Select the macOS profile and the absolute path of the Brewfile it declares, if any. */
export function declaredBrewfile(
  root: string,
  contract: ByorContract,
  profile: string | undefined,
) {
  const selected = selectMacosByorProfile(contract, profile);
  const brewfile = selected.macos.brewfile;
  return {
    profile: selected.name,
    path: brewfile === undefined ? undefined : join(root, brewfile),
  };
}

/** Resolve the configured source, then the Brewfile its selected macOS profile declares. */
export async function resolveDeclaredBrewfile(config: ManagerConfig, profile: string | undefined) {
  const repo = await resolveOutfittingRepo({ config, profile, platform: "macos" });
  return declaredBrewfile(repo.root, repo.contract, configuredProfile(config, "macos", profile));
}

async function resolveBrewfile(
  options: Pick<UpdateBrewOptions, "brewfilePath" | "profile">,
  config: ManagerConfig,
): Promise<{ path: string; text: string }> {
  if (options.brewfilePath !== undefined) {
    return {
      path: options.brewfilePath,
      text: await readFile(options.brewfilePath, "utf8"),
    };
  }
  const brewfile = await resolveDeclaredBrewfile(config, options.profile);
  if (brewfile.path === undefined) {
    throw new Error(`BYOR macOS profile \`${brewfile.profile}\` does not declare a Brewfile.`);
  }
  return { path: brewfile.path, text: await readFile(brewfile.path, "utf8") };
}

export interface UpdateBrewOptions {
  config?: ManagerConfig;
  /** Skip inventory push after success. */
  noPush?: boolean;
  /** Override the Brewfile selected by the repository contract. */
  brewfilePath?: string;
  profile?: string;
  /** Injected for tests. */
  run?: typeof runCommand;
  which?: typeof which;
}

export interface ApplyBrewOptions<ConfirmR = never> extends Omit<UpdateBrewOptions, "noPush"> {
  /** Stop with an error when Homebrew Bundle fails during apply. */
  strict?: boolean;
  /** After a successful install, remove everything `brew bundle cleanup` reports as undeclared. */
  prune?: boolean;
  /** Prune without prompting. */
  yes?: boolean;
  confirm?: Effect.Effect<boolean, never, ConfirmR>;
}

export interface BrewPruneRemoval {
  /** The dry-run section without its `Would ` prefix, such as `uninstall casks` or `untap`. */
  action: string;
  name: string;
}

/**
 * Read the removals from `brew bundle cleanup` dry-run output (non-TTY, one item per line).
 * The `brew cleanup` cache section is skipped because it never removes a package.
 */
export function parseBundleCleanupPlan(output: string): BrewPruneRemoval[] {
  const removals: BrewPruneRemoval[] = [];
  let action: string | undefined;
  for (const line of output.split("\n")) {
    const heading = /^Would (uninstall .+|untap):$/.exec(line);
    if (heading !== null) {
      action = heading[1];
    } else if (line.startsWith("Would ") || line.startsWith("Run `")) {
      action = undefined;
    } else if (action !== undefined && line.trim().length > 0) {
      removals.push({ action, name: line.trim() });
    }
  }
  return removals;
}

const pruneBrew = <ConfirmR>(
  brewfilePath: string,
  run: typeof runCommand,
  options: ApplyBrewOptions<ConfirmR>,
) =>
  Effect.gen(function* () {
    yield* setTerminalPhase("Planning Homebrew prune");
    const dryRun = yield* tryPromise(() =>
      run("brew", ["bundle", "cleanup", `--file=${brewfilePath}`], { inherit: false }),
    );
    const removals = parseBundleCleanupPlan(dryRun.stdout);
    if (removals.length === 0) {
      // The dry run exits 1 only when it would remove something, so any other failure is real.
      if (dryRun.code !== 0) {
        return yield* new CliFailure({
          message: `brew bundle cleanup failed (exit ${dryRun.code}): ${`${dryRun.stderr}${dryRun.stdout}`.trim()}`,
        });
      }
      yield* Console.log(
        ui.muted("Nothing to prune; every installed Homebrew package is declared."),
      );
      return;
    }
    yield* Console.log(ui.heading("Homebrew packages to be removed:"));
    for (const removal of removals) {
      yield* Console.log(`  ${removal.action}: ${removal.name}`);
    }
    yield* Console.log(
      ui.warning(
        "Prune removes everything the Brewfile does not declare, including packages installed by hand, and resets Homebrew's trust store to the Brewfile's `trusted:` values.",
      ),
    );
    if (!options.yes) {
      if (options.confirm === undefined) {
        return yield* new CliFailure({
          message: "Confirmation is required to prune Homebrew packages; rerun with --yes.",
        });
      }
      if (!(yield* options.confirm)) {
        (yield* TerminalSession).cancel();
        yield* Console.log(ui.muted("Aborted. No Homebrew packages were removed."));
        return;
      }
    }
    yield* requireBrewOk(
      run,
      ["bundle", "cleanup", "--force", `--file=${brewfilePath}`],
      "brew bundle cleanup --force",
    );
  });

/**
 * Homebrew apply: install missing declarations without upgrading; remove undeclared ones only with `prune`.
 */
export const applyBrew = <ConfirmR = never>(options: ApplyBrewOptions<ConfirmR> = {}) =>
  Effect.gen(function* () {
    const whichFn = options.which ?? which;
    const run = options.run ?? runCommand;
    const brewPath = yield* tryPromise(() => whichFn("brew"));
    if (brewPath === undefined) {
      return yield* new CliFailure({ message: "Homebrew is not installed or not in PATH." });
    }

    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    yield* Console.log(ui.heading("Reading selected Homebrew Brewfile…"));
    const brewfile = yield* tryPromise(() => resolveBrewfile(options, config));

    const taps = parseBrewfileTaps(brewfile.text);
    const bundle = yield* withProgress("Homebrew apply", taps.length + 1, (progress) =>
      Effect.gen(function* () {
        yield* trustTaps(taps, run, progress);
        return yield* progress.track(
          "Syncing Brewfile",
          tryPromise(() =>
            run("brew", ["bundle", "--no-upgrade", `--file=${brewfile.path}`], {
              inherit: false,
            }),
          ).pipe(Effect.tap((result) => Effect.sync(() => logCommandOutput(progress, result)))),
        );
      }),
    );
    if (bundle.code !== 0) {
      const failure = `brew bundle failed (exit ${bundle.code})`;
      if (options.strict) {
        return yield* new CliFailure({ message: `${failure}.` });
      }
      (yield* TerminalSession).summary(
        "Homebrew apply was partial; one or more packages failed.",
        true,
      );
      yield* Console.log(
        ui.warning(`${failure}. Homebrew apply was partial; review the Brewfile and rerun apply.`),
      );
      if (options.prune) {
        yield* Console.log(ui.muted("Skipped pruning because the install was partial."));
      }
      return;
    }

    if (options.prune) {
      yield* pruneBrew(brewfile.path, run, options);
    }
    yield* Console.log(ui.success("Homebrew apply complete."));
  });

/** Upgrade installed Homebrew packages without applying or pruning declarations. */
export const updateBrew = (options: UpdateBrewOptions = {}) =>
  Effect.gen(function* () {
    const run = options.run ?? runCommand;
    if ((yield* tryPromise(() => (options.which ?? which)("brew"))) === undefined) {
      return yield* new CliFailure({ message: "Homebrew is not installed or not in PATH." });
    }
    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    yield* requireBrewOk(run, ["update"], "brew update");
    yield* requireBrewOk(run, ["upgrade"], "brew upgrade");
    yield* requireBrewOk(run, ["upgrade", "--cask"], "brew upgrade --cask");
    yield* setTerminalPhase("Publishing Homebrew inventory");
    yield* pushHomebrewInventory({ config, run, noPush: options.noPush });
    yield* Console.log(ui.success("Homebrew update complete."));
  });

const requireBrewOk = (run: typeof runCommand, args: ReadonlyArray<string>, label: string) =>
  Effect.gen(function* () {
    yield* setTerminalPhase(label);
    yield* Console.log(ui.heading(`${label}…`));
    const result = yield* tryPromise(() => run("brew", args, { inherit: true }));
    if (result.code !== 0) {
      return yield* new CliFailure({ message: `${label} failed (exit ${result.code}).` });
    }
  });
