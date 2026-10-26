import { decodeResponse, HistoryResponse, isJsonValue } from "@outfitting/contract";
import { Console, Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { printLockfileHistory, printLockfileKinds } from "@/sync/display";
import { resolveKindSelection } from "@/sync/files";
import { fetchLockfileKinds } from "@/sync/list";
import { resolveLockfileMachine } from "@/sync/machine";
import { requestEffect } from "@/sync/request";
import type { HistoryLockfileOptions } from "@/sync/types";

const historyForKind = (machine: string, kind: string) =>
  Effect.gen(function* () {
    const response = yield* requestEffect(["lockfiles", machine, kind, "history"]);
    const entries = yield* tryPromise(async () => {
      const raw: unknown = await response.json();
      if (!isJsonValue(raw)) {
        throw new CliFailure({ message: "Worker returned an invalid history response." });
      }
      const decoded = decodeResponse(HistoryResponse, raw, "history");
      if (decoded === undefined) {
        throw new CliFailure({ message: "Worker returned an invalid history response." });
      }
      return decoded;
    });

    yield* printLockfileHistory(machine, kind, entries);
  });

export const historyLockfiles = (options: HistoryLockfileOptions = {}) =>
  Effect.gen(function* () {
    const machine = yield* resolveLockfileMachine(options.machine);

    const selection = resolveKindSelection(options.kind);
    if (selection.mode === "one") {
      yield* historyForKind(machine, selection.kind);
      return;
    }

    const kinds = yield* fetchLockfileKinds(machine);
    if (kinds.length === 0) {
      yield* printLockfileKinds(machine, kinds);
      return;
    }
    for (const [index, kind] of kinds.entries()) {
      if (index > 0) {
        yield* Console.log("");
      }
      yield* historyForKind(machine, kind);
    }
  });
