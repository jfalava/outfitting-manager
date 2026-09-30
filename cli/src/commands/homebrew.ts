import { Command } from "effect/cli";

import { pushHomebrewInventory } from "@/update/snapshot";

const inventoryCommand = Command.make("inventory", {}, () => pushHomebrewInventory()).pipe(
  Command.withDescription("Capture and push the observed Homebrew inventory."),
);

/** macOS Homebrew observed-state commands. */
export const homebrewCommand = Command.make("homebrew").pipe(
  Command.withDescription("Inspect the observed Homebrew inventory."),
  Command.withSubcommands([inventoryCommand]),
);
