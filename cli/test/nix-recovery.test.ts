import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  nextRecoveryAction,
  prepareNixRecovery,
  readNixRecovery,
  setNixRecoveryPhase,
} from "@/update/nix/recovery";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "outfitting-nix-rec-"));
  temps.push(dir);
  return dir;
}

describe("nextRecoveryAction", () => {
  test("prepared → activate, activated → publish", () => {
    expect(nextRecoveryAction("prepared")).toBe("activate");
    expect(nextRecoveryAction("activated")).toBe("publish");
  });
});

describe("nix recovery checkpoint", () => {
  test("prepare, set phase, clear", async () => {
    const parent = await tempDir();
    const recoveryDir = join(parent, "nix-lock-recovery");
    const lockSource = join(parent, "source.lock");
    await writeFile(lockSource, '{ "lock": true }\n', "utf8");

    expect(await hasNixRecovery(recoveryDir)).toBe(false);

    const state = await prepareNixRecovery({
      lockPath: lockSource,
      baseHash: "abc123",
      machine: "test:aarch64-linux",
      platform: "linux",
      profile: "workstation",
      recoveryDir,
    });
    expect(state.phase).toBe("prepared");
    expect(await hasNixRecovery(recoveryDir)).toBe(true);
    expect(await readFile(state.lockPath, "utf8")).toContain("lock");

    const loaded = await readNixRecovery(recoveryDir);
    expect(loaded?.baseHash).toBe("abc123");
    expect(loaded?.phase).toBe("prepared");
    expect(loaded).toMatchObject({
      machine: "test:aarch64-linux",
      platform: "linux",
      profile: "workstation",
    });
    expect(nextRecoveryAction(loaded!.phase)).toBe("activate");

    await setNixRecoveryPhase("activated", recoveryDir);
    const after = await readNixRecovery(recoveryDir);
    expect(after?.phase).toBe("activated");
    expect(nextRecoveryAction(after!.phase)).toBe("publish");

    await expect(
      prepareNixRecovery({
        lockPath: lockSource,
        baseHash: "other",
        recoveryDir,
      }),
    ).rejects.toThrow(/already exists/);

    await clearNixRecovery(recoveryDir);
    expect(await hasNixRecovery(recoveryDir)).toBe(false);
    expect(await readNixRecovery(recoveryDir)).toBeUndefined();
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
        lockPath: lockSource,
        baseHash: "a".repeat(64),
        systemConfig,
        repoRoot: "/repo",
        platform: "linux",
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
        calls.push(`activate:${options.activationPackage}:${options.env?.OUTFITTING_REPO}`);
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
    "keeps legacy and garbage-collected prepared checkpoints without activating or publishing",
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
      const calls: string[] = [];
      for (const [label, systemConfig] of [
        ["legacy", undefined],
        ["collected", join(parent, "missing-system")],
      ] as const) {
        const recoveryDir = join(parent, label);
        await prepareNixRecovery({
          lockPath: lockSource,
          baseHash: "a".repeat(64),
          platform: "linux",
          repoRoot: parent,
          systemConfig,
          recoveryDir,
        });
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
        ).rejects.toThrow(/pinned build|no longer exists/);
        expect((await readNixRecovery(recoveryDir))?.phase).toBe("prepared");
      }
      expect(calls).toEqual([]);
    },
  );

  test("retains the checkpoint when publishing fails", async () => {
    const parent = await tempDir();
    const recoveryDir = join(parent, "nix-lock-recovery");
    const lockSource = join(parent, "source.lock");
    await writeFile(lockSource, '{ "lock": true }\n', "utf8");
    await prepareNixRecovery({
      lockPath: lockSource,
      baseHash: "local",
      recoveryDir,
    });
    await setNixRecoveryPhase("activated", recoveryDir);

    const config: ManagerConfig = {
      configPath: join(parent, "state", "config.toml"),
      stateRoot: join(parent, "state"),
      machineId: "test:aarch64-darwin",
      machineIdOverridden: true,
    };
    const push: NonNullable<RecoverNixOptions["push"]> = () =>
      Effect.fail(new CliFailure({ message: "stale remote lock" }));

    await expect(
      Effect.runPromise(
        recoverNix({
          config,
          recoveryDir,
          push,
        }),
      ),
    ).rejects.toThrow("stale remote lock");
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
        lockPath: lockSource,
        baseHash,
        machine: "test:aarch64-linux",
        platform: "linux",
        profile: "workstation",
        systemConfig,
        repoRoot: "/repo",
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
