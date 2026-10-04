import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { DateTime, Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterEach, expect, test } from "vitest";

import { Backup as MacBackup, isCheckDue, isDue } from "@/backups/backup";
import { launchAgent } from "@/backups/launchd";
import {
  JobState,
  type Job,
  type JobPolicy,
  type Snapshot,
  type SnapshotMetadata,
} from "@/backups/model";
import { Processes, type ProcessOutput } from "@/backups/process";
import { Secrets } from "@/backups/secrets";
import { Settings, type SettingsData } from "@/backups/settings";
import { scheduledTask } from "@/backups/windows";

// Opt in with an absolute Rustic executable; all repositories and data remain disposable.
const rustic = process.env.OUTFITTING_TEST_RUSTIC;
const jobs = ["documents", "images"] as const;
const windowsJobs = ["ffxiv-mods", "ffxiv-configs", "mmo-screenshots"] as const;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const id = (n: number) => n.toString(16).padStart(64, "0");
type RawSnapshot = typeof Snapshot.Encoded;
const ok = (value: unknown = ""): ProcessOutput => ({
  stdout: typeof value === "string" ? value : JSON.stringify(value),
  stderr: "",
  exitCode: 0,
});
const fails = async (promise: Promise<unknown>, message: string) => {
  const result = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  expect(String(result)).toContain(message);
};

