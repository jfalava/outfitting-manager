import { Command, Flag } from "effect/cli";

import { updateScoop } from "@/update/scoop";
import { updateWinget } from "@/update/winget";

const packageManagerFlag = Flag.Literals("package-manager", ["winget", "scoop"]).pipe(
  Flag.withDescription("Installed package manager to upgrade: winget or scoop."),
);

const noPushFlag = Flag.Boolean("no-push").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Write local update state without uploading windows.lock.json."),
);

/** Upgrade installed packages through exactly one selected Windows manager. */
export const makeWindowsUpdateCommand = () =>
  Command.make(
    "update",
    { packageManager: packageManagerFlag, noPush: noPushFlag },
    ({ packageManager, noPush }) =>
      packageManager === "winget" ? updateWinget({ noPush }) : updateScoop({ noPush }),
  ).pipe(
    Command.withDescription(
      "Upgrade installed packages through one manager: --package-manager winget|scoop.",
    ),
  );
