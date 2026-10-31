import { Command, Flag } from "effect/cli";

import { clearNix, recoverNix } from "@/update/nix/recover";

const nixRecoveryCommand = Command.make(
  "nix",
  {
    clear: Flag.Boolean("clear").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Abandon the checkpoint without activating or publishing it."),
    ),
  },
  ({ clear }) => (clear ? clearNix() : recoverNix()),
).pipe(Command.withDescription("Resume and publish an interrupted Nix profile update."));

/** Recovery actions, grouped by package origin. */
export const recoverCommand = Command.make("recover").pipe(
  Command.withDescription("Resume interrupted package-manager operations."),
  Command.withSubcommands([nixRecoveryCommand]),
);