const fixture = async (
  real = false,
  windows = false,
  customJobs?: ReadonlyArray<Job>,
  policies?: Record<Job, JobPolicy>,
  keepIds: string[] = [],
) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "backup-wrapper-test-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const sources = {
    documents: [join(root, "Documentos")],
    images: [join(root, "Imágenes".normalize("NFD"))],
    "ffxiv-mods": [join(root, "Mods Space")],
    "ffxiv-configs": [join(root, "Plugins"), join(root, "Game Configs")],
    "mmo-screenshots": [join(root, "FFXIV Pictures"), join(root, "WoW Pictures")],
  } as Record<Job, string[]> & {
    documents: string[];
    images: string[];
    "ffxiv-mods": string[];
    "ffxiv-configs": string[];
    "mmo-screenshots": string[];
  };
  const activeJobs = customJobs ?? (windows ? windowsJobs : jobs);
  for (const job of activeJobs) {
    if (!Object.hasOwn(sources, job)) sources[job] = [join(root, job)];
  }
  for (const path of Object.values(sources).flat()) await mkdir(path);
  const settings: SettingsData & { sources: typeof sources } = {
    repoRoot: root,
    configPath: join(root, "config.toml"),
    backupProfile: "fixture",
    home: root,
    account: "fixture",
    hostname: "fixture-host",
    rustic: rustic ?? join(root, "rustic"),
    stateDirectory: join(root, "state"),
    logFile: join(root, "logs/rustic.log"),
    alertUrl: "https://example.invalid/alert",
    repository: "fixture-repository",
    jobs: activeJobs,
    dailyHour: windows ? 9 : 10,
    jobPolicies:
      policies ??
      (windows
        ? {
            "mmo-screenshots": { retention: { "keep-monthly": 3 } },
            "ffxiv-configs": {
              skipIfProcessesRunning: ["ffxiv_dx11", "ffxiv", "ffxivlauncher", "XIVLauncher"],
            },
          }
        : {}),
    substitutions: { PROTON_DRIVE_PATH: root, PROTON_IMAGES_DIR: join(root, "Resolved Photos") },
    sources,
    environment: { PATH: process.env.PATH, HOME: root, SystemRoot: process.env.SystemRoot },
    profile: {
      repository: { repository: join(root, "repository") },
      forget: {
        "keep-daily": 7,
        "keep-weekly": 4,
        "keep-monthly": windows ? 6 : 12,
        "keep-id": keepIds,
      },
      backup: {
        snapshots: activeJobs.map((job) => ({
          name: job,
          sources: [sources[job]![0]!, ...sources[job]!.slice(1)],
          tags: [job],
          "skip-if-unchanged": true,
        })),
      },
    },
  };
  const inventory: Array<typeof SnapshotMetadata.Encoded> = [];
  const calls: Array<{
    args: ReadonlyArray<string>;
    env: Record<string, string | undefined> | undefined;
    profile: string;
  }> = [];
  const alerts: Array<string> = [];
  let gameStatus = ok("stopped");
  let backupTime: string | undefined;
  let next = 1;
  const snapshot = (job: Job, files = 10, bytes = 1_000): RawSnapshot => ({
    id: id(next++),
    tree: id(next + 100),
    time: DateTime.formatIso(DateTime.nowUnsafe()),
    hostname: settings.hostname,
    paths: [sources[job]![0]!, ...sources[job]!.slice(1)],
    tags: [job],
    delete: "NotSet",
    summary: { total_files_processed: files, total_bytes_processed: bytes },
  });
  let backupOutput = (job: Job) => {
    const saved = snapshot(job);
    inventory.push(saved);
    return ok(saved);
  };
  let retentionOutput = (job: Job) =>
    ok([
      {
        items: inventory
          .filter((s) => s.tags.includes(job))
          .map((s) => ({ snapshot: s, keep: true })),
      },
    ]);
  const record = async (args: ReadonlyArray<string>, env?: Record<string, string | undefined>) => {
    const prefix = args.includes("-P") ? args[args.indexOf("-P") + 1] : undefined;
    calls.push({
      args,
      env,
      profile: prefix === undefined ? "" : await readFile(prefix + ".toml", "utf8"),
    });
  };
  const fake = Layer.succeed(
    Processes,
    Processes.of({
      run: Effect.fn("test.run")(function* (_exe, args, env) {
        yield* Effect.promise(() => record(args, env));
        if (_exe === "powershell.exe") return gameStatus;
        const job = activeJobs.find((job) => args.includes(job)) ?? activeJobs[0]!;
        if (args.includes("backup")) return backupOutput(job);
        if (args.includes("snapshots"))
          return ok([
            {
              snapshots: args.includes("--filter-tags")
                ? inventory.filter((s) => s.tags.includes(job))
                : inventory,
            },
          ]);
        if (args.includes("forget") && args.includes("--dry-run")) return retentionOutput(job);
        return ok();
      }),
    }),
  );
  const actual = Layer.effect(
    Processes,
    Effect.gen(function* () {
      const service = yield* Processes;
      return Processes.of({
        run: Effect.fn("test.actualRun")(function* (exe, args, env) {
          yield* Effect.promise(() => record(args, env));
          const timedArgs =
            args.includes("backup") && backupTime !== undefined
              ? [...args, "--time", backupTime]
              : args;
          return yield* service.run(
            exe,
            exe === settings.rustic ? ["--cache-dir", join(root, "cache"), ...timedArgs] : args,
            env,
          );
        }),
      });
    }),
  ).pipe(Layer.provide(Processes.layer), Layer.provide(BunServices.layer));
  const dependencies = Layer.mergeAll(
    BunServices.layer,
    Layer.succeed(Settings, settings),
    real ? actual : fake,
    Layer.succeed(
      Secrets,
      Secrets.of({
        get: (name) =>
          Effect.succeed(
            Redacted.make(name === "repository-password" ? "fixture-password" : `fixture-${name}`),
          ),
        set: () => Effect.void,
      }),
    ),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        alerts.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 })),
        );
      }),
    ),
  );
  const runtime = ManagedRuntime.make(MacBackup.layer.pipe(Layer.provideMerge(dependencies)));
  cleanups.unshift(() => runtime.dispose());
  const run = <A, E>(effect: Effect.Effect<A, E, MacBackup | Processes | Settings>) =>
    runtime.runPromise(effect);
  const backup = (selected: ReadonlyArray<Job> = activeJobs) =>
    run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).run(selected, false);
      }),
    );
  const seed = async (
    job: Job,
    snapshots: ReadonlyArray<RawSnapshot>,
    outcome: JobState["outcome"] = "accepted-changed",
  ) => {
    inventory.push(...snapshots);
    const anchors = snapshots.map((s) => ({
      id: s.id!,
      tree: s.tree,
      files: s.summary.total_files_processed,
      bytes: s.summary.total_bytes_processed,
    }));
    let state: JobState = {
      version: 1,
      repository: settings.repository,
      hostname: settings.hostname,
      job,
      startedAt: DateTime.nowUnsafe(),
      acceptedAt: DateTime.nowUnsafe(),
      outcome,
      knownIds: snapshots.map((s) => s.id!),
    };
    if (anchors[0] !== undefined) {
      state = { ...state, current: anchors[0] };
    }
    if (anchors[1] !== undefined) {
      state = { ...state, previous: anchors[1] };
    }
    await mkdir(join(settings.stateDirectory, settings.repository), { recursive: true });
    await writeFile(
      join(settings.stateDirectory, settings.repository, `${job}.json`),
      Schema.encodeSync(Schema.fromJsonString(JobState))(state),
    );
    return state;
  };
  return {
    root,
    settings,
    inventory,
    calls,
    alerts,
    snapshot,
    backup,
    run,
    seed,
    setTime: (time: string) => {
      backupTime = time;
    },
    setGame: (output: ProcessOutput) => {
      gameStatus = output;
    },
    setBackup: (handler: typeof backupOutput) => {
      backupOutput = handler;
    },
    setRetention: (handler: typeof retentionOutput) => {
      retentionOutput = handler;
    },
  };
};

test("scheduling prints a quoted manager invocation without running processes or installing tasks", async () => {
  const f = await fixture(false, true);
  const binary = join(f.root, "Owner's Backup & Tools/manager");
  const task = await f.run(scheduledTask(binary));
  const encoded = task.match(/-EncodedCommand&quot; &quot;([A-Za-z0-9+/=]+)&quot;/)?.[1];
  expect(encoded).toBeDefined();
  const script = Buffer.from(encoded!, "base64").toString("utf16le");
  expect(script).toContain("$ErrorActionPreference = 'Stop'");
  expect(script).toContain("Owner''s Backup & Tools");
  expect(script).toContain(
    `--config '${f.settings.configPath}' backups --profile 'fixture' run-due; exit $LASTEXITCODE`,
  );
  expect(task).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(task).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  expect(task).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
  expect(f.calls).toEqual([]);
});

