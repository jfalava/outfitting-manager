import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, describe, expect, test } from "vitest";

import type { ManagerConfig } from "@/config";
import { CliFailure } from "@/errors";
import { recoverNix, type RecoverNixOptions } from "@/update/nix/recover";
import {
  clearNixRecovery,
  hasNixRecovery,
  prepareNixRecovery,
  readNixRecovery,
  setNixRecoveryPhase,
} from "@/update/nix/recovery";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

const hostPlatform = process.platform === "darwin" ? "macos" : "linux";
const checkpointContext = {
  machine: "test:aarch64-linux",
  platform: "linux" as const,
  systemConfig: "/nix/store/built-system",
  repoRoot: "/repo",
};

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "outfitting-nix-rec-"));
  temps.push(dir);
  return dir;
}

describe("nix recovery checkpoint", () => {
  test("prepare, set phase, clear", async () => {
    const parent = await tempDir();
    const recoveryDir = join(parent, "nix-lock-recovery");
    const lockSource = join(parent, "source.lock");
    await writeFile(lockSource, '{ "lock": true }\n', "utf8");

    expect(await hasNixRecovery(recoveryDir)).toBe(false);

    const state = await prepareNixRecovery({
      ...checkpointContext,
      lockPath: lockSource,
      baseHash: "c".repeat(64),
      profile: "workstation",
      recoveryDir,
    });
    expect(state.phase).toBe("prepared");
    expect(await hasNixRecovery(recoveryDir)).toBe(true);
    expect(await readFile(state.lockPath, "utf8")).toContain("lock");

    const loaded = await readNixRecovery(recoveryDir);
    expect(loaded?.baseHash).toBe("c".repeat(64));
    expect(loaded?.phase).toBe("prepared");
    expect(loaded).toMatchObject({
      machine: "test:aarch64-linux",
      platform: "linux",
      profile: "workstation",
    });

    await setNixRecoveryPhase("activated", recoveryDir);
    const after = await readNixRecovery(recoveryDir);
    expect(after?.phase).toBe("activated");

    await expect(
      prepareNixRecovery({ ...checkpointContext, lockPath: lockSource, recoveryDir }),
    ).rejects.toThrow(/already exists/);

    await clearNixRecovery(recoveryDir);
    expect(await hasNixRecovery(recoveryDir)).toBe(false);
    expect(await readNixRecovery(recoveryDir)).toBeUndefined();
  });

  test("does not treat an unreadable checkpoint marker as absent", async () => {
    const parent = await tempDir();
    const recoveryDir = join(parent, "nix-lock-recovery");
    const lockSource = join(parent, "source.lock");
    await writeFile(lockSource, '{ "lock": true }\n', "utf8");
    await mkdir(join(recoveryDir, "phase"), { recursive: true });

    await expect(hasNixRecovery(recoveryDir)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(
      prepareNixRecovery({ ...checkpointContext, lockPath: lockSource, recoveryDir }),
    ).rejects.toMatchObject({ code: "EISDIR" });
    expect(await readdir(recoveryDir)).toEqual(["phase"]);
    expect(await readdir(join(recoveryDir, "phase"))).toEqual([]);
  });
});

describe("recoverNix", () => {
  test.skipIf(process.platform === "darwin")(
    "activates the pinned prepared build without rebuilding and publishes its lock",
    async () => {
      const parent = await tempDir();
      const recoveryDir = join(parent, "nix-lock-recovery");
      const lockSource = join(parent, "source.lock");
      const systemConfig = join(parent, "built-system");
      await mkdir(systemConfig);
      await writeFile(lockSource, '{ "lock": true }\n', "utf8");
      await prepareNixRecovery({
        ...checkpointContext,
        lockPath: lockSource,
        baseHash: "a".repeat(64),
        systemConfig,
        recoveryDir,
      });

      const config: ManagerConfig = {
        configPath: join(parent, "state", "config.toml"),
        stateRoot: join(parent, "state"),
        machineId: "test:aarch64-linux",
        machineIdOverridden: true,
      };
      const calls: string[] = [];
      let pushed: Parameters<NonNullable<RecoverNixOptions["push"]>>[0] | undefined;

      const activateHomeManager: NonNullable<RecoverNixOptions["activateHomeManager"]> = async (
        options,
      ) => {
        calls.push(`activate:${options.activationPackage}:${options.repoRoot}`);
      };
      const push: NonNullable<RecoverNixOptions["push"]> = (options) =>
        Effect.sync(() => {
          pushed = options;
          return undefined;
        });

      await Effect.runPromise(
        recoverNix({
          config,
          recoveryDir,
          activateHomeManager,
          push,
        }),
      );

      expect(calls).toEqual([`activate:${systemConfig}:/repo`]);
      expect(pushed).toMatchObject({
        machine: config.machineId,
        kind: "nix",
        path: join(recoveryDir, "flake.lock"),
        ifMatch: "a".repeat(64),
      });
      expect(await hasNixRecovery(recoveryDir)).toBe(false);
    },
  );

  test.skipIf(process.platform === "darwin")(
    "keeps a garbage-collected prepared checkpoint without activating or publishing",
    async () => {
      const parent = await tempDir();
      const config: ManagerConfig = {
        configPath: join(parent, "config.toml"),
        stateRoot: parent,
        machineId: "test:aarch64-linux",
        machineIdOverridden: true,
      };
      const lockSource = join(parent, "source.lock");
      await writeFile(lockSource, '{"version":7}\n');
      const recoveryDir = join(parent, "collected");
      await prepareNixRecovery({
        ...checkpointContext,
        lockPath: lockSource,
        baseHash: "a".repeat(64),
        systemConfig: join(parent, "missing-system"),
        recoveryDir,
      });
      const calls: string[] = [];
      await expect(
        Effect.runPromise(
          recoverNix({
            config,
            recoveryDir,
            activateHomeManager: async () => {
              calls.push("activate");
            },
            push: () =>
              Effect.sync(() => {
                calls.push("push");
                return undefined;
              }),
          }),
        ),
      ).rejects.toThrow(/no longer exists/);
      expect((await readNixRecovery(recoveryDir))?.phase).toBe("prepared");
      expect(calls).toEqual([]);
    },
  );

  test("rejects a checkpoint from an older outfitting-manager and keeps it for inspection", async () => {
    const parent = await tempDir();
    const recoveryDir = join(parent, "nix-lock-recovery");
    await mkdir(recoveryDir);
    await writeFile(join(recoveryDir, "flake.lock"), '{"version":7}\n');
    await writeFile(join(recoveryDir, "base-hash"), `${"a".repeat(64)}\n`);
    await writeFile(join(recoveryDir, "phase"), "prepared\n");
    const calls: string[] = [];

    await expect(
      Effect.runPromise(
        recoverNix({
          config: {
            configPath: join(parent, "config.toml"),
            stateRoot: parent,
            machineId: "test:aarch64-linux",
            machineIdOverridden: true,
          },
          recoveryDir,
          activate: async () => {
            calls.push("activate");
          },
          activateHomeManager: async () => {
            calls.push("activate");
          },
          push: () =>
            Effect.sync(() => {
              calls.push("push");
              return undefined;
            }),
        }),
      ),
    ).rejects.toThrow(
      `older outfitting-manager or damaged); inspect it, then remove ${recoveryDir}`,
    );
    expect(calls).toEqual([]);
    expect((await readdir(recoveryDir)).toSorted()).toEqual(["base-hash", "flake.lock", "phase"]);
  });

  test("retains the checkpoint when publishing fails", async () => {
    const parent = await tempDir();
    const recoveryDir = join(parent, "nix-lock-recovery");
    const lockSource = join(parent, "source.lock");
    await writeFile(lockSource, '{ "lock": true }\n', "utf8");
    await prepareNixRecovery({
      ...checkpointContext,
      platform: hostPlatform,
      lockPath: lockSource,
      recoveryDir,
    });
    await setNixRecoveryPhase("activated", recoveryDir);

    const config: ManagerConfig = {
      configPath: join(parent, "state", "config.toml"),
      stateRoot: join(parent, "state"),
      machineId: checkpointContext.machine,
      machineIdOverridden: true,
    };
    let pushed: Parameters<NonNullable<RecoverNixOptions["push"]>>[0] | undefined;
    const push: NonNullable<RecoverNixOptions["push"]> = (options) => {
      pushed = options;
      return Effect.fail(new CliFailure({ message: "stale remote lock" }));
    };

    await expect(
      Effect.runPromise(
        recoverNix({
          config,
          recoveryDir,
          push,
        }),
      ),
    ).rejects.toThrow("stale remote lock");
    expect(pushed).toMatchObject({ path: join(recoveryDir, "flake.lock"), ifMatch: undefined });
    expect(await hasNixRecovery(recoveryDir)).toBe(true);
    expect((await readNixRecovery(recoveryDir))?.phase).toBe("activated");
  });

  test.skipIf(process.platform === "darwin")(
    "recovers a Home Manager activation before publishing its per-machine lock",
    async () => {
      const parent = await tempDir();
      const recoveryDir = join(parent, "nix-lock-recovery");
      const lockSource = join(parent, "source.lock");
      const baseHash = "b".repeat(64);
      const systemConfig = join(parent, "built-home");
      await mkdir(systemConfig);
      await writeFile(lockSource, '{"version":7}\n', "utf8");
      await prepareNixRecovery({
        ...checkpointContext,
        lockPath: lockSource,
        baseHash,
        profile: "workstation",
        systemConfig,
        recoveryDir,
      });

      const config: ManagerConfig = {
        configPath: join(parent, "state", "config.toml"),
        stateRoot: join(parent, "state"),
        machineId: "test:aarch64-linux",
        machineIdOverridden: true,
      };
      const calls: string[] = [];
      let pushed: Parameters<NonNullable<RecoverNixOptions["push"]>>[0] | undefined;

      await Effect.runPromise(
        recoverNix({
          config,
          recoveryDir,
          activateHomeManager: async (options) => {
            calls.push(`activate:${options.activationPackage}`);
          },
          activate: async () => {
            calls.push("unexpected nix-darwin activation");
          },
          push: (options) =>
            Effect.sync(() => {
              pushed = options;
              return undefined;
            }),
        }),
      );

      expect(calls).toEqual([`activate:${systemConfig}`]);
      expect(pushed).toMatchObject({
        machine: config.machineId,
        kind: "nix",
        path: join(recoveryDir, "flake.lock"),
        ifMatch: baseHash,
      });
      expect(await hasNixRecovery(recoveryDir)).toBe(false);
    },
  );
});
