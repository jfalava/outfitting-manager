import { Option } from "effect";
import { Command } from "effect/cli";

import { kindArgument } from "@/commands/sync/arguments";
import { historyLockfiles } from "@/sync";

export const historyCommand = Command.make("history", { kind: kindArgument }, ({ kind }) =>
  historyLockfiles({ kind: Option.getOrUndefined(kind) }),
).pipe(
  Command.withDescription(
    "Show version history for this machine. Omit kind (or pass all) for every tracked kind.",
  ),
);
