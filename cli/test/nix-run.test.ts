import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { loadConfig } from "@/config";
import { CliFailure } from "@/errors";
import { pullLockfile, pushLockfile } from "@/sync";
import { activateHomeManager } from "@/update/nix/activate";
import { buildNixSystem } from "@/update/nix/build";
import { updateNix } from "@/update/nix/run";
import { updateNixLock } from "@/update/nix/update-lock";

const { credentialsMock } = vi.hoisted(() => ({
  credentialsMock: vi.fn<() => Effect.Effect<{ workerUrl: string; token: string }, CliFailure>>(),
}));
vi.mock("@/process", () => ({ which: async () => "/bin/nix" }));
vi.mock("@/update/nix/recovery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/update/nix/recovery")>()),
  readNixRecovery: vi.fn(async () => undefined),
}));
vi.mock("@/update/nix/symlinks", () => ({ ensureNixSymlinks: vi.fn(async () => undefined) }));
vi.mock("@/update/nix/build", () => ({
  buildNixSystem: vi.fn(async () => "/nix/store/test-system"),
}));
vi.mock("@/update/nix/activate", () => ({
  activateHomeManager: vi.fn(async () => undefined),
}));
vi.mock("@/sync", () => ({
  pullLockfile: vi.fn(() => Effect.fail(new CliFailure({ message: "service unavailable" }))),
  pushLockfile: vi.fn(() => Effect.void.pipe(Effect.as(undefined))),
  resolveLockfileCredentials: Effect.suspend(() => credentialsMock()),
}));
vi.mock("@/update/nix/update-lock", () => ({ updateNixLock: vi.fn(async () => undefined) }));

const temporaryRoots: string[] = [];
const linuxTest = test.skipIf(process.platform === "darwin");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(buildNixSystem).mockImplementation(async () => "/nix/store/test-system");
  vi.mocked(activateHomeManager).mockImplementation(async () => undefined);
  vi.mocked(pullLockfile).mockImplementation(() =>
    Effect.fail(new CliFailure({ message: "service unavailable" })),
  );
  vi.mocked(pushLockfile).mockImplementation(() => Effect.void.pipe(Effect.as(undefined)));
  credentialsMock.mockImplementation(() =>
    Effect.succeed({ workerUrl: "https://lockfiles.example/api", token: "snapshot-token" }),
  );
  vi.mocked(updateNixLock).mockImplementation(async () => undefined);
  vi.stubEnv("OUTFITTING_REPO", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

async function makeLinuxSource(profile: string, withLock = false) {
  const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-nix-state-"));
  const repo = await mkdtemp(join(tmpdir(), "outfitting-nix-repo-"));
  temporaryRoots.push(stateRoot, repo);
  const flake = "system/home";
  await mkdir(join(repo, flake), { recursive: true });
  await writeFile(join(repo, flake, "flake.nix"), "{ outputs = {}; }\n");
  if (withLock) {
    await writeFile(join(repo, flake, "flake.lock"), '{ "version": 7 }\n');
  }
  await writeFile(
    join(stateRoot, "config.toml"),
    [
      "schema = 1",
      "[source]",
      `path = ${JSON.stringify(repo)}`,
      "[linux]",
      `profile = ${JSON.stringify(profile)}`,
      `[profiles.${JSON.stringify(profile)}.linux.nix]`,
      `flake = ${JSON.stringify(flake)}`,
      'attribute = "homeConfigurations.work.activationPackage"',
      "",
    ].join("\n"),
  );
  return {
    stateRoot,
    repo,
    config: await loadConfig({ stateRoot, machineId: "test:aarch64-linux" }),
  };
}

linuxTest("Linux Nix action skips profiles without a Nix declaration when requested", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "outfitting-nix-skip-state-"));
  temporaryRoots.push(stateRoot);
  await writeFile(
    join(stateRoot, "config.toml"),
    [
      "schema = 1",
      "[linux]",
      'profile = "native-only"',
      "[profiles.native-only.linux.apt]",
      'manifest = "packages/linux.txt"',
      "",
    ].join("\n"),
  );
  const config = await loadConfig({ stateRoot, machineId: "test:aarch64-linux" });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  try {
    // No [source] is configured, so anything past the skip would fail to prepare the source.
    await Effect.runPromise(updateNix({ action: "switch", config, ifConfigured: true }));

    expect(log.mock.calls.flat().join("\n")).toContain(
      "No Nix flake is declared for native-only; skipping.",
    );
  } finally {
    log.mockRestore();
  }
});

