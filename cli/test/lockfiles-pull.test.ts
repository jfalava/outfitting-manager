import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import { pullLockfile } from "@/lockfiles/pull";
import { request } from "@/lockfiles/request";

vi.mock("@/lockfiles/request", () => ({ request: vi.fn() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, writeFile: vi.fn(fs.writeFile) };
});

afterEach(() => vi.mocked(request).mockReset());

test("sync pull preserves an existing untracked snapshot if the replacement write fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "outfitting-pull-atomic-"));
  const target = join(directory, "snapshot.lock");
  await writeFile(target, "existing snapshot");
  vi.mocked(request).mockResolvedValue(new Response("new snapshot"));
  const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  vi.mocked(writeFile).mockImplementationOnce(async (path, _contents, options) => {
    await fs.writeFile(path, "partial snapshot", options);
    throw new Error("disk full");
  });

  try {
    await expect(
      Effect.runPromise(pullLockfile({ machine: "test-machine", kind: "nix", outPath: target })),
    ).rejects.toThrow("disk full");
    expect(await readFile(target, "utf8")).toBe("existing snapshot");
    expect(await readdir(directory)).toEqual(["snapshot.lock"]);
  } finally {
    vi.mocked(writeFile).mockImplementation(fs.writeFile);
    await rm(directory, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32").each([0o600, 0o640])(
  "sync pull preserves existing permissions %s when replacing snapshot bytes",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "outfitting-pull-mode-"));
    const target = join(directory, "snapshot.lock");
    try {
      await writeFile(target, "old snapshot");
      await chmod(target, mode);
      vi.mocked(request).mockResolvedValue(new Response(new Uint8Array([0x00, 0xff, 0x42])));
      await Effect.runPromise(
        pullLockfile({ machine: "test-machine", kind: "nix", outPath: target }),
      );
      expect(await readFile(target)).toEqual(Buffer.from([0x00, 0xff, 0x42]));
      expect((await stat(target)).mode & 0o777).toBe(mode);
      expect(await readdir(directory)).toEqual(["snapshot.lock"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "sync pull creates new snapshots with private permissions",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "outfitting-pull-new-"));
    const target = join(directory, "nested", "snapshot.lock");
    try {
      vi.mocked(request).mockResolvedValue(new Response("new snapshot"));
      await Effect.runPromise(
        pullLockfile({ machine: "test-machine", kind: "nix", outPath: target }),
      );
      expect(await readFile(target, "utf8")).toBe("new snapshot");
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect(await readdir(join(directory, "nested"))).toEqual(["snapshot.lock"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32").each([false, true])(
  "sync pull refuses symlink destinations, including dangling links (%s)",
  async (dangling) => {
    const directory = await mkdtemp(join(tmpdir(), "outfitting-pull-symlink-"));
    const target = join(directory, "actual.lock");
    const alias = join(directory, "alias.lock");
    try {
      if (!dangling) await writeFile(target, "existing target");
      await symlink(target, alias);
      await expect(
        Effect.runPromise(pullLockfile({ machine: "test-machine", kind: "nix", outPath: alias })),
      ).rejects.toThrow(/Refusing to replace symlink/);
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      expect(request).not.toHaveBeenCalled();
      if (dangling) {
        await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await readFile(target, "utf8")).toBe("existing target");
      }
      expect(await readdir(directory)).toEqual(
        dangling ? ["alias.lock"] : ["actual.lock", "alias.lock"],
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);
