import type { HistoryResponse, PushResponse } from "@outfitting/contract";
import { Console, Effect } from "effect";

import { ui } from "@/ui";

export const printLockfileKinds = (machine: string, kinds: readonly string[]) =>
  Effect.gen(function* () {
    if (kinds.length === 0) {
      yield* Console.log(ui.muted(`No lockfiles tracked for ${machine}.`));
      return;
    }

    for (const kind of kinds) {
      yield* Console.log(ui.key(kind));
    }
  });

export const printLockfileHistory = (machine: string, kind: string, entries: HistoryResponse) =>
  Effect.gen(function* () {
    if (entries.length === 0) {
      yield* Console.log(ui.muted(`No history for ${machine}/${kind}.`));
      return;
    }

    yield* Console.log(ui.heading(`${machine}/${kind}`));
    yield* Console.log(ui.heading("CREATED_AT\tSIZE\tHASH"));
    for (const entry of entries) {
      yield* Console.log(`${entry.created_at}\t${entry.size}\t${ui.hash(entry.hash)}`);
    }
  });

export const printLockfilePush = (machine: string, kind: string, result: PushResponse) =>
  Console.log(
    ui.success(
      `${ui.key(`${machine}/${kind}`)} ${ui.hash(result.hash)} ${ui.muted(`(${result.size} bytes)`)}`,
    ),
  );

export const printLockfilePull = (machine: string, kind: string, outPath: string, size: number) =>
  Console.log(
    ui.success(
      `Wrote ${ui.key(`${size} bytes`)} to ${ui.key(outPath)} ${ui.muted(`(${machine}/${kind})`)}`,
    ),
  );

export const printNoLocalLockfiles = (machine: string, expectedKinds: readonly string[]) =>
  Console.log(
    ui.muted(
      `No local lockfiles found to push for ${machine}. Expected default paths for: ${expectedKinds.join(", ")}.`,
    ),
  );
