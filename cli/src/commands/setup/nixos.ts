import { Option } from "effect";
import { Command, Flag } from "effect/cli";

import { initFlags } from "@/commands/setup/flags";
import { runSetup } from "@/setup/run";

const nixosProfileFlag = Flag.String("profile").pipe(
  Flag.optional,
  Flag.withDescription(
    "NixOS profile declared in config.toml; defaults to OUTFITTING_PROFILE or its NixOS selection.",
  ),
);

/** Prepare NixOS state and source; the system flake owns packages, so nothing is installed. */
export const nixosInitCommand = Command.make(
  "init",
  { profile: nixosProfileFlag, ...initFlags },
  ({ profile, machineId, repo, noRefresh }) =>
    runSetup({
      platform: "nixos",
      repoProfile: Option.getOrUndefined(profile),
      machineId: Option.getOrUndefined(machineId),
      repo: Option.getOrUndefined(repo),
      refreshSource: !noRefresh,
      nextCommand: "Next: outfitting-manager nix switch --no-refresh",
    }),
).pipe(
  Command.withDescription(
    "Prepare NixOS state and validate the selected source without changing the system.",
  ),
);
