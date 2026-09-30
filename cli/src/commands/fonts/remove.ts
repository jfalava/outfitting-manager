import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { planRemove } from "@/fonts/plan";
import { applyFontPlan } from "@/fonts/publish";
import { createR2ObjectStore, loadRemoteArchiveState } from "@/fonts/r2";
import { tryPromise } from "@/lockfiles/effect";

export const removeCommand = Command.make(
  "remove",
  {
    names: Argument.String("name").pipe(
      Argument.variadic({ min: 1 }),
      Argument.withDescription(
        "Face name, archive path, or PostScript name; family slug with --family.",
      ),
    ),
    family: Flag.Boolean("family").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Treat each argument as a whole family to remove."),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the planned face table without writing R2 or lockfiles."),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Skip the confirmation prompt."),
    ),
  },
  ({ names, family, dryRun, yes }) =>
    Effect.gen(function* () {
      const store = yield* tryPromise(() => createR2ObjectStore());
      const remote = yield* tryPromise(() => loadRemoteArchiveState(store));
      const plan = planRemove(remote.archive, names, family);
      yield* applyFontPlan(plan, dryRun, yes, { store, remote });
    }),
).pipe(Command.withDescription("Remove faces from the private R2 font archive."));
