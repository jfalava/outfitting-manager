import { dirname, join, resolve, sep } from "node:path";

import { Context, DateTime, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { stringify } from "smol-toml";

import {
  Anchor,
  BackupError,
  JobState,
  RetentionPlan,
  Snapshot,
  SnapshotGroups,
  type Job,
} from "./model.ts";
import { Processes, parseJson, successful } from "./process.ts";
import { Secrets } from "./secrets.ts";
import { Settings } from "./settings.ts";

export const isDue = (
  state: JobState | undefined,
  now: DateTime.Utc,
  zone = DateTime.zoneMakeLocal(),
  hour = 10,
) => {
  const local = DateTime.setZone(now, zone);
  if (DateTime.toParts(local).hour < hour) {
    return false;
  }
  return (
    state?.acceptedAt === undefined ||
    DateTime.formatIsoDate(DateTime.setZone(state.acceptedAt, zone)) !==
      DateTime.formatIsoDate(local)
  );
};

export const isCheckDue = (
  checkedAt: DateTime.Utc | undefined,
  now: DateTime.Utc,
  zone = DateTime.zoneMakeLocal(),
) => {
  const local = DateTime.setZone(now, zone);
  const parts = DateTime.toParts(local);
  const days = parts.weekDay === 0 && parts.hour < 15 ? 7 : parts.weekDay;
  const deadline = DateTime.setParts(DateTime.subtract(local, { days }), {
    hour: 15,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  return (
    checkedAt === undefined || DateTime.toEpochMillis(checkedAt) < DateTime.toEpochMillis(deadline)
  );
};

function acceptedHistory(
  state: JobState | undefined,
): Pick<JobState, "acceptedAt" | "current" | "previous"> {
  let history: Pick<JobState, "acceptedAt" | "current" | "previous"> = {};
  if (state?.acceptedAt !== undefined) {
    history = { ...history, acceptedAt: state.acceptedAt };
  }
  if (state?.current !== undefined) {
    history = { ...history, current: state.current };
  }
  if (state?.previous !== undefined) {
    history = { ...history, previous: state.previous };
  }
  return history;
}

export class Backup extends Context.Service<
  Backup,
  {
    run(
      selected: ReadonlyArray<Job>,
      due: boolean,
    ): Effect.Effect<ReadonlyArray<JobState>, BackupError>;
    status: Effect.Effect<ReadonlyArray<JobState>, BackupError>;
    snapshots(job?: Job): Effect.Effect<ReadonlyArray<Snapshot>, BackupError>;
    check(readData: boolean, due?: boolean): Effect.Effect<boolean, BackupError>;
    maintenance(
      apply: boolean,
      acknowledgeHistory: boolean,
    ): Effect.Effect<ReadonlyArray<string>, BackupError>;
    accept(job: Job, id: string): Effect.Effect<JobState, BackupError>;
    restore(job: Job, id: string, destination: string): Effect.Effect<void, BackupError>;
  }
>()("backup/Backup") {
  static readonly layer = Layer.effect(
    Backup,
    Effect.gen(function* () {
      const config = yield* Settings;
      const fs = yield* FileSystem.FileSystem;
      const processes = yield* Processes;
      const secrets = yield* Secrets;
      const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
      const jobs = config.jobs;
      const paths = (job: Job) => config.sources[job] ?? [];
      const canonicalPath = (path: string) =>
        process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
      const directory = join(config.stateDirectory, config.repository);
      const statePath = (job: Job) => join(directory, `${job}.json`);
      const localFailure = (message: string) => new BackupError({ message });
      const decodeState = parseJson(JobState);
      const encodeState = Schema.encodeEffect(Schema.fromJsonString(JobState, { space: 2 }));

      const readState = Effect.fn("MacBackup.readState")(
        function* (job: Job) {
          const raw = yield* fs.readFileString(statePath(job)).pipe(
            Effect.map(Option.some),
            Effect.catch((error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
            ),
          );
          if (Option.isNone(raw)) {
            return undefined;
          }
          const state = yield* decodeState(raw.value).pipe(
            Effect.mapError(() =>
              localFailure(`Invalid ${job} state. Backups and maintenance require reconciliation.`),
            ),
          );
          if (
            state.repository !== config.repository ||
            state.hostname !== config.hostname ||
            state.job !== job
          ) {
            return yield* localFailure(`State identity mismatch for ${job}.`);
          }
          return state;
        },
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Could not read backup state."),
        ),
      );

      const writeState = Effect.fn("MacBackup.writeState")(
        function* (state: JobState) {
          const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".receipt-" });
          const path = join(temporary, "state.json");
          yield* fs.writeFileString(path, yield* encodeState(state), { mode: 0o600, flag: "wx" });
          yield* fs.rename(path, statePath(state.job));
        },
        Effect.scoped,
        Effect.mapError(() =>
          localFailure("Could not persist backup state; success was not recorded."),
        ),
      );

      const lock = Effect.fn("MacBackup.lock")(function* () {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, "repository.lock");
        yield* Effect.acquireRelease(
          fs
            .makeDirectory(path, { mode: 0o700 })
            .pipe(
              Effect.mapError(() =>
                localFailure(
                  `Repository lock unavailable: ${path}. Check for another run or an interrupted process; locks are never expired automatically.`,
                ),
              ),
            ),
          () => fs.remove(path, { recursive: true }).pipe(Effect.orDie),
        );
        yield* fs.writeFileString(
          join(path, "owner.json"),
          JSON.stringify({ pid: process.pid, startedAt: DateTime.formatIso(yield* DateTime.now) }),
          { mode: 0o600 },
        );
      });

      const credentials = Effect.fn("MacBackup.credentials")(function* () {
        const values = yield* Effect.all({
          access: secrets.get("access-key"),
          secret: secrets.get("secret-key"),
          password: secrets.get("repository-password"),
        });
        return {
          ...config.environment,
          AWS_ACCESS_KEY_ID: Redacted.value(values.access),
          AWS_SECRET_ACCESS_KEY: Redacted.value(values.secret),
          RUSTIC_PASSWORD: Redacted.value(values.password),
        };
      });

      const invoke = Effect.fn("MacBackup.invoke")(
        function* (args: ReadonlyArray<string>, saveSnapshot = true) {
          const env = yield* credentials();
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "rustic-wrapper-" });
          const profilePath = join(temporary, "managed.toml");
          const profile = {
            ...config.profile,
            global: { "log-file": config.logFile, "log-level-logfile": "info" },
            forget: { ...config.profile.forget, "delete-unchanged": false },
            backup: {
              snapshots: config.profile.backup.snapshots.map((snapshot) => ({
                ...snapshot,
                "skip-if-unchanged": saveSnapshot ? snapshot["skip-if-unchanged"] : false,
              })),
            },
          };
          yield* fs.makeDirectory(dirname(config.logFile), { recursive: true, mode: 0o700 });
          const toml = yield* Schema.decodeUnknownEffect(Schema.String)(stringify(profile));
          yield* fs.writeFileString(profilePath, toml, { mode: 0o600 });
          const output = yield* processes.run(
            config.rustic,
            ["--no-progress", "-P", profilePath.slice(0, -5), ...args],
            env,
          );
          const sensitive = [
            env.AWS_ACCESS_KEY_ID!,
            env.AWS_SECRET_ACCESS_KEY!,
            env.RUSTIC_PASSWORD!,
          ];
          const stderr = sensitive.reduce(
            (text, value) => text.replaceAll(value, "<redacted>"),
            output.stderr,
          );
          yield* successful({ ...output, stderr }, `rustic ${args[0] ?? "operation"}`);
          if (/\[(WARN|ERROR)\]/.test(stderr)) {
            return yield* localFailure(
              `Rustic reported warnings/errors; operation was not accepted. ${stderr.slice(-3_000)}`,
            );
          }
          return { ...output, stderr };
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Rustic invocation failed."),
        ),
      );

      const notify = Effect.fn("MacBackup.notify")(
        function* (operation: string, message: string) {
          const token = yield* secrets.get("alert-token");
          yield* client.execute(
            HttpClientRequest.post(config.alertUrl).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(token)}`),
              HttpClientRequest.bodyJsonUnsafe({
                hostname: config.hostname,
                operation,
                exit_code: "unknown",
                timestamp: DateTime.formatIso(yield* DateTime.now),
                message: message.slice(0, 4_000),
              }),
            ),
          );
        },
        Effect.timeout("20 seconds"),
        Effect.catch(() =>
          Effect.logWarning(
            "Failure notification could not be delivered; original backup outcome is unchanged.",
          ),
        ),
      );

      const list = Effect.fn("MacBackup.list")(function* (job?: Job) {
        const output = yield* invoke([
          "snapshots",
          "--json",
          ...(job === undefined ? [] : ["--filter-host", config.hostname, "--filter-tags", job]),
        ]);
        const groups = yield* parseJson(SnapshotGroups)(output.stdout).pipe(
          Effect.mapError(() => localFailure("Invalid Rustic snapshot listing.")),
        );
        return groups.flatMap((group) => group.snapshots);
      });

      const validate = Effect.fn("MacBackup.validate")(function* (snapshot: Snapshot, job: Job) {
        const sources = paths(job).map(canonicalPath).sort();
        if (
          snapshot.hostname !== config.hostname ||
          !snapshot.tags.includes(job) ||
          snapshot.paths.length !== sources.length ||
          snapshot.paths
            .map(canonicalPath)
            .sort()
            .some((path, index) => path !== sources[index])
        ) {
          return yield* localFailure(`Snapshot identity or sources do not match ${job}.`);
        }
        if (
          snapshot.delete !== undefined &&
          snapshot.delete !== "NotSet" &&
          snapshot.delete !== "Never"
        ) {
          return yield* localFailure(
            "Snapshot has a finite deletion deadline; refusing to use it as a recovery anchor.",
          );
        }
        return snapshot;
      });

      const verify = Effect.fn("MacBackup.verify")(function* (anchor: Anchor, job: Job) {
        const snapshots = yield* list(job);
        const snapshot = snapshots.find((entry) => entry.id === anchor.id);
        if (snapshot === undefined || snapshot.tree !== anchor.tree) {
          return yield* localFailure(
            `Accepted snapshot ${anchor.id} is missing or changed. Maintenance is paused.`,
          );
        }
        return yield* validate(snapshot, job);
      });

      const acceptResult = Effect.fn("Backup.acceptResult")(function* (
        snapshot: Snapshot,
        receipt: JobState,
        current: Anchor | undefined,
      ) {
        yield* validate(snapshot, receipt.job);
        if (snapshot.summary.total_files_processed === 0) {
          return yield* localFailure(
            `No files processed for ${receipt.job}; refusing an empty backup.`,
          );
        }
        if (
          current !== undefined &&
          (snapshot.summary.total_files_processed < current.files / 2 ||
            snapshot.summary.total_bytes_processed < current.bytes / 2)
        ) {
          return {
            ...receipt,
            outcome: "review-required" as const,
            error:
              "File count or logical bytes fell by more than 50%. Inspect the candidate before accepting it.",
          };
        }
        if (snapshot.id === undefined) {
          if (
            current === undefined ||
            snapshot.parent !== current.id ||
            snapshot.tree !== current.tree
          ) {
            return yield* localFailure("Unchanged backup does not reference the accepted parent.");
          }
          return {
            ...receipt,
            outcome: "accepted-unchanged" as const,
            acceptedAt: yield* DateTime.now,
          };
        }
        const candidate = receipt.candidate;
        if (candidate === undefined) {
          return yield* localFailure("Missing persisted snapshot candidate.");
        }
        yield* verify(candidate, receipt.job);
        const accepted: JobState = {
          ...receipt,
          outcome: "accepted-changed",
          acceptedAt: yield* DateTime.now,
          current: candidate,
        };
        if (current !== undefined) {
          return { ...accepted, previous: current };
        }
        return accepted;
      });

      const runJob = Effect.fn("MacBackup.runJob")(function* (
        job: Job,
        previous: JobState | undefined,
      ) {
        const now = yield* DateTime.now;
        let receipt: JobState = {
          version: 1,
          repository: config.repository,
          hostname: config.hostname,
          job,
          startedAt: now,
          outcome: "running",
          knownIds: previous?.knownIds ?? [],
          ...acceptedHistory(previous),
        };
        yield* writeState(receipt);
        const attempt = Effect.gen(function* () {
          if (previous?.current !== undefined) {
            yield* verify(previous.current, job);
          }
          const output = yield* invoke(
            [
              "backup",
              "--name",
              job,
              "--host",
              config.hostname,
              "--json",
              ...(previous?.current === undefined ? [] : ["--parent", previous.current.id]),
            ],
            previous?.current !== undefined,
          );
          const snapshot = yield* parseJson(Snapshot)(output.stdout).pipe(
            Effect.mapError(() =>
              localFailure("Invalid Rustic backup JSON; no success was recorded."),
            ),
          );
          if (snapshot.id !== undefined) {
            const candidate: Anchor = {
              id: snapshot.id,
              tree: snapshot.tree,
              files: snapshot.summary.total_files_processed,
              bytes: snapshot.summary.total_bytes_processed,
            };
            receipt = {
              ...receipt,
              candidate,
              knownIds: [...new Set([...receipt.knownIds, candidate.id])],
            };
          }
          receipt = yield* acceptResult(snapshot, receipt, previous?.current);
        });
        yield* attempt.pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              receipt = { ...receipt, outcome: "failed", error: error.message };
            }),
          ),
        );
        receipt = { ...receipt, finishedAt: yield* DateTime.now };
        yield* writeState(receipt);
        if (receipt.outcome === "failed" || receipt.outcome === "review-required") {
          yield* notify(`rustic backup (${job})`, receipt.error ?? receipt.outcome);
        }
        return receipt;
      });

      const status = Effect.forEach(jobs, readState).pipe(
        Effect.map((states) => states.filter((state) => state !== undefined)),
      );
      const run = Effect.fn("MacBackup.run")(
        function* (selected: ReadonlyArray<Job>, due: boolean) {
          yield* lock();
          const results: Array<JobState> = [];
          const errors: Array<string> = [];
          for (const job of selected) {
            yield* Effect.gen(function* () {
              if (!jobs.includes(job)) {
                return yield* localFailure(`Job ${job} is not configured on this platform.`);
              }
              const previous = yield* readState(job);
              if (previous?.outcome === "review-required") {
                results.push(previous);
                return;
              }
              if (
                due &&
                !isDue(previous, yield* DateTime.now, DateTime.zoneMakeLocal(), config.dailyHour)
              ) {
                return;
              }
              if (job === "ffxiv-configs") {
                const running = yield* processes.run(
                  "powershell.exe",
                  [
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "if (Get-Process -Name ffxiv_dx11,ffxiv,ffxivlauncher,XIVLauncher -ErrorAction SilentlyContinue) { Write-Output 'running' } else { Write-Output 'stopped' }",
                  ],
                  config.environment,
                );
                if (
                  running.exitCode !== 0 ||
                  !["running", "stopped"].includes(running.stdout.trim())
                ) {
                  return yield* localFailure(
                    "Could not verify whether FFXIV is running; config backup was not started.",
                  );
                }
                if (running.stdout.trim() === "running") {
                  yield* Effect.logInfo(
                    "FFXIV is running; config backup remains due and will retry on the next wake-up.",
                  );
                  return;
                }
              }
              results.push(yield* runJob(job, previous));
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  errors.push(error.message);
                }),
              ),
            );
          }
          if (errors.length > 0) {
            return yield* localFailure(errors.join("\n"));
          }
          return results;
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Could not run backups."),
        ),
      );

      const check = Effect.fn("MacBackup.check")(
        function* (readData: boolean, due = false) {
          yield* lock();
          const path = join(directory, "check.json");
          const CheckState = Schema.Struct({ checkedAt: Schema.DateTimeUtcFromString });
          if (due && (yield* fs.exists(path))) {
            const state = yield* parseJson(CheckState)(yield* fs.readFileString(path)).pipe(
              Effect.mapError(() => localFailure("Invalid repository-check receipt.")),
            );
            if (!isCheckDue(state.checkedAt, yield* DateTime.now)) {
              return false;
            }
          }
          yield* invoke(["check", ...(readData ? ["--read-data"] : [])]);
          const temporary = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".check-" });
          const staged = join(temporary, "check.json");
          yield* fs.writeFileString(
            staged,
            JSON.stringify({ checkedAt: DateTime.formatIso(yield* DateTime.now), readData }),
            { mode: 0o600 },
          );
          yield* fs.rename(staged, path);
          return true;
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Repository check failed."),
        ),
        Effect.tapError((error) => notify("rustic repository check", error.message)),
      );

      const maintenanceStates = Effect.gen(function* () {
        const states = yield* status;
        if (
          states.length !== jobs.length ||
          states.some(
            (state) =>
              state.current === undefined ||
              state.previous === undefined ||
              !state.outcome.startsWith("accepted-"),
          )
        ) {
          return yield* localFailure(
            "Maintenance requires two accepted saved generations for each job and no unresolved failures/reviews.",
          );
        }
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        if (
          states.some(
            (state) =>
              state.acceptedAt === undefined ||
              now - DateTime.toEpochMillis(state.acceptedAt) > 48 * 60 * 60 * 1_000,
          )
        ) {
          return yield* localFailure(
            "Maintenance requires an accepted backup of each job within the last 48 hours.",
          );
        }
        return states;
      });

      const verifyStates = Effect.fn("Backup.verifyStates")(function* (
        states: ReadonlyArray<JobState>,
      ) {
        for (const state of states) {
          if (state.current !== undefined) {
            yield* verify(state.current, state.job);
          }
          if (state.previous !== undefined) {
            yield* verify(state.previous, state.job);
          }
        }
      });

      const previewRetention = Effect.fn("Backup.previewRetention")(function* (
        job: Job,
        args: ReadonlyArray<string>,
        inventory: ReadonlyArray<Snapshot>,
        anchors: ReadonlyArray<Anchor>,
      ) {
        const output = yield* invoke([...args, "--dry-run", "--json"]);
        const groups = yield* parseJson(RetentionPlan)(output.stdout).pipe(
          Effect.mapError(() =>
            localFailure("Invalid retention preview; no deletion was applied."),
          ),
        );
        const items = groups.flatMap((group) => group.items);
        const plannedIds = new Set(items.map((item) => item.snapshot.id));
        const expectedIds = inventory
          .filter(
            (snapshot) => snapshot.hostname === config.hostname && snapshot.tags.includes(job),
          )
          .map((snapshot) => snapshot.id);
        if (
          plannedIds.size !== items.length ||
          plannedIds.size !== expectedIds.length ||
          expectedIds.some((id) => id === undefined || !plannedIds.has(id))
        ) {
          return yield* localFailure("Retention preview does not match the repository inventory.");
        }
        const removed: string[] = [];
        for (const item of items) {
          yield* validate(item.snapshot, job);
          if (!item.keep && item.snapshot.id !== undefined) {
            if (anchors.some((anchor) => anchor.id === item.snapshot.id)) {
              return yield* localFailure(
                "Retention proposed deleting an accepted recovery anchor.",
              );
            }
            removed.push(item.snapshot.id);
          }
        }
        return removed;
      });

      const maintenance = Effect.fn("MacBackup.maintenance")(
        function* (apply: boolean, acknowledgeHistory: boolean) {
          yield* lock();
          const states = yield* maintenanceStates;
          const anchors = states.flatMap((state) =>
            [state.current, state.previous].filter((anchor) => anchor !== undefined),
          );
          yield* verifyStates(states);
          const known = new Set(states.flatMap((state) => state.knownIds));
          const inventory = yield* list();
          const unknown = inventory.filter(
            (snapshot) => snapshot.id !== undefined && !known.has(snapshot.id),
          );
          if (apply && unknown.length > 0 && !acknowledgeHistory) {
            return yield* localFailure(
              `${unknown.length} historical/unmanaged snapshots require explicit --acknowledge-history after reviewing the preview.`,
            );
          }
          const removed: Array<string> = [];
          const keepArgs = [
            ...anchors.map((anchor) => anchor.id),
            ...(config.profile.forget["keep-id"] ?? []),
          ].flatMap((id) => ["--keep-id", id]);
          const operations: Array<ReadonlyArray<string>> = [];
          for (const job of jobs) {
            const args = [
              "forget",
              "--filter-host",
              config.hostname,
              "--filter-tags",
              job,
              ...Object.entries(config.jobRetention[job] ?? {}).flatMap(([key, value]) => [
                "--" + key,
                String(value),
              ]),
              ...keepArgs,
            ];
            removed.push(...(yield* previewRetention(job, args, inventory, anchors)));
            operations.push(args);
          }
          if (apply) {
            yield* invoke(["check"]);
            for (const args of operations) {
              yield* invoke(args);
            }
            yield* verifyStates(states);
            yield* invoke(["prune", "--max-unused", "10%"]);
          }
          return removed;
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Maintenance failed."),
        ),
      );

      const accept = Effect.fn("MacBackup.accept")(
        function* (job: Job, id: string) {
          yield* lock();
          const state = yield* readState(job);
          if (state?.outcome !== "review-required" || state.candidate?.id !== id) {
            return yield* localFailure("Only the exact review-required candidate can be accepted.");
          }
          const snapshot = yield* verify(state.candidate, job);
          const accepted: JobState = {
            ...state,
            outcome: "accepted-changed",
            acceptedAt: snapshot.time,
            current: state.candidate,
            previous: state.current,
          };
          const { error: _error, ...clean } = accepted;
          yield* writeState(clean);
          return clean;
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Could not accept candidate."),
        ),
      );

      const restore = Effect.fn("MacBackup.restore")(
        function* (job: Job, id: string, destination: string) {
          yield* lock();
          const target = join(
            yield* fs.realPath(dirname(resolve(destination))),
            resolve(destination).split(sep).at(-1) ?? "",
          );
          for (const source of Object.values(config.sources).flat()) {
            const original = canonicalPath(source);
            const destinationPath = canonicalPath(target);
            if (
              destinationPath === original ||
              destinationPath.startsWith(original + sep) ||
              original.startsWith(destinationPath + sep)
            ) {
              return yield* localFailure("Restore destination overlaps a backup source.");
            }
          }
          if (yield* fs.exists(target)) {
            return yield* localFailure(
              "Restore destination must not exist. Choose a new directory.",
            );
          }
          const snapshot = (yield* list(job)).find((entry) => entry.id === id);
          if (snapshot === undefined) {
            return yield* localFailure("Snapshot was not found for this job and host.");
          }
          yield* validate(snapshot, job);
          yield* invoke(["restore", id, target, "--no-ownership"]);
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Restore failed."),
        ),
      );

      const snapshots = Effect.fn("MacBackup.snapshots")(
        function* (job?: Job) {
          yield* lock();
          return yield* list(job);
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Snapshot inspection failed."),
        ),
      );

      return Backup.of({ run, status, snapshots, check, maintenance, accept, restore });
    }),
  );
}