test("daily eligibility uses local calendar days, including DST and the 10:00 boundary", () => {
  const zone = DateTime.zoneMakeNamedUnsafe("Europe/Madrid");
  const state: JobState = {
    version: 1,
    repository: "r",
    hostname: "h",
    job: "documents",
    startedAt: DateTime.makeUnsafe("2026-10-24T09:00:00Z"),
    acceptedAt: DateTime.makeUnsafe("2026-10-24T09:00:00Z"),
    outcome: "accepted-unchanged",
    knownIds: [],
  };
  expect(isDue(state, DateTime.makeUnsafe("2026-10-25T08:59:59Z"), zone)).toBe(false);
  expect(isDue(state, DateTime.makeUnsafe("2026-10-25T09:00:00Z"), zone)).toBe(true);
  expect(
    isDue(
      { ...state, acceptedAt: DateTime.makeUnsafe("2026-10-25T09:10:00Z") },
      DateTime.makeUnsafe("2026-10-25T15:00:00Z"),
      zone,
    ),
  ).toBe(false);
});

test("weekly checks catch up on Monday without repeating before Sunday's 15:00 deadline", () => {
  const zone = DateTime.zoneMakeNamedUnsafe("UTC");
  const last = DateTime.makeUnsafe("2026-09-20T16:00:00Z");
  expect(isCheckDue(last, DateTime.makeUnsafe("2026-09-27T14:59:59Z"), zone)).toBe(false);
  expect(isCheckDue(last, DateTime.makeUnsafe("2026-09-27T15:00:00Z"), zone)).toBe(true);
  expect(isCheckDue(last, DateTime.makeUnsafe("2026-09-28T11:00:00Z"), zone)).toBe(true);
  expect(
    isCheckDue(
      DateTime.makeUnsafe("2026-09-27T15:00:00Z"),
      DateTime.makeUnsafe("2026-09-28T11:00:00Z"),
      zone,
    ),
  ).toBe(false);
});

test("legacy empty paths and absent summaries do not block healthy backup anchors or listings", async () => {
  const f = await fixture();
  const empty = { ...f.snapshot("images", 0, 0), paths: [""] };
  const { summary: _summary, ...withoutSummary } = f.snapshot("images");
  f.inventory.push(empty, withoutSummary);
  f.setBackup((job) => {
    const saved = f.snapshot(job, 23, 5_017);
    f.inventory.push(saved);
    return ok(saved);
  });
  const [first] = await f.backup(["images"]);
  expect(first?.outcome).toBe("accepted-changed");
  expect(first?.current).toMatchObject({ files: 23, bytes: 5_017 });
  expect(first?.current?.id).not.toBe(empty.id);
  expect(first?.current?.id).not.toBe(withoutSummary.id);
  const [second] = await f.backup(["images"]);
  expect(second?.outcome).toBe("accepted-changed");
  expect(second?.previous).toEqual(first?.current);
  const listed = await f.run(
    Effect.gen(function* () {
      return yield* (yield* MacBackup).snapshots("images");
    }),
  );
  expect(listed).toHaveLength(4);
  expect(listed.find((snapshot) => snapshot.id === empty.id)?.paths).toEqual([""]);
  expect(listed.find((snapshot) => snapshot.id === withoutSummary.id)?.summary).toBeUndefined();
  expect(f.alerts).toEqual([]);
});

test.each(["missing-summary", "empty-path", "zero-files"])(
  "fresh %s backups still fail without accepting a recovery anchor",
  async (problem) => {
    const f = await fixture();
    f.setBackup((job) => {
      const saved = f.snapshot(job);
      if (problem === "missing-summary") {
        const { summary: _summary, ...withoutSummary } = saved;
        return ok(withoutSummary);
      }
      if (problem === "empty-path") return ok({ ...saved, paths: [""] });
      return ok({ ...saved, summary: { total_files_processed: 0, total_bytes_processed: 0 } });
    });
    const [state] = await f.backup(["images"]);
    expect(state?.outcome).toBe("failed");
    expect(state?.current).toBeUndefined();
    expect(state?.acceptedAt).toBeUndefined();
  },
);

test("an empty historical path cannot resolve to the working directory for restore", async () => {
  const f = await fixture();
  f.settings.sources.documents[0] = process.cwd();
  const empty = { ...f.snapshot("documents", 0, 0), paths: [""] };
  f.inventory.push(empty);
  await fails(
    f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).restore("documents", empty.id!, join(f.root, "restored"));
      }),
    ),
    "Snapshot identity or sources do not match",
  );
  expect(f.calls.some((call) => call.args.includes("restore"))).toBe(false);
});

