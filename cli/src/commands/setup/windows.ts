import { Option } from "effect";
import { Command, Flag } from "effect/cli";

import { initFlags } from "@/commands/setup/flags";
import { runSetup, type SetupOptions } from "@/setup/run";

export interface WindowsInitOptions extends SetupOptions {
  profiles?: string[];
}

export const initializeWindows = (options: WindowsInitOptions = {}) =>
  runSetup({
    ...options,
    platform: "windows",
    repoProfile: options.profiles?.join(","),
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
