import { Option } from "effect";
import { Command, Flag } from "effect/cli";

import { initFlags } from "@/commands/setup/flags";
import { runSetup } from "@/setup/run";

/**
 * Prepare and validate the macOS state root and repository source. This
 * command never activates Nix, changes Homebrew, or publishes inventory.
 */
export const macosInitCommand = Command.make(
  "init",
  {
    ...initFlags,
    profile: Flag.String("profile").pipe(
      Flag.optional,
      Flag.withDescription("macOS profile declared in config.toml (defaults to its selection)."),
    ),
  },
  ({ machineId, repo, profile, noRefresh }) =>
    runSetup({
      platform: "macos",
      machineId: Option.getOrUndefined(machineId),
      repo: Option.getOrUndefined(repo),
      repoProfile: Option.getOrUndefined(profile),
      refreshSource: !noRefresh,
      skipSymlinks: true,
      nextCommand: "Next: outfitting-manager nix switch, then outfitting-manager apply",
    }),
).pipe(
  Command.withDescription(
    "Prepare and validate the macOS source without applying Nix or Homebrew state.",
  ),
);
