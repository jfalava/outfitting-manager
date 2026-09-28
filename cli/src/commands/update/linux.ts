import { Command } from "effect/unstable/cli";

import {
  linuxUpdateOfflineFlag,
  linuxPackageManagerFlag,
  requestedLinuxPackageManager,
} from "@/commands/linux-flags";
import { updateLinux } from "@/update/linux";

/** Upgrade installed Linux packages with the detected or selected manager. */
export const makeLinuxUpdateCommand = () =>
  Command.make(
    "update",
    { packageManager: linuxPackageManagerFlag, offline: linuxUpdateOfflineFlag },
    ({ packageManager, offline }) =>
      updateLinux({
        packageManager: requestedLinuxPackageManager(packageManager),
        offline,
      }),
  ).pipe(
    Command.withDescription(
      "Upgrade installed native packages; choose apt or pacman with --package-manager.",
    ),
  );
