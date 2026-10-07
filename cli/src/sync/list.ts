import { decodeResponse, isJsonValue, KindsResponse } from "@outfitting/contract";
import { Console, Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { resolveLockfileMachine } from "@/sync/machine";
import { requestEffect } from "@/sync/request";
import type { ListLockfileOptions } from "@/sync/types";
import { ui } from "@/ui";

/** Fetch tracked kinds for a machine without printing. */
export const fetchLockfileKinds = (machine: string) =>
  Effect.gen(function* () {
    const response = yield* requestEffect(["lockfiles", machine]);
    return yield* tryPromise(async () => {
      const raw: unknown = await response.json();
      if (!isJsonValue(raw)) {
        throw new CliFailure({ message: "Worker returned an invalid kinds response." });
      }
      const decoded = decodeResponse(KindsResponse, raw, "kinds");
      if (decoded === undefined) {
        throw new CliFailure({ message: "Worker returned an invalid kinds response." });
      }
      return decoded;
    });
  });

export const listLockfiles = (options: ListLockfileOptions = {}) =>
  Effect.gen(function* () {
    const machine = yield* resolveLockfileMachine(options.machine);
    const kinds = yield* fetchLockfileKinds(machine);

    if (kinds.length === 0) {
      yield* Console.log(ui.muted(`No lockfiles tracked for ${machine}.`));
      return kinds;
    }

    for (const kind of kinds) {
      yield* Console.log(ui.key(kind));
    }
    return kinds;
  });
