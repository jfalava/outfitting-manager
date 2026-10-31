import { Flag } from "effect/cli";

/** Flags shared by every platform's `init` command. */
export const initFlags = {
  machineId: Flag.String("machine-id").pipe(
    Flag.optional,
    Flag.withDescription("Override machine id (default: auto user:arch-os)."),
  ),
  repo: Flag.String("repo").pipe(
    Flag.optional,
    Flag.withDescription("Local source path override for this invocation."),
  ),
  noRefresh: Flag.Boolean("no-refresh").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Validate and use the cached remote source without refreshing it."),
  ),
};
