import { Console, Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { sha256Hex } from "@/fonts/archive";
import { printFontTarget, printInventoryFaces } from "@/fonts/display";
import {
  inventoriesEqual,
  inventoryFromFaces,
  pullInventory,
  pushInventory,
  type InventorySnapshot,
  type PrivateFontsInventory,
} from "@/fonts/inventory";
import { createR2ObjectStore, loadRemoteArchiveState, type RemoteArchiveState } from "@/fonts/r2";
import { ui } from "@/ui";

export interface RepopulateResult {
  readonly inventory: PrivateFontsInventory;
  readonly wrote: boolean;
}

export function repopulateInventory(dryRun: boolean) {
  return Effect.gen(function* () {
    const store = yield* createR2ObjectStore();
    yield* printFontTarget(store.bucket);
    const remote = yield* tryPromise(() => loadRemoteArchiveState(store));
    return yield* syncInventoryFromRemote(remote, dryRun);
  });
}

export function syncInventoryFromRemote(remote: RemoteArchiveState, dryRun: boolean) {
  return Effect.gen(function* () {
    const snapshot = yield* pullInventory;
    const result = yield* writeRepopulatedInventory(remote, snapshot, dryRun);
    yield* printRepopulateResult(result, dryRun);
    return result;
  });
}

function writeRepopulatedInventory(
  remote: RemoteArchiveState,
  snapshot: InventorySnapshot | void,
  dryRun: boolean,
) {
  return Effect.gen(function* () {
    if (remote.bytes === undefined) {
      return yield* new CliFailure({ message: "No private font archive is stored in R2." });
    }
    const inventory = inventoryFromFaces(
      remote.archive.faces,
      sha256Hex(remote.bytes),
      remote.bytes.byteLength,
    );
    if (snapshot !== undefined && inventoriesEqual(snapshot.inventory, inventory)) {
      return { inventory, wrote: false } satisfies RepopulateResult;
    }
    if (!dryRun) {
      yield* pushInventory(inventory, snapshot?.hash);
    }
    return { inventory, wrote: true } satisfies RepopulateResult;
  });
}

export function printRepopulateResult(result: RepopulateResult, dryRun: boolean) {
  return Effect.gen(function* () {
    yield* Console.log(
      ui.muted(
        `${result.inventory.archive.key}  ${result.inventory.archive.sha256}  (${result.inventory.archive.size} bytes)`,
      ),
    );
    yield* printInventoryFaces(result.inventory.faces);
    if (!result.wrote) {
      yield* Console.log(ui.muted("Inventory already matches the R2 archive."));
      return;
    }
    yield* Console.log(
      dryRun
        ? ui.muted("Dry run: skipped rewriting the lockfiles inventory.")
        : ui.success(
            `Repopulated ${ui.key(`${result.inventory.faces.length} faces`)} ${ui.hash(result.inventory.archive.sha256)}`,
          ),
    );
  });
}
