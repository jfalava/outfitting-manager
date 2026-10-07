import { Command } from "effect/cli";

import { listLockfiles } from "@/sync";

export const listCommand = Command.make("list", {}, () => listLockfiles()).pipe(
  Command.withDescription("List lockfile kinds tracked for this machine."),
);