test("unchanged results refresh success only for the accepted parent and tree", async () => {
  const f = await fixture();
  const first = (await f.backup(["documents"]))[0]!;
  f.setBackup(() =>
    ok({
      ...f.snapshot("documents"),
      id: undefined,
      parent: first.current!.id,
      tree: first.current!.tree,
    }),
  );
  const unchanged = (await f.backup(["documents"]))[0]!;
  expect(unchanged.outcome).toBe("accepted-unchanged");
  expect(unchanged.current).toEqual(first.current);
  expect(unchanged.previous).toBeUndefined();
  f.setBackup(() =>
    ok({ ...f.snapshot("documents"), id: undefined, parent: id(900), tree: first.current!.tree }),
  );
  const wrong = (await f.backup(["documents"]))[0]!;
  expect(wrong.outcome).toBe("failed");
  expect(wrong.acceptedAt).toEqual(unchanged.acceptedAt);
});

test("exit-zero warnings cannot advance anchors and don't prevent the other job", async () => {
  const f = await fixture();
  const [original] = await f.backup(["documents"]);
  f.setBackup((job) => {
    const saved = f.snapshot(job);
    f.inventory.push(saved);
    return {
      ...ok(saved),
      stderr: job === "documents" ? "[WARN] permission denied fixture-password" : "",
    };
  });
  const [documents, images] = await f.backup();
  expect(documents?.outcome).toBe("failed");
  expect(documents?.current).toEqual(original?.current);
  expect(documents?.error).not.toContain("fixture-password");
  expect(images?.outcome).toBe("accepted-changed");
  expect(f.alerts).toHaveLength(1);
  expect(
    f.calls.every((call) => !call.args.includes("forget") && !call.args.includes("prune")),
  ).toBe(true);
});

test("large shrinkage pauses only that job until the exact candidate is accepted", async () => {
  const f = await fixture();
  const [initial] = await f.backup(["documents"]);
  f.setBackup((job) => {
    const saved = f.snapshot(job, job === "documents" ? 4 : 10, 1_000);
    f.inventory.push(saved);
    return ok(saved);
  });
  const [review] = await f.backup(["documents"]);
  expect(review?.outcome).toBe("review-required");
  expect(review?.current).toEqual(initial?.current);
  const count = f.calls.length;
  const [paused, images] = await f.backup();
  expect(paused?.outcome).toBe("review-required");
  expect(images?.outcome).toBe("accepted-changed");
  expect(
    f.calls
      .slice(count)
      .filter((call) => call.args.includes("backup"))
      .every((call) => call.args.includes("images")),
  ).toBe(true);
  await fails(
    f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).accept("documents", id(999));
      }),
    ),
    "exact review-required",
  );
  const accepted = await f.run(
    Effect.gen(function* () {
      return yield* (yield* MacBackup).accept("documents", review!.candidate!.id);
    }),
  );
  expect(accepted.current).toEqual(review?.candidate);
  expect(accepted.previous).toEqual(initial?.current);
  expect(accepted.error).toBeUndefined();
});

test("all retention previews must validate before any forget is applied", async () => {
  const f = await fixture();
  for (const job of jobs) await f.seed(job, [f.snapshot(job), f.snapshot(job)]);
  f.setRetention((job) =>
    job === "images"
      ? ok("malformed JSON")
      : ok([
          {
            items: f.inventory
              .filter((s) => s.tags.includes(job))
              .map((s) => ({ snapshot: s, keep: true })),
          },
        ]),
  );
  await fails(
    f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).maintenance(true, false);
      }),
    ),
    "Invalid retention preview",
  );
  expect(
    f.calls.some((call) => call.args.includes("forget") && !call.args.includes("--dry-run")),
  ).toBe(false);
  expect(f.calls.some((call) => call.args.includes("prune"))).toBe(false);
});

test("retention protects full anchor IDs and refuses proposed anchor deletion", async () => {
  const f = await fixture();
  for (const job of jobs) await f.seed(job, [f.snapshot(job), f.snapshot(job)]);
  const protectedIds = f.inventory.map((s) => s.id);
  expect(
    await f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).maintenance(true, false);
      }),
    ),
  ).toEqual([]);
  const forgets = f.calls.filter((call) => call.args.includes("forget"));
  expect(forgets).toHaveLength(4);
  for (const call of forgets) for (const value of protectedIds) expect(call.args).toContain(value!);
  expect(f.calls.at(-1)?.args).toContain("prune");
  expect(f.calls.at(-1)?.args).toContain("10%");
  expect(f.calls.some((call) => call.args.includes("--instant-delete"))).toBe(false);
  f.setRetention((job) =>
    ok([
      {
        items: f.inventory
          .filter((s) => s.tags.includes(job))
          .map((s) => ({ snapshot: s, keep: false })),
      },
    ]),
  );
  const before = f.calls.length;
  await fails(
    f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).maintenance(true, false);
      }),
    ),
    "recovery anchor",
  );
  expect(f.calls.slice(before).some((call) => call.args.includes("prune"))).toBe(false);
});

