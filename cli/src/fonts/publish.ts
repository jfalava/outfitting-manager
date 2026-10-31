import { Console, Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { checksumSidecar, packFontArchive, parseChecksumSidecar, sha256Hex } from "@/fonts/archive";
import { confirmPlan, printFaceTable } from "@/fonts/display";
import {
  inventoriesEqual,
  inventoryFromFaces,
  pullInventory,
  pushInventory,
} from "@/fonts/inventory";
import type { FontPlan } from "@/fonts/plan";
import type { FontObjectStore, RemoteArchiveState } from "@/fonts/r2";
import { TerminalSession } from "@/terminal-alert";
import { ui } from "@/ui";

const baselineMismatch = new CliFailure({
  message: "Font archive, checksum, and inventory disagree; refusing to publish.",
});

function checkBaseline(store: FontObjectStore, remote: RemoteArchiveState) {
  return Effect.gen(function* () {
    const [snapshot, checksum] = yield* Effect.all(
      [pullInventory, tryPromise(() => store.getChecksum())],
      { concurrency: 2 },
    );
    if (remote.bytes === undefined) {
      if (snapshot !== undefined || checksum !== undefined) {
        return yield* baselineMismatch;
      }
      return snapshot;
    }
    const archiveHash = sha256Hex(remote.bytes);
    if (
      snapshot === undefined ||
      checksum === undefined ||
      parseChecksumSidecar(checksum) !== archiveHash ||
      !inventoriesEqual(
        snapshot.inventory,
        inventoryFromFaces(remote.archive.faces, archiveHash, remote.bytes.byteLength),
      )
    ) {
      return yield* baselineMismatch;
    }
    return snapshot;
  });
}

export function applyFontPlan(
  plan: FontPlan,
  dryRun: boolean,
  yes: boolean,
  { store, remote }: { store: FontObjectStore; remote: RemoteArchiveState },
) {
  return Effect.gen(function* () {
    yield* printFaceTable(plan.faces);
    if (dryRun) {
      yield* Console.log(ui.muted("Dry run: skipped R2 upload and lockfile inventory."));
      return;
    }

    const confirmed = yield* confirmPlan(yes, "Upload the packed archive and rewrite inventory?");
    if (!confirmed) {
      (yield* TerminalSession).cancel();
      yield* Console.log(ui.muted("Aborted."));
      return;
    }

    const snapshot = yield* checkBaseline(store, remote);
    const packed = yield* tryPromise(() => packFontArchive(plan.files));
    const checksum = checksumSidecar(packed);
    yield* tryPromise(() => store.putArchive(packed, checksum, remote.etag));

    const kept = plan.faces.filter((face) => face.change !== "removed");
    const inventory = inventoryFromFaces(kept, sha256Hex(packed), packed.byteLength);
    yield* pushInventory(inventory, snapshot?.hash);
    yield* Console.log(
      ui.success(
        `Published ${ui.key(`${kept.length} faces`)} ${ui.hash(inventory.archive.sha256)} ${ui.muted(`(${inventory.archive.size} bytes)`)}`,
      ),
    );
  });
}
