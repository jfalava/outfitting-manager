import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { expect, test, vi } from "vitest";

import { pullLockfile } from "@/lockfiles/pull";
import { request } from "@/lockfiles/request";

vi.mock("@/lockfiles/request", () => ({ request: vi.fn() }));

test("sync pull preserves an existing untracked snapshot if the replacement write fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outfitting-pull-atomic-"));
  const target = join(directory, "snapshot.lock");
  await writeFile(target, "existing snapshot");
  vi.mocked(request).mockResolvedValue(new Response("new snapshot"));
  const write = vi.fn(async (path: string) => {
    await writeFile(String(path), "partial snapshot");
    throw new Error("disk full");
  });
  vi.stubGlobal("Bun", { write });

  try {
    await expect(
      Effect.runPromise(pullLockfile({ machine: "test-machine", kind: "nix", outPath: target })),
    ).rejects.toThrow("disk full");
    expect(await readFile(target, "utf8")).toBe("existing snapshot");
    expect(await readdir(directory)).toEqual(["snapshot.lock"]);
  } finally {
    vi.unstubAllGlobals();
    await rm(directory, { force: true, recursive: true });
  }
});
