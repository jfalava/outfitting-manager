import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { selectRollback } from "@/update/nix/rollback";

let root: string;

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Lay out a fake profiles dir: generation number -> store name, `current` the generation `system` points at. */
async function layout(generations: Record<number, string>, current: number, running: string) {
  root = await mkdtemp(join(tmpdir(), "outfitting-rollback-"));
  const store = join(root, "store");
  const profiles = join(root, "profiles");
  await mkdir(profiles, { recursive: true });
  for (const name of new Set([...Object.values(generations), running])) {
    await mkdir(join(store, name), { recursive: true });
  }
  for (const [number, name] of Object.entries(generations)) {
    await symlink(join(store, name), join(profiles, `system-${number}-link`));
  }
  await symlink(`system-${current}-link`, join(profiles, "system"));
  await symlink(join(store, running), join(root, "current-system"));
  return {
    systemProfile: join(profiles, "system"),
    safeProfile: join(profiles, "outfitting-safe"),
    currentSystem: join(root, "current-system"),
    store,
  };
}

describe("selectRollback", () => {
  test("previous picks the newest generation below the profile's current one, not the newest overall", async () => {
    // Profile was already rolled back to 9; 10 and 11 still exist above it.
    const paths = await layout({ 2: "a", 9: "b", 10: "c", 11: "d", 8: "e" }, 9, "b");
    const selection = await selectRollback({ kind: "previous" }, paths);
    expect(selection).toMatchObject({
      label: "system generation 8",
      systemConfig: join(paths.store, "e"),
    });
  });

  test("previous skips older generations that are the running system", async () => {
    // A --safe rollback re-added system "a" as 12; 11 is the same broken build that is running.
    const paths = await layout({ 10: "a", 11: "broken", 12: "a", 13: "broken" }, 13, "broken");
    const selection = await selectRollback({ kind: "previous" }, paths);
    expect(selection).toMatchObject({
      label: "system generation 12",
      systemConfig: join(paths.store, "a"),
    });
  });

  test("an explicit generation must exist", async () => {
    const paths = await layout({ 3: "a", 4: "b" }, 4, "b");
    await expect(selectRollback({ kind: "generation", number: 2 }, paths)).rejects.toThrow(
      /generation 2 does not exist \(available: 4, 3\)/,
    );
    await expect(selectRollback({ kind: "generation", number: 3 }, paths)).resolves.toMatchObject({
      systemConfig: join(paths.store, "a"),
    });
  });

  test("safe resolves the safe profile and fails clearly when none is marked", async () => {
    const paths = await layout({ 1: "a", 2: "b" }, 2, "b");
    await expect(selectRollback({ kind: "safe" }, paths)).rejects.toThrow(/nix mark-safe/);
    await symlink(join(paths.store, "a"), paths.safeProfile);
    const selection = await selectRollback({ kind: "safe" }, paths);
    expect(selection.systemConfig).toBe(join(paths.store, "a"));
  });
});
