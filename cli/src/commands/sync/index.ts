import { Command } from "effect/cli";

import { configureCommand } from "@/commands/sync/configure";
import { historyCommand } from "@/commands/sync/history";
import { listCommand } from "@/commands/sync/list";
import { pullCommand } from "@/commands/sync/pull";
import { pushCommand } from "@/commands/sync/push";

export const syncSubcommands = [
  configureCommand,
  pushCommand,
  pullCommand,
  listCommand,
  historyCommand,
] as const;

/** Remote inventory/lock transport, identical on every platform. */
export const syncCommand = Command.make("sync").pipe(
  Command.withDescription(
    "Push, pull, and inspect remote lock snapshots without changing installed packages.",
  ),
  Command.withSubcommands([...syncSubcommands]),
);
