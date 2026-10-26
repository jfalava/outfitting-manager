import { decodeResponse, isJsonValue, KindsResponse } from "@outfitting/contract";
import { Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { printLockfileKinds } from "@/sync/display";
import { resolveLockfileMachine } from "@/sync/machine";
import { requestEffect } from "@/sync/request";
import type { ListLockfileOptions } from "@/sync/types";

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

    yield* printLockfileKinds(machine, kinds);
    return kinds;
  });
