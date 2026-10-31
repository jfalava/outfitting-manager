import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { initFlags } from "@/commands/setup/flags";
import { tryPromise } from "@/effect";
import { resolveSetupSource, runSetup, type SetupOptions } from "@/setup/run";

export interface WindowsInitOptions extends SetupOptions {
  profiles?: string[];
}

export const initializeWindows = (options: WindowsInitOptions = {}) =>
  Effect.gen(function* () {
    const source = yield* tryPromise(() =>
      resolveSetupSource({
        ...options,
        platform: "windows",
        repoProfile: options.profiles?.join(","),
      }),
    );
    const repo = yield* runSetup({
      ...options,
      ...source,
      nextCommand: options.nextCommand ?? "Next: outfitting-manager apply",
    });
    return { config: source.config, repo };
  });

/**
 * Initialize the Windows state root from the configured source.
 */
export const windowsInitCommand = Command.make(
  "init",
  {
    ...initFlags,
    profile: Flag.String("profile").pipe(
      Flag.optional,
      Flag.withDescription("Comma-separated Windows profiles (defaults to config.toml)."),
    ),
  },
  ({ machineId, noRefresh, profile, repo }) =>
    initializeWindows({
      profiles: Option.isSome(profile) ? profile.value.split(",") : undefined,
      machineId: Option.getOrUndefined(machineId),
      repo: Option.getOrUndefined(repo),
      refreshSource: !noRefresh,
    }),
).pipe(Command.withDescription("Initialize the Windows state root from the configured source."));
