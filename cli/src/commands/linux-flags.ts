import { Flag } from "effect/cli";

export const linuxProfileFlag = Flag.String("profile").pipe(
  Flag.optional,
  Flag.withDescription(
    "Linux profile declared in config.toml; defaults to OUTFITTING_PROFILE or its Linux selection.",
  ),
);

export const linuxPackageManagerFlag = Flag.Literals("package-manager", ["apt", "pacman"]).pipe(
  Flag.optional,
  Flag.withDescription("Override distro detection with apt or pacman."),
);

export const linuxApplyOfflineFlag = Flag.Boolean("offline").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Use the cached source and apt packages without refreshing. pacman installs are refused offline.",
  ),
);

export const linuxUpdateOfflineFlag = Flag.Boolean("offline").pipe(
  Flag.withDefault(false),
  Flag.withDescription(
    "Refuse upgrades because network-free package resolution cannot be guaranteed.",
  ),
);