test("unknown history requires acknowledgement, and failed receipts block maintenance", async () => {
  const f = await fixture();
  for (const job of jobs) await f.seed(job, [f.snapshot(job), f.snapshot(job)]);
  f.inventory.push(f.snapshot("documents"));
  await fails(
    f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).maintenance(true, false);
      }),
    ),
    "acknowledge-history",
  );
  await f.seed("images", [], "failed");
  await fails(
    f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).maintenance(true, true);
      }),
    ),
    "unresolved failures",
  );
});

test("stale mutexes and corrupt state fail closed without overwriting receipts", async () => {
  const f = await fixture();
  const directory = join(f.settings.stateDirectory, f.settings.repository);
  await mkdir(join(directory, "repository.lock"), { recursive: true });
  await fails(f.backup(), "lock unavailable");
  expect(f.calls).toHaveLength(0);
  await rm(join(directory, "repository.lock"), { recursive: true });
  await writeFile(join(directory, "documents.json"), "broken");
  await fails(f.backup(), "Invalid documents state");
  expect(await readFile(join(directory, "documents.json"), "utf8")).toBe("broken");
  expect(f.calls.some((call) => call.args.includes("backup") && call.args.includes("images"))).toBe(
    true,
  );
  await fails(stat(join(directory, "repository.lock")), "ENOENT");
});

test("restore refuses existing paths and source overlap through destination symlinks", async () => {
  const f = await fixture();
  const saved = f.snapshot("documents");
  f.inventory.push(saved);
  await symlink(
    f.settings.sources.documents[0]!,
    join(f.root, "source-alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await fails(
    f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).restore(
          "documents",
          saved.id!,
          join(f.root, "source-alias/restored"),
        );
      }),
    ),
    "overlaps",
  );
  await fails(
    f.run(
      Effect.gen(function* () {
        return yield* (yield* MacBackup).restore("documents", saved.id!, f.root);
      }),
    ),
    "overlaps",
  );
  expect(f.calls).toHaveLength(0);
});

test("managed profiles disable hooks and first-run skipping, and secrets stay out of argv/TOML", async () => {
  const f = await fixture();
  await f.backup(["images"]);
  const command = f.calls.find((call) => call.args.includes("backup"))!;
  expect(command.profile).toContain("skip-if-unchanged = false");
  expect(command.profile).not.toContain("hooks");
  expect(command.profile).not.toContain("fixture-password");
  expect(command.args.join(" ")).not.toContain("fixture-password");
  expect(command.env?.RUSTIC_PASSWORD).toBe("fixture-password");
  const receipt = await stat(join(f.settings.stateDirectory, f.settings.repository, "images.json"));
  if (process.platform !== "win32") expect(receipt.mode & 0o777).toBe(0o600);
  const plist = await f.run(launchAgent(join(f.root, "Backup & Tools/backup")));
  await writeFile(join(f.root, "agent.plist"), plist);
  if (process.platform === "darwin") {
    const lint = spawnSync("/usr/bin/plutil", ["-lint", join(f.root, "agent.plist")]);
    expect(lint.status).toBe(0);
  }
  expect(plist).toContain("Backup &amp; Tools");
  expect(plist).not.toContain("fixture-password");
});

test.skipIf(rustic === undefined)(
  "real Rustic uses custom job IDs, saves, skips, rotates anchors, checks, previews retention, and restores known bytes",
  async () => {
    const f = await fixture(true, false, ["project-data", "photos"], {
      photos: { retention: { "keep-monthly": 3 } },
    });
    const doc = join(f.settings.sources["project-data"]![0]!, "report.txt");
    const image = join(f.settings.sources.photos![0]!, "photo.bin");
    await writeFile(doc, "first report\n");
    await writeFile(image, new Uint8Array([0, 19, 255, 8, 41]));
    await f.run(
      Effect.gen(function* () {
        const output = yield* (yield* Processes).run(
          f.settings.rustic,
          ["--no-progress", "-r", f.settings.profile.repository.repository, "init"],
          { ...f.settings.environment, RUSTIC_PASSWORD: "fixture-password" },
        );
        expect(output.exitCode).toBe(0);
      }),
    );
    const first = await f.backup();
    expect(first.map((state) => state.job)).toEqual(["project-data", "photos"]);
    expect(
      first.map((s) => s.outcome),
      JSON.stringify(first),
    ).toEqual(["accepted-changed", "accepted-changed"]);
    expect(first[0]?.current?.files).toBe(1);
    expect(first[0]?.current?.bytes).toBe(13);
    expect(first[1]?.current?.bytes).toBe(5);
    expect((await f.backup()).map((s) => s.outcome)).toEqual([
      "accepted-unchanged",
      "accepted-unchanged",
    ]);
    await writeFile(doc, "second report, longer\n");
    await writeFile(image, new Uint8Array([2, 19, 255, 8, 41, 0, 9]));
    const second = await f.backup();
    expect(second[0]?.previous).toEqual(first[0]?.current);
    expect(second[1]?.previous).toEqual(first[1]?.current);
    expect(
      await f.run(
        Effect.gen(function* () {
          return yield* (yield* MacBackup).check(true);
        }),
      ),
    ).toBe(true);
    expect(
      await f.run(
        Effect.gen(function* () {
          return yield* (yield* MacBackup).maintenance(false, false);
        }),
      ),
    ).toEqual([]);
    const destination = join(f.root, "restored");
    await f.run(
      Effect.gen(function* () {
        yield* (yield* MacBackup).restore("project-data", first[0]!.current!.id, destination);
      }),
    );
    const restoredPath = process.platform === "win32" ? doc.replace(":", "") : doc.slice(1);
    expect(await readFile(join(destination, restoredPath), "utf8")).toBe("first report\n");
    expect(await readFile(doc, "utf8")).toBe("second report, longer\n");
    expect(f.alerts).toHaveLength(0);
  },
  30_000,
);

