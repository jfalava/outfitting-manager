import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

import { checksumSidecar, packFontArchive, sha256Hex } from "@/fonts/archive";
import { inventoryFromFaces, pullInventory, pushInventory } from "@/fonts/inventory";
import { applyFontPlan } from "@/fonts/publish";
import type { FontObjectStore, RemoteArchiveState } from "@/fonts/r2";

vi.mock("@/fonts/inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/fonts/inventory")>()),
  pullInventory: vi.fn(),
  pushInventory: vi.fn(),
}));

const face = {
  family: "Base",
  style: "Regular",
  postscriptName: "Base-Regular",
  path: "fonts/base/base-regular.otf",
};
const file = { path: face.path, bytes: new Uint8Array([1, 2, 3]) };

afterEach(() => vi.resetAllMocks());

describe("font archive publication", () => {
  test("a stale publisher cannot overwrite the winning archive or its checksum", async () => {
    const initialBytes = await packFontArchive([file]);
    let bytes = initialBytes;
    let checksum = checksumSidecar(bytes);
    let etag = '"etag-initial"';
    let inventory = inventoryFromFaces([face], sha256Hex(bytes), bytes.byteLength);
    let inventoryHash = "a".repeat(64);
    vi.mocked(pullInventory).mockImplementation(async () => ({ inventory, hash: inventoryHash }));
    vi.mocked(pushInventory).mockImplementation(async (next, expected) => {
      if (expected !== inventoryHash) throw new Error("Inventory conflict");
      inventory = next;
      inventoryHash = "b".repeat(64);
    });

    let resumeA: (() => void) | undefined;
    let pausedA: (() => void) | undefined;
    const aPaused = new Promise<void>((resolve) => {
      pausedA = resolve;
    });
    const waitForB = new Promise<void>((resolve) => {
      resumeA = resolve;
    });
    let sidecarWrites = 0;
    const store: FontObjectStore = {
      getArchive: async () => ({ bytes, etag }),
      getChecksum: async () => checksum,
      putArchive: async (next, nextChecksum, expected) => {
        if (expected === '"etag-initial"' && sha256Hex(next) === aHash) {
          pausedA?.();
          await waitForB;
        }
        if (expected !== etag) throw new Error("R2 PreconditionFailed");
        bytes = next;
        etag = '"etag-next"';
        checksum = nextChecksum;
        sidecarWrites += 1;
      },
    };
    const remote: RemoteArchiveState = {
      bytes: initialBytes,
      etag,
      archive: { files: [file], faces: [face] },
    };
    const nextFaceA = {
      ...face,
      family: "Candidate A",
      postscriptName: "A-Regular",
      path: "fonts/a/a.otf",
    };
    const nextFaceB = {
      ...face,
      family: "Candidate B",
      postscriptName: "B-Regular",
      path: "fonts/b/b.otf",
    };
    const nextFileA = { path: nextFaceA.path, bytes: new Uint8Array([4]) };
    const nextFileB = { path: nextFaceB.path, bytes: new Uint8Array([5]) };
    const aHash = sha256Hex(await packFontArchive([file, nextFileA]));
    const planA = {
      files: [file, nextFileA],
      faces: [
        { ...face, change: "unchanged" as const },
        { ...nextFaceA, change: "added" as const },
      ],
    };
    const planB = {
      files: [file, nextFileB],
      faces: [
        { ...face, change: "unchanged" as const },
        { ...nextFaceB, change: "added" as const },
      ],
    };

    const losing = Effect.runPromise(
      applyFontPlan(planA, false, true, { store, remote }).pipe(Effect.provide(BunServices.layer)),
    );
    await aPaused;
    await Effect.runPromise(
      applyFontPlan(planB, false, true, { store, remote }).pipe(Effect.provide(BunServices.layer)),
    );
    resumeA?.();
    await expect(losing).rejects.toThrow("R2 PreconditionFailed");
    expect(bytes).toEqual(await packFontArchive(planB.files));
    expect(checksum).toBe(checksumSidecar(bytes));
    expect(inventory.archive.sha256).toBe(sha256Hex(bytes));
    expect(sidecarWrites).toBe(1);
    expect(pushInventory).toHaveBeenCalledOnce();
  });

  test("refuses a mismatched baseline before writing the archive", async () => {
    const bytes = await packFontArchive([file]);
    const store: FontObjectStore = {
      getArchive: async () => ({ bytes, etag: '"base"' }),
      getChecksum: async () => checksumSidecar(bytes),
      putArchive: vi.fn(),
    };
    vi.mocked(pullInventory).mockResolvedValue({
      hash: "a".repeat(64),
      inventory: inventoryFromFaces([face], "0".repeat(64), bytes.byteLength),
    });
    const remote: RemoteArchiveState = {
      bytes,
      etag: '"base"',
      archive: { files: [file], faces: [face] },
    };
    await expect(
      Effect.runPromise(
        applyFontPlan({ files: [file], faces: [{ ...face, change: "unchanged" }] }, false, true, {
          store,
          remote,
        }).pipe(Effect.provide(BunServices.layer)),
      ),
    ).rejects.toThrow("disagree; refusing to publish");
    expect(store.putArchive).not.toHaveBeenCalled();
    expect(pushInventory).not.toHaveBeenCalled();
  });
});