test.skipIf(process.platform !== "darwin")(
  "publishes a lock generated during a macOS bootstrap",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "outfitting-macos-nix-push-"));
    temporaryRoots.push(root);
    const flake = join(root, "system", "macos");
    await mkdir(flake, { recursive: true });
    await writeFile(join(flake, "flake.nix"), "flake\n");
    await writeFile(join(flake, "darwin.nix"), "darwin\n");
    const contract = {
      schema: 1 as const,
      profiles: {
        macos: {
          macos: { nix: { flake: "system/macos", attribute: "darwinConfigurations.macos.system" } },
        },
      },
    };
    const lockPath = join(flake, "flake.lock");
    vi.mocked(buildNixSystem).mockImplementation(async ({ repo }) => {
      await writeFile(join(repo.flakePath, "flake.lock"), '{ "version": 7 }\n');
      return "/nix/store/system";
    });
    const config = {
      configPath: join(root, "state", "config.toml"),
      stateRoot: join(root, "state"),
      machineId: "test:aarch64-darwin",
      machineIdOverridden: true,
    };

    await Effect.runPromise(
      updateNix({
        action: "build",
        config,
        repo: {
          root,
          contract,
          flakePath: flake,
          darwinNixPath: join(flake, "darwin.nix"),
          flakeKind: "macos",
          systemAttr: "darwinConfigurations.macos.system",
        },
      }),
    );

    expect(pushLockfile).toHaveBeenCalledWith({
      machine: config.machineId,
      kind: "nix",
      path: lockPath,
    });
  },
);

linuxTest(
  "publishes the local Home Manager flake lock after a Linux action without fetching",
  async () => {
    const { config, repo } = await makeLinuxSource("hm-lock", true);
    const lockPath = join(repo, "system", "home", "flake.lock");
    const fetcher = vi.fn(async () => new Response("unexpected remote refresh"));
    const localLock = await readFile(lockPath, "utf8");
    let pushed: { machine?: string; kind?: string; body?: string } | undefined;
    vi.mocked(pushLockfile).mockImplementation((options) =>
      Effect.promise(async () => {
        pushed = {
          machine: options.machine,
          kind: options.kind,
          body: await readFile(options.path!, "utf8"),
        };
        return undefined;
      }),
    );

    await Effect.runPromise(updateNix({ action: "build", config, sourceFetcher: fetcher }));

    expect(fetcher).not.toHaveBeenCalled();
    expect(pushed).toEqual({ machine: config.machineId, kind: "nix", body: localLock });
    expect(await readFile(lockPath, "utf8")).toBe(localLock);
  },
);

linuxTest(
  "Nix update uses the remote lock, verifies its candidate, switches, then CAS-publishes",
  async () => {
    const { config, repo, stateRoot } = await makeLinuxSource("hm-update", true);
    const localLockPath = join(repo, "system", "home", "flake.lock");
    const localLock = await readFile(localLockPath, "utf8");
    const remoteLock = '{"version":7,"inputs":{"nixpkgs":{"rev":"old"}}}\n';
    const candidateLock = '{"version":7,"inputs":{"nixpkgs":{"rev":"new"}}}\n';
    const events: string[] = [];
    const credentials = {
      workerUrl: "https://lockfiles.example/api",
      token: "snapshot-token",
    };
    let activated = false;
    let updateBase: string | undefined;
    let pushed:
      | {
          machine?: string;
          kind?: string;
          ifMatch?: string;
          body?: string;
          credentials?: typeof credentials;
        }
      | undefined;
    vi.stubEnv("XDG_STATE_HOME", stateRoot);
    vi.mocked(pullLockfile).mockImplementation((options) =>
      Effect.promise(async () => {
        await writeFile(options.outPath!, remoteLock);
        return undefined;
      }),
    );
    vi.mocked(updateNixLock).mockImplementation(async (options) => {
      events.push("update");
      updateBase = options.referenceLockPath
        ? await readFile(options.referenceLockPath, "utf8")
        : undefined;
      await writeFile(options.outputLockPath, candidateLock);
    });
    credentialsMock.mockImplementation(() =>
      Effect.suspend(() => {
        if (activated) {
          return Effect.fail(
            new CliFailure({ message: "keyring secrets store unavailable after activation" }),
          );
        }
        events.push("credentials");
        return Effect.succeed(credentials);
      }),
    );
    vi.mocked(buildNixSystem).mockImplementation(async (options) => {
      events.push("build");
      await writeFile(options.outputLockPath!, await readFile(options.lockPath!, "utf8"));
      return "/nix/store/updated-home";
    });
    vi.mocked(activateHomeManager).mockImplementation(async () => {
      activated = true;
      events.push("activate");
    });
    vi.mocked(pushLockfile).mockImplementation((options) =>
      Effect.promise(async () => {
        events.push("publish");
        pushed = {
          machine: options.machine,
          kind: options.kind,
          ifMatch: options.ifMatch,
          body: await readFile(options.path!, "utf8"),
          credentials: options.credentials,
        };
        return undefined;
      }),
    );

    await Effect.runPromise(updateNix({ action: "update", config, noRefresh: true }));

    expect(events).toEqual(["update", "build", "credentials", "activate", "publish"]);
    expect(updateBase).toBe(remoteLock);
    expect(pushed).toEqual({
      machine: config.machineId,
      kind: "nix",
      ifMatch: createHash("sha256").update(remoteLock).digest("hex"),
      body: candidateLock,
      credentials,
    });
    expect(await readFile(localLockPath, "utf8")).toBe(localLock);
  },
);
