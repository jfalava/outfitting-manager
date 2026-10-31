import { Option } from "effect";
import { Command } from "effect/cli";

import { linuxProfileFlag } from "@/commands/linux-flags";
import { initFlags } from "@/commands/setup/flags";
import { runLinuxInit } from "@/setup/linux";

/** Prepare Linux state and source without applying packages or Home Manager. */
export const linuxInitCommand = Command.make(
  "init",
  {
    profile: linuxProfileFlag,
    ...initFlags,
  },
  ({ profile, machineId, repo, noRefresh }) =>
    runLinuxInit({
      profile: Option.getOrUndefined(profile),
      machineId: Option.getOrUndefined(machineId),
      repo: Option.getOrUndefined(repo),
      refreshSource: !noRefresh,
    }),
).pipe(
  Command.withDescription(
    "Prepare Linux state and validate the selected source without changing the system.",
  ),
);