test.skipIf(rustic === undefined)(
  "real Rustic applies per-job retention without deleting another job's history or recovery anchors",
  async () => {
    const pins: string[] = [];
    const f = await fixture(
      true,
      false,
      ["photos", "project-data"],
      {
        photos: { retention: { "keep-daily": 0, "keep-weekly": 0, "keep-monthly": 1 } },
      },
      pins,
    );
    await f.run(
      Effect.flatMap(Processes, (service) =>
        service.run(
          f.settings.rustic,
          ["--no-progress", "-r", f.settings.profile.repository.repository, "init"],
          { ...f.settings.environment, RUSTIC_PASSWORD: "fixture-password" },
        ),
      ).pipe(Effect.map((output) => expect(output.exitCode).toBe(0))),
    );
    const generations: ReadonlyArray<JobState>[] = [];
    for (const month of [1, 2, 3, 4]) {
      f.setTime(`2026-0${month}-15 12:00:00+0000`);
      for (const job of f.settings.jobs) {
        await writeFile(join(f.settings.sources[job]![0]!, "data.txt"), "content".repeat(month));
      }
      const states = await f.backup();
      expect(
        states.map((state) => state.outcome),
        JSON.stringify(states),
      ).toEqual(["accepted-changed", "accepted-changed"]);
      generations.push(states);
    }
    pins.push(generations[0]![0]!.current!.id);
    const unpinnedPhoto = generations[1]![0]!.current!.id;
    const oldestProject = generations[0]![1]!.current!.id;
    const preview = await f.run(
      Effect.flatMap(MacBackup, (service) => service.maintenance(false, false)),
    );
    expect(preview).toEqual([unpinnedPhoto]);
    const before = await f.run(Effect.flatMap(MacBackup, (service) => service.snapshots()));
    expect(before.map((snapshot) => snapshot.id)).toContain(unpinnedPhoto);
    expect(
      await f.run(Effect.flatMap(MacBackup, (service) => service.maintenance(true, false))),
    ).toEqual([unpinnedPhoto]);
    const after = await f.run(Effect.flatMap(MacBackup, (service) => service.snapshots()));
    const remainingIds = after.map((snapshot) => snapshot.id);
    expect(remainingIds).not.toContain(unpinnedPhoto);
    expect(remainingIds).toContain(pins[0]);
    expect(remainingIds).toContain(oldestProject);
    for (const state of generations[3]!) {
      expect(remainingIds).toContain(state.current!.id);
      expect(remainingIds).toContain(state.previous!.id);
    }
    expect(after).toHaveLength(7);
    expect(f.alerts).toEqual([]);
  },
  30_000,
);

test("arbitrary configured IDs run in order, persist receipts, list, accept and restore", async () => {
  const f = await fixture(false, false, ["project-data", "constructor", "photos"]);
  const first = await f.backup();
  expect(first.map((state) => state.job)).toEqual(["project-data", "constructor", "photos"]);
  expect(first.every((state) => state.outcome === "accepted-changed")).toBe(true);
  expect(await f.run(Effect.flatMap(MacBackup, (service) => service.status))).toEqual(first);
  const listed = await f.run(
    Effect.flatMap(MacBackup, (service) => service.snapshots("constructor")),
  );
  expect(listed.map((snapshot) => snapshot.id)).toEqual([first[1]!.current!.id]);
  f.setBackup((job) => {
    const saved = f.snapshot(job, 3, 201);
    f.inventory.push(saved);
    return ok(saved);
  });
  const [review] = await f.backup(["constructor"]);
  expect(review?.outcome).toBe("review-required");
  const accepted = await f.run(
    Effect.flatMap(MacBackup, (service) => service.accept("constructor", review!.candidate!.id)),
  );
  expect(accepted.previous).toEqual(first[1]!.current);
  await f.run(
    Effect.flatMap(MacBackup, (service) =>
      service.restore("constructor", first[1]!.current!.id, join(f.root, "restored")),
    ),
  );
  expect(f.calls.at(-1)?.args).toContain("restore");
  const plist = await f.run(launchAgent(join(f.root, "manager")));
  expect(plist).toContain(
    `<key>PROTON_IMAGES_DIR</key><string>${join(f.root, "Resolved Photos")}</string>`,
  );
  expect(plist).not.toContain(f.settings.sources.images[0]);
});

