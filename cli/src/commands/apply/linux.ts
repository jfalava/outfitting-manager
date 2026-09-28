import { Effect } from "effect";
import { Command, Flag, Prompt } from "effect/unstable/cli";

import {
  linuxApplyOfflineFlag,
  linuxOptionalProfileFlag,
  linuxPackageManagerFlag,
  optionalString,
  requestedLinuxPackageManager,
} from "@/commands/linux-flags";
import { applyLinux } from "@/update/linux";

const pruneFlag = Flag.Boolean("prune").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Remove stale packages proven to have been installed for the active profile.",
  ),
);

const yesFlag = Flag.Boolean("yes").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Apply the displayed install/removal plan without prompting."),
);

const noRefreshFlag = Flag.Boolean("no-refresh").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Use the configured local source or cached remote snapshot without refreshing.",
  ),
);

const ifConfiguredFlag = Flag.Boolean("if-configured").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Skip when the selected profile declares no apt or pacman packages."),
);

const strictFlag = Flag.Boolean("strict").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Stop at the first package installation failure."),
);

export const makeLinuxApplyCommand = () =>
  Command.make(
    "apply",
    {
      profile: linuxOptionalProfileFlag,
      packageManager: linuxPackageManagerFlag,
      prune: pruneFlag,
      offline: linuxApplyOfflineFlag,
      yes: yesFlag,
      noRefresh: noRefreshFlag,
      ifConfigured: ifConfiguredFlag,
      strict: strictFlag,
    },
    (flags) =>
      applyLinux({
        profile: optionalString(flags.profile),
        packageManager: requestedLinuxPackageManager(flags.packageManager),
        prune: flags.prune,
        offline: flags.offline,
        yes: flags.yes,
        noRefresh: flags.noRefresh,
        ifConfigured: flags.ifConfigured,
        strict: flags.strict,
        confirm: Prompt.Confirm({
          message: "Apply this plan?",
          initial: false,
        }).pipe(Effect.orDie),
      }),
  ).pipe(
    Command.withDescription(
      "Reconcile declared Linux packages; select apt or pacman with --package-manager.",
    ),
  );
