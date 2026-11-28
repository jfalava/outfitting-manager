import { uptime } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { Context, DateTime, Effect, FileSystem, Layer, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { stringify } from "smol-toml";

import { commandPrefix } from "@/config/paths";

import {
  Anchor,
  BackupError,
  Job,
  JobState,
  RetentionPlan,
  Snapshot,
  SnapshotGroups,
  type SnapshotMetadata,
} from "./model.ts";
import { Processes, parseJson, successful } from "./process.ts";
import { Secrets } from "./secrets.ts";
import { Settings, type SettingsData } from "./settings.ts";

const startOfHour = (time: DateTime.Zoned, hour: number) =>
  DateTime.setParts(time, { hour, minute: 0, second: 0, millisecond: 0 });

/**
 * Daily (the default): due once per local day from `hour`; an earlier same-day event counts.
 * Shorter intervals: slots start every `intervalHours` from `hour`, wrapping across midnight,
 * and something is due when `since` (the last accepted backup or alert) predates the current slot.
 */
export const isDue = (
  since: DateTime.Utc | undefined,
  now: DateTime.Utc,
  zone = DateTime.zoneMakeLocal(),
  { hour = 10, intervalHours = 24 }: { hour?: number; intervalHours?: number } = {},
) => {
  const local = DateTime.setZone(now, zone);
  const current = DateTime.toParts(local).hour;
  const first = hour % intervalHours;
  let start: DateTime.Zoned;
  if (intervalHours >= 24) {
    if (current < hour) {
      return false;
    }
    start = startOfHour(local, 0);
  } else if (current >= first) {
    start = startOfHour(
      local,
      first + Math.floor((current - first) / intervalHours) * intervalHours,
    );
  } else {
    start = startOfHour(DateTime.subtract(local, { days: 1 }), first + 24 - intervalHours);
  }
  return since === undefined || DateTime.toEpochMillis(since) < DateTime.toEpochMillis(start);
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

const canonicalPath = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

const localFailure = (message: string) => new BackupError({ message });

// Rustic warns when a cache file it is removing is already gone; the repository is unaffected.
const missingCacheFile =
  /^.*\[WARN\] Error in cache backend removing .*No such file or directory.*$/gm;

const LockOwner = Schema.Struct({ pid: Schema.Int, startedAt: Schema.DateTimeUtcFromString });

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const backupDue = (state: JobState | undefined, now: DateTime.Utc, config: SettingsData) =>
  isDue(state?.acceptedAt, now, DateTime.zoneMakeLocal(), {
    hour: config.dailyHour,
    intervalHours: config.intervalHours,
  });

// Repeating alerts go out once per local day from the profile's daily hour.
const alertDue = (since: DateTime.Utc | undefined, now: DateTime.Utc, hour: number) =>
  isDue(since, now, DateTime.zoneMakeLocal(), { hour, intervalHours: 24 });

// An unconfirmed first review alert has no alertedAt and is retried at once,
// even before the daily hour.
const reminderDue = (state: JobState, now: DateTime.Utc, hour: number) =>
  state.alertedAt === undefined || alertDue(state.alertedAt, now, hour);

// Last confirmed run-failure alert. Never a .json file: maintenance treats those as receipts.
const RUN_ALERT_STAMP = "run-alert.stamp";

function managerCommand(config: SettingsData): string {
  return [
    config.configPath === undefined
      ? "outfitting-manager"
      : commandPrefix(config.configPath, process.platform === "win32"),
    "backups",
    ...(config.backupProfile === undefined ? [] : ["--profile", config.backupProfile]),
  ].join(" ");
}

function reviewMessage(state: JobState, command: string): string {
  const { job, candidate, current } = state;
  const since = DateTime.formatIso(state.finishedAt ?? state.startedAt);
  return [
    `${job} has a candidate snapshot waiting for review since ${since}. Until you accept or reject it, ${job} is not backed up.`,
    state.error,
    candidate === undefined
      ? undefined
      : `Candidate ${candidate.id}: ${candidate.files} files, ${candidate.bytes} bytes.`,
    current === undefined
      ? undefined
      : `Last accepted ${current.id}: ${current.files} files, ${current.bytes} bytes.`,
    `Inspect: ${command} snapshots --job ${job}`,
    candidate === undefined ? undefined : `Accept: ${command} accept ${job} ${candidate.id}`,
    candidate === undefined ? undefined : `Reject: ${command} reject ${job} ${candidate.id}`,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

// A lock is stale when its owner exited, the machine rebooted since it was taken,
// or it is a day old. Anything else is another operation still running.
const lockFailure = Effect.fn("Backup.lockFailure")(function* (
  fs: FileSystem.FileSystem,
  lockPath: string,
) {
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const owner = yield* fs
    .readFileString(join(lockPath, "owner.json"))
    .pipe(Effect.flatMap(parseJson(LockOwner)), Effect.option);
  let stale: boolean;
  if (Option.isSome(owner)) {
    const startedAt = DateTime.toEpochMillis(owner.value.startedAt);
    stale =
      !processAlive(owner.value.pid) ||
      startedAt < now - uptime() * 1_000 ||
      now - startedAt > 24 * 60 * 60 * 1_000;
  } else {
    // The owner file is written right after the directory; give a new lock a moment.
    const modified = (yield* fs.stat(lockPath).pipe(Effect.option)).pipe(
      Option.flatMap((info) => info.mtime),
    );
    stale = Option.isSome(modified) && now - modified.value.getTime() > 5 * 60 * 1_000;
  }
  return stale
    ? new BackupError({
        message: `Stale repository lock: ${lockPath}. Its process is gone, so every backup operation is blocked. Confirm nothing is running, then remove that directory.`,
        reason: "stale-lock",
      })
    : new BackupError({
        message: `Repository lock unavailable: ${lockPath}. Another backup operation is running; this one was skipped.`,
        reason: "lock",
      });
});

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
    snapshots(job?: Job): Effect.Effect<ReadonlyArray<SnapshotMetadata>, BackupError>;
    check(readData: boolean, due?: boolean): Effect.Effect<boolean, BackupError>;
    maintenance(
      apply: boolean,
      acknowledgeHistory: boolean,
    ): Effect.Effect<ReadonlyArray<string>, BackupError>;
    accept(job: Job, id: string): Effect.Effect<JobState, BackupError>;
    reject(job: Job, id: string): Effect.Effect<JobState, BackupError>;
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
      const directory = join(config.stateDirectory, config.repository);
      const statePath = (job: Job) => join(directory, `${job}.json`);
      const requireJob = (job: Job) =>
        Schema.is(Job)(job) && jobs.includes(job)
          ? Effect.void
          : Effect.fail(localFailure(`Job ${job} is not configured in this backup profile.`));
      const policy = (job: Job) =>
        Object.hasOwn(config.jobPolicies, job) ? config.jobPolicies[job] : undefined;
      const decodeState = parseJson(JobState);
      const encodeState = Schema.encodeEffect(Schema.fromJsonString(JobState, { space: 2 }));

      const readState = Effect.fn("MacBackup.readState")(
        function* (job: Job) {
          const raw = yield* fs.readFileString(statePath(job)).pipe(
            Effect.asSome,
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
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

      const lockPath = join(directory, "repository.lock");

      const lock = Effect.fn("MacBackup.lock")(function* () {
        yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
        const path = lockPath;
        yield* Effect.acquireRelease(
          fs
            .makeDirectory(path, { mode: 0o700 })
            .pipe(Effect.catch(() => Effect.flatMap(lockFailure(fs, path), Effect.fail))),
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
          // Manager pins are passed as --keep-id during maintenance, not Rustic TOML fields.
          const { "keep-id": _keepIds, ...retention } = config.profile.forget;
          const profile = {
            ...config.profile,
            global: { "log-file": config.logFile, "log-level-logfile": "info" },
            forget: { ...retention, "delete-unchanged": false },
            backup: {
              snapshots: config.profile.backup.snapshots.map((snapshot) => ({
                ...snapshot,
                "skip-if-unchanged": saveSnapshot ? snapshot["skip-if-unchanged"] : false,
              })),
            },
          };
          yield* fs.makeDirectory(dirname(config.logFile), { recursive: true, mode: 0o700 });
          const toml = yield* Schema.decodeEffect(Schema.String)(stringify(profile));
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
          if (/\[(WARN|ERROR)\]/.test(stderr.replaceAll(missingCacheFile, ""))) {
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
        function* (operation: string, message: string, job?: Job) {
          if (config.alert.protocol === "disabled") {
            return false;
          }
          const token = yield* secrets.get("alert-token");
          const timestamp = DateTime.formatIso(yield* DateTime.now);
          const payload = {
            title: `Backup alert: ${operation} on ${config.hostname}`
              // eslint-disable-next-line no-control-regex -- Email subjects cannot contain controls.
              .replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, " ")
              .slice(0, 200)
              .trim(),
            message: message.replaceAll("\0", "").slice(0, 4_000),
            timestamp,
            // No numeric exit code survives all backup validation failures.
            metadata: {
              hostname: config.hostname,
              operation,
              job,
            },
          };
          const body = JSON.stringify(payload);
          if (Buffer.byteLength(body, "utf8") > 32_768) {
            return yield* localFailure("Alert payload exceeds the service's 32 KiB limit.");
          }
          const response = yield* client.execute(
            HttpClientRequest.post(config.alert.url).pipe(
              HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(token)}`),
              HttpClientRequest.bodyText(body, "application/json"),
            ),
          );
          if (response.status !== 202) {
            return yield* localFailure("Alert service did not confirm provider acceptance.");
          }
          yield* Schema.decodeUnknownEffect(
            Schema.Struct({ sent: Schema.Literal(true), message_id: Schema.NonEmptyString }),
          )(yield* response.json);
          return true;
        },
        Effect.timeout("20 seconds"),
        Effect.catch(() =>
          Effect.as(
            Effect.logWarning(
              "Failure notification was not confirmed accepted; original backup outcome is unchanged.",
            ),
            false,
          ),
        ),
      );

      // The stamp records the last confirmed alert; it is never a .json file, which
      // maintenance would treat as a retired receipt.
      const notifyDaily = Effect.fn("Backup.notifyDaily")(
        function* (stamp: string, operation: string, message: string) {
          const now = yield* DateTime.now;
          const last = yield* fs.readFileString(stamp).pipe(
            Effect.map((text) => DateTime.make(text.trim())),
            Effect.orElseSucceed(() => Option.none<DateTime.Utc>()),
          );
          if (!alertDue(Option.getOrUndefined(last), now, config.dailyHour)) {
            return;
          }
          if (yield* notify(operation, message)) {
            yield* fs.makeDirectory(dirname(stamp), { recursive: true, mode: 0o700 });
            yield* fs.writeFileString(stamp, DateTime.formatIso(now), { mode: 0o600 });
          }
        },
        (effect) => Effect.ignore(effect),
      );

      // The first alert always goes out; reminders only from scheduled runs, once per local
      // day. An unconfirmed alert is not recorded, so the next scheduled wake-up retries it.
      const alertReview = Effect.fn("Backup.alertReview")(function* (
        state: JobState,
        reminder?: { scheduled: boolean },
      ) {
        if (
          reminder !== undefined &&
          !(reminder.scheduled && reminderDue(state, yield* DateTime.now, config.dailyHour))
        ) {
          return state;
        }
        const operation =
          reminder === undefined
            ? `rustic backup (${state.job})`
            : `backup review reminder (${state.job})`;
        const message = reviewMessage(state, managerCommand(config));
        if (!(yield* notify(operation, message, state.job))) {
          return state;
        }
        const alerted: JobState = { ...state, alertedAt: yield* DateTime.now };
        return yield* writeState(alerted).pipe(
          Effect.as(alerted),
          Effect.catch(() =>
            Effect.as(
              Effect.logWarning("Could not record the review alert; it may be repeated."),
              state,
            ),
          ),
        );
      });

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

      const validate = Effect.fn("MacBackup.validate")(function* (
        snapshot: SnapshotMetadata,
        job: Job,
      ) {
        const sources = paths(job).map(canonicalPath).toSorted();
        if (
          snapshot.hostname !== config.hostname ||
          !snapshot.tags.includes(job) ||
          jobs.filter((name) => snapshot.tags.includes(name)).length !== 1 ||
          snapshot.paths.length !== sources.length ||
          snapshot.paths.some((path) => path.length === 0) ||
          snapshot.paths
            .map(canonicalPath)
            .toSorted()
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
        if (receipt.outcome === "failed") {
          yield* notify(`rustic backup (${job})`, receipt.error ?? receipt.outcome, job);
        }
        if (receipt.outcome === "review-required") {
          // Recording the alert keeps the next wake-up from reminding right away.
          receipt = yield* alertReview(receipt);
        }
        return receipt;
      });

      const status = Effect.forEach(jobs, readState).pipe(
        Effect.map((states) => states.filter((state) => state !== undefined)),
      );
      const run = Effect.fn("MacBackup.run")(
        function* (selected: ReadonlyArray<Job>, due: boolean) {
          for (const job of selected) {
            yield* requireJob(job);
          }
          yield* lock();
          const results: Array<JobState> = [];
          const errors: Array<string> = [];
          for (const job of selected) {
            yield* Effect.gen(function* () {
              const previous = yield* readState(job);
              if (previous?.outcome === "review-required") {
                results.push(yield* alertReview(previous, { scheduled: due }));
                return;
              }
              if (due && !backupDue(previous, yield* DateTime.now, config)) {
                return;
              }
              const guardedProcesses = policy(job)?.skipIfProcessesRunning ?? [];
              if (guardedProcesses.length > 0) {
                const running = yield* processes
                  .run(
                    "pwsh.exe",
                    [
                      "-NoProfile",
                      "-NonInteractive",
                      "-Command",
                      "$ErrorActionPreference = 'Stop'; $names = ConvertFrom-Json -InputObject $env:OUTFITTING_BACKUP_PROCESSES; $running = @(Get-Process -ErrorAction Stop | Where-Object { $names -contains $_.ProcessName }); if ($running.Count -gt 0) { Write-Output 'running' } else { Write-Output 'stopped' }",
                    ],
                    {
                      ...config.environment,
                      OUTFITTING_BACKUP_PROCESSES: JSON.stringify(guardedProcesses),
                    },
                  )
                  .pipe(
                    Effect.timeout("10 seconds"),
                    Effect.mapError(() =>
                      localFailure(
                        `Could not verify running processes for ${job}; backup was not started.`,
                      ),
                    ),
                  );
                if (
                  running.exitCode !== 0 ||
                  running.stderr.trim().length > 0 ||
                  !["running", "stopped"].includes(running.stdout.trim())
                ) {
                  return yield* localFailure(
                    `Could not verify running processes for ${job}; backup was not started.`,
                  );
                }
                if (running.stdout.trim() === "running") {
                  yield* Effect.logInfo(
                    `A guarded process is running; ${job} remains due and will retry on the next wake-up.`,
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
        // Scheduled runs only. A success re-arms the daily run-failure alert. Another
        // operation holding the lock is not a fault: the jobs stay due and the next
        // wake-up retries.
        (effect, _selected, due) =>
          due
            ? effect.pipe(
                Effect.tap(() => fs.remove(join(directory, RUN_ALERT_STAMP)).pipe(Effect.ignore)),
                Effect.tapError((error) =>
                  error.reason === "lock"
                    ? Effect.void
                    : notifyDaily(
                        error.reason === "stale-lock"
                          ? join(lockPath, "alerted-at")
                          : join(directory, RUN_ALERT_STAMP),
                        "rustic backup run",
                        error.message,
                      ),
                ),
              )
            : effect,
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
        Effect.tapError((error) =>
          error.reason === undefined
            ? notify("rustic repository check", error.message)
            : Effect.void,
        ),
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
        inventory: ReadonlyArray<SnapshotMetadata>,
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

      const requireActiveReceipts = Effect.gen(function* () {
        const retired = (yield* fs.readDirectory(directory)).filter(
          (file) =>
            file.endsWith(".json") && file !== "check.json" && !jobs.includes(file.slice(0, -5)),
        );
        if (retired.length > 0) {
          return yield* localFailure(
            `Receipts for removed jobs require explicit reconciliation before deletion: ${retired.join(", ")}. Recovery anchors were preserved.`,
          );
        }
      });

      const maintenance = Effect.fn("MacBackup.maintenance")(
        function* (apply: boolean, acknowledgeHistory: boolean) {
          yield* lock();
          if (apply) {
            yield* requireActiveReceipts;
          }
          const states = yield* maintenanceStates;
          const anchors = states.flatMap((state) =>
            [state.current, state.previous].filter((anchor) => anchor !== undefined),
          );
          yield* verifyStates(states);
          const known = new Set(states.flatMap((state) => state.knownIds));
          const inventory = yield* list();
          if (
            inventory.some(
              (snapshot) =>
                snapshot.hostname === config.hostname &&
                jobs.filter((job) => snapshot.tags.includes(job)).length > 1,
            )
          ) {
            return yield* localFailure(
              "Snapshot tags overlap multiple configured jobs; retention requires reconciliation.",
            );
          }
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
              ...Object.entries(policy(job)?.retention ?? {}).flatMap(([key, value]) => [
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
        // Weekly by schedule; previews are interactive and never alert.
        (effect, apply) =>
          Effect.tapError(effect, (error) =>
            apply ? notify("rustic maintenance", error.message) : Effect.void,
          ),
      );

      const accept = Effect.fn("MacBackup.accept")(
        function* (job: Job, id: string) {
          yield* requireJob(job);
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
          const { error: _error, alertedAt: _alertedAt, ...clean } = accepted;
          yield* writeState(clean);
          return clean;
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Could not accept candidate."),
        ),
      );

      // Discards the candidate and leaves the accepted anchors untouched; acceptedAt does not
      // move, so the job backs up again in its next scheduled slot.
      const reject = Effect.fn("Backup.reject")(
        function* (job: Job, id: string) {
          yield* requireJob(job);
          yield* lock();
          const state = yield* readState(job);
          if (state?.outcome !== "review-required" || state.candidate?.id !== id) {
            return yield* localFailure("Only the exact review-required candidate can be rejected.");
          }
          const { candidate: _candidate, alertedAt: _alertedAt, ...rest } = state;
          const rejected: JobState = {
            ...rest,
            outcome: "failed",
            error: `Candidate ${id} was rejected; ${job} backs up again in its next scheduled slot.`,
          };
          yield* writeState(rejected);
          return rejected;
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Could not reject candidate."),
        ),
      );

      const restore = Effect.fn("MacBackup.restore")(
        function* (job: Job, id: string, destination: string) {
          yield* requireJob(job);
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
          if (job !== undefined) {
            yield* requireJob(job);
          }
          yield* lock();
          return yield* list(job);
        },
        Effect.scoped,
        Effect.mapError((error) =>
          Schema.is(BackupError)(error) ? error : localFailure("Snapshot inspection failed."),
        ),
      );

      return Backup.of({ run, status, snapshots, check, maintenance, accept, reject, restore });
    }),
  );
}