test.each(["absent", "../escape", "check", "Photos"])(
  "all job entry points reject %s before side effects",
  async (job) => {
    const f = await fixture();
    await fails(f.backup(["documents", job]), "not configured");
    await fails(
      f.run(Effect.flatMap(MacBackup, (service) => service.snapshots(job))),
      "not configured",
    );
    await fails(
      f.run(Effect.flatMap(MacBackup, (service) => service.accept(job, id(1)))),
      "not configured",
    );
    await fails(
      f.run(
        Effect.flatMap(MacBackup, (service) =>
          service.restore(job, id(1), join(f.root, "restore")),
        ),
      ),
      "not configured",
    );
    expect(f.calls).toEqual([]);
    await fails(stat(join(f.settings.stateDirectory, f.settings.repository)), "ENOENT");
  },
);

test("process guards follow explicit policy, never job names, and pass process names as data", async () => {
  const f = await fixture(false, true, ["photos", "project-data", "ffxiv-configs"], {
    "project-data": { skipIfProcessesRunning: ["ExampleEditor", "Editor_Helper"] },
  });
  const saved = await f.seed("project-data", [f.snapshot("project-data")]);
  const receiptPath = join(f.settings.stateDirectory, f.settings.repository, "project-data.json");
  const before = await readFile(receiptPath, "utf8");
  f.setGame(ok("running"));
  expect((await f.backup()).map((state) => state.job)).toEqual(["photos", "ffxiv-configs"]);
  expect(await readFile(receiptPath, "utf8")).toBe(before);
  const probe = f.calls.find((call) => call.env?.OUTFITTING_BACKUP_PROCESSES)!;
  expect(JSON.parse(probe.env!.OUTFITTING_BACKUP_PROCESSES!)).toEqual([
    "ExampleEditor",
    "Editor_Helper",
  ]);
  expect(probe.args.join(" ")).not.toContain("ExampleEditor");
  for (const output of [
    ok("unknown"),
    { ...ok("stopped"), stderr: "unexpected warning" },
    { ...ok("stopped"), exitCode: 1 },
  ]) {
    f.setGame(output);
    const calls = f.calls.length;
    await fails(f.backup(["project-data"]), "Could not verify running processes");
    expect(f.calls.slice(calls).some((call) => call.args.includes("backup"))).toBe(false);
    expect(await readFile(receiptPath, "utf8")).toBe(before);
  }
  f.setGame(ok("stopped"));
  const [next] = await f.backup(["project-data"]);
  expect(next?.outcome).toBe("accepted-changed");
  expect(next?.previous).toEqual(saved.current);
});

test("retention overrides apply only to their configured job and preserve default counters and pins", async () => {
  const f = await fixture(
    false,
    false,
    ["photos", "constructor"],
    {
      photos: { retention: { "keep-daily": 0, "keep-monthly": 3 } },
    },
    [id(990)],
  );
  for (const job of f.settings.jobs) await f.seed(job, [f.snapshot(job), f.snapshot(job)]);
  expect(
    await f.run(Effect.flatMap(MacBackup, (service) => service.maintenance(false, false))),
  ).toEqual([]);
  const forgets = f.calls.filter((call) => call.args.includes("forget"));
  expect(forgets).toHaveLength(2);
  const photos = forgets.find((call) => call.args.includes("photos"))!;
  expect(photos.args[photos.args.indexOf("--keep-daily") + 1]).toBe("0");
  expect(photos.args[photos.args.indexOf("--keep-monthly") + 1]).toBe("3");
  const other = forgets.find((call) => call.args.includes("constructor"))!;
  expect(other.args).not.toContain("--keep-monthly");
  expect(other.profile).toContain("keep-monthly = 12");
  expect(photos.profile).toContain("keep-weekly = 4");
  for (const call of forgets) expect(call.args).toContain(id(990));
});

test("removed-job receipts block deletion but stay intact and allow inspection", async () => {
  const f = await fixture(false, false, ["photos"]);
  await f.seed("photos", [f.snapshot("photos"), f.snapshot("photos")]);
  await f.seed("documents", [f.snapshot("documents"), f.snapshot("documents")]);
  const receipt = join(f.settings.stateDirectory, f.settings.repository, "documents.json");
  const before = await readFile(receipt, "utf8");
  await f.run(Effect.flatMap(MacBackup, (service) => service.maintenance(false, false)));
  const count = f.calls.length;
  await fails(
    f.run(Effect.flatMap(MacBackup, (service) => service.maintenance(true, true))),
    "removed jobs",
  );
  expect(f.calls.slice(count)).toEqual([]);
  expect(await readFile(receipt, "utf8")).toBe(before);
});

test("historical snapshots with overlapping job tags block retention even with acknowledgement", async () => {
  const f = await fixture(false, false, ["photos", "project-data"]);
  for (const job of f.settings.jobs) await f.seed(job, [f.snapshot(job), f.snapshot(job)]);
  f.inventory.push({ ...f.snapshot("photos"), tags: ["photos", "project-data"] });
  await fails(
    f.run(Effect.flatMap(MacBackup, (service) => service.maintenance(true, true))),
    "overlap multiple",
  );
  expect(f.calls.some((call) => call.args.includes("forget") || call.args.includes("prune"))).toBe(
    false,
  );
});

test("new backup results with overlapping job tags never become accepted anchors", async () => {
  const f = await fixture(false, false, ["photos", "project-data"]);
  f.setBackup((job) => {
    const saved = { ...f.snapshot(job), tags: ["photos", "project-data"] };
    f.inventory.push(saved);
    return ok(saved);
  });
  const [state] = await f.backup(["photos"]);
  expect(state?.outcome).toBe("failed");
  expect(state?.current).toBeUndefined();
  expect(state?.error).toContain("identity");
});

test("Windows skips only FFXIV configs while the game runs, preserving anchors and retry eligibility", async () => {
  const f = await fixture(false, true);
  const saved = await f.seed("ffxiv-configs", [f.snapshot("ffxiv-configs")]);
  f.setGame(ok("running"));
  const states = await f.backup();
  expect(states.map((state) => state.job)).toEqual(["ffxiv-mods", "mmo-screenshots"]);
  expect(
    f.calls.some((call) => call.args.includes("backup") && call.args.includes("ffxiv-configs")),
  ).toBe(false);
  const receiptPath = join(f.settings.stateDirectory, f.settings.repository, "ffxiv-configs.json");
  expect(
    Schema.decodeSync(Schema.fromJsonString(JobState))(await readFile(receiptPath, "utf8")),
  ).toEqual(saved);
  f.setGame(ok("stopped"));
  expect((await f.backup(["ffxiv-configs"]))[0]?.outcome).toBe("accepted-changed");
  f.setGame({ stdout: "", stderr: "probe failed", exitCode: 1 });
  const before = f.calls.length;
  await fails(f.backup(["ffxiv-configs"]), "Could not verify running processes");
  expect(f.calls.slice(before).some((call) => call.args.includes("backup"))).toBe(false);
});

test("Windows retention uses six months for game data and three for screenshots, without implicit pruning", async () => {
  const f = await fixture(false, true);
  for (const job of windowsJobs) await f.seed(job, [f.snapshot(job), f.snapshot(job)]);
  await f.run(
    Effect.gen(function* () {
      return yield* (yield* MacBackup).maintenance(false, false);
    }),
  );
  const forgets = f.calls.filter((call) => call.args.includes("forget"));
  expect(forgets).toHaveLength(3);
  for (const call of forgets) {
    expect(call.args).toContain("--dry-run");
    expect(call.profile).toContain("keep-monthly = 6");
    if (call.args.includes("mmo-screenshots")) {
      expect(call.args[call.args.indexOf("--keep-monthly") + 1]).toBe("3");
    } else expect(call.args).not.toContain("--keep-monthly");
  }
  expect(f.calls.some((call) => call.args.includes("prune"))).toBe(false);
});

test.skipIf(process.platform !== "win32" || rustic === undefined)(
  "real Windows Rustic validates multi-source game jobs, unchanged parents, checks and restored bytes",
  async () => {
    const f = await fixture(true, true);
    for (const job of windowsJobs)
      for (const source of f.settings.sources[job])
        await writeFile(join(source, "fixture.txt"), job + "\n");
    await f.run(
      Effect.gen(function* () {
        const output = yield* (yield* Processes).run(
          f.settings.rustic,
          ["--no-progress", "-r", f.settings.profile.repository.repository, "init"],
          { ...f.settings.environment, RUSTIC_PASSWORD: "fixture-password" },
        );
        expect(output.exitCode).toBe(0);
      }),
    );
    const first = await f.backup();
    expect(first.map((state) => state.outcome)).toEqual([
      "accepted-changed",
      "accepted-changed",
      "accepted-changed",
    ]);
    expect(first.map((state) => state.current?.files)).toEqual([1, 2, 2]);
    expect(first.map((state) => state.current?.bytes)).toEqual([11, 28, 32]);
    expect((await f.backup()).map((state) => state.outcome)).toEqual([
      "accepted-unchanged",
      "accepted-unchanged",
      "accepted-unchanged",
    ]);
    const destination = join(f.root, "Windows Restored");
    await f.run(
      Effect.gen(function* () {
        yield* (yield* MacBackup).check(true);
        yield* (yield* MacBackup).restore("ffxiv-configs", first[1]!.current!.id, destination);
      }),
    );
    for (const source of f.settings.sources["ffxiv-configs"]) {
      expect(
        await readFile(join(destination, source.replace(":", ""), "fixture.txt"), "utf8"),
      ).toBe("ffxiv-configs\n");
    }
    expect(f.alerts).toHaveLength(0);
  },
  30_000,
);
