import { resolve } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { Console, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { Backup } from "@/backups/backup";
import { launchAgent } from "@/backups/launchd";
import { BackupError, JobState, SnapshotGroups, SnapshotId, jobs } from "@/backups/model";
import { Processes } from "@/backups/process";
import { Secrets, secretNames, importSecretStore } from "@/backups/secrets";
import { Settings } from "@/backups/settings";
import { scheduledTask } from "@/backups/windows";

const root = Command.make("backups").pipe(
  Command.withDescription(
    "macOS and Windows Rustic orchestration with Effect and native credentials",
  ),
  Command.withSharedFlags({
    profile: Flag.String("profile").pipe(
      Flag.optional,
      Flag.withDescription("Independent backup profile from config.toml."),
    ),
  }),
);

const configured = Effect.fn("configured")(function* <A, E>(
  program: Effect.Effect<A, E, Settings | Secrets | Backup | Processes>,
) {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return yield* new BackupError({ message: "This wrapper supports macOS and Windows." });
  }
  const options = yield* root;
  const settings = Settings.layer(Option.getOrUndefined(options.profile)).pipe(
    Layer.provide(BunServices.layer),
  );
  const keychain = Layer.unwrap(
    Effect.gen(function* () {
      return Secrets.layer((yield* Settings).account, process.platform);
    }),
  ).pipe(Layer.provide(settings));
  const dependencies = Layer.mergeAll(
    settings,
    keychain,
    Processes.layer,
    FetchHttpClient.layer,
  ).pipe(Layer.provide(BunServices.layer));
  const live = Backup.layer.pipe(Layer.provideMerge(dependencies));
  return yield* program.pipe(Effect.provide(live));
});

const json = <S extends Schema.Constraint>(schema: S, value: S["Type"]) =>
  Schema.encodeEffect(Schema.fromJsonString(schema, { space: 2 }))(value).pipe(
    Effect.flatMap(Console.log),
  );
const jobArgument = Argument.Literals("job", jobs);
const idArgument = Argument.String("snapshot-id").pipe(Argument.withSchema(SnapshotId));
const selection = Flag.Literals("job", jobs).pipe(Flag.optional);

const report = Effect.fn("report")(function* (states: ReadonlyArray<JobState>) {
  yield* json(Schema.Array(JobState), states);
  if (states.some((state) => state.outcome === "failed" || state.outcome === "review-required")) {
    return yield* new BackupError({
      message:
        "One or more jobs failed or require review. Accepted recovery anchors were preserved.",
    });
  }
});

const run = Command.make(
  "run",
  { job: selection },
  Effect.fn("cli.run")(function* ({ job }) {
    yield* configured(
      Effect.gen(function* () {
        yield* report(
          yield* (yield* Backup).run(
            Option.isSome(job) ? [job.value] : (yield* Settings).jobs,
            false,
          ),
        );
      }),
    );
  }),
).pipe(Command.withDescription("Run selected backups now; no retention or prune"));

const due = Command.make(
  "run-due",
  {},
  Effect.fn("cli.runDue")(function* () {
    yield* configured(
      Effect.gen(function* () {
        const service = yield* Backup;
        const states = yield* service.run((yield* Settings).jobs, true);
        yield* service.check(false, true);
        yield* report(states);
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Catch up daily backups (macOS 10:00, Windows 09:00) and weekly checks after Sunday 15:00",
  ),
);

const status = Command.make(
  "status",
  {},
  Effect.fn("cli.status")(function* () {
    yield* configured(
      Effect.gen(function* () {
        yield* json(Schema.Array(JobState), yield* (yield* Backup).status);
      }),
    );
  }),
).pipe(Command.withDescription("Read local receipts without accessing Keychain or the repository"));

const snapshots = Command.make(
  "snapshots",
  { job: selection },
  Effect.fn("cli.snapshots")(function* ({ job }) {
    yield* configured(
      Effect.gen(function* () {
        yield* json(SnapshotGroups, [
          { snapshots: yield* (yield* Backup).snapshots(Option.getOrUndefined(job)) },
        ]);
      }),
    );
  }),
).pipe(Command.withDescription("Inspect repository snapshots, optionally filtered by job"));

const check = Command.make(
  "check",
  { readData: Flag.Boolean("read-data").pipe(Flag.withDefault(false)) },
  Effect.fn("cli.check")(function* ({ readData }) {
    yield* configured(
      Effect.gen(function* () {
        const startedAt = yield* DateTime.now;
        yield* Console.log(
          readData
            ? "Checking repository metadata and all file data; this may take a while..."
            : "Checking repository metadata; this may take a while...",
        );
        yield* (yield* Backup).check(readData);
        const elapsedSeconds = Math.max(
          0,
          Math.round(
            (DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(startedAt)) /
              1_000,
          ),
        );
        yield* Console.log(
          readData
            ? `Repository check including all file data passed (${elapsedSeconds}s).`
            : `Repository metadata check passed (${elapsedSeconds}s). Use --read-data to verify file packs.`,
        );
      }),
    );
  }),
).pipe(Command.withDescription("Check repository metadata; --read-data also verifies file packs"));

const maintenance = Command.make(
  "maintenance",
  {
    apply: Flag.Boolean("apply").pipe(Flag.withDefault(false)),
    acknowledgeHistory: Flag.Boolean("acknowledge-history").pipe(Flag.withDefault(false)),
  },
  Effect.fn("cli.maintenance")(function* ({ apply, acknowledgeHistory }) {
    yield* configured(
      Effect.gen(function* () {
        const ids = yield* (yield* Backup).maintenance(apply, acknowledgeHistory);
        yield* Console.log(JSON.stringify({ applied: apply, removedSnapshots: ids }, null, 2));
      }),
    );
  }),
).pipe(
  Command.withDescription(
    "Preview retention; --apply explicitly enables forget and two-phase prune",
  ),
);

const accept = Command.make(
  "accept",
  { job: jobArgument, id: idArgument },
  Effect.fn("cli.accept")(function* ({ job, id }) {
    yield* configured(
      Effect.gen(function* () {
        yield* json(JobState, yield* (yield* Backup).accept(job, id));
      }),
    );
  }),
).pipe(Command.withDescription("Approve the exact saved shrinkage candidate after inspection"));

const restore = Command.make(
  "restore",
  { job: jobArgument, id: idArgument, destination: Argument.Directory("destination") },
  Effect.fn("cli.restore")(function* ({ job, id, destination }) {
    yield* configured(
      Effect.gen(function* () {
        yield* (yield* Backup).restore(job, id, destination);
        yield* Console.log(
          `Restored ${id} to ${resolve(destination)}. Compare the recovered files before relying on this backup.`,
        );
      }),
    );
  }),
).pipe(Command.withDescription("Restore a full snapshot into a new non-source directory"));

const secrets = Command.make("secrets").pipe(
  Command.withDescription("Manage backup credentials in the native secret store"),
  Command.withSubcommands([
    Command.make(
      "set",
      { name: Argument.Literals("name", secretNames) },
      Effect.fn("cli.secretsSet")(function* ({ name }) {
        if (!process.stdin.isTTY) {
          return yield* new BackupError({
            message:
              "Secret entry requires an interactive terminal. Values are never accepted in arguments or environment variables.",
          });
        }
        const value = yield* Prompt.Password({ message: `Credential ${name}` });
        const repeated = yield* Prompt.Password({ message: "Repeat secret" });
        if (Redacted.value(value) !== Redacted.value(repeated)) {
          return yield* new BackupError({ message: "Secrets did not match; nothing was stored." });
        }
        yield* configured(
          Effect.gen(function* () {
            yield* (yield* Secrets).set(name, value);
            yield* Console.log(`Stored ${name} in the native credential store.`);
          }),
        );
      }),
    ).pipe(
      Command.withDescription("Interactively store a backup credential without exposing its value"),
    ),
    Command.make(
      "import-secretstore",
      { vault: Flag.String("vault").pipe(Flag.withDefault("ResticVault")) },
      Effect.fn("cli.importSecretStore")(function* ({ vault }) {
        yield* configured(
          importSecretStore(vault).pipe(
            Effect.flatMap((names) =>
              Console.log(
                `Imported and verified: ${names.join(", ")}. Run secrets check; set alert-token if absent.`,
              ),
            ),
          ),
        );
      }),
    ).pipe(
      Command.withDescription(
        "Explicitly migrate Windows SecretStore credentials to Credential Manager",
      ),
    ),
    Command.make(
      "check",
      {},
      Effect.fn("cli.secretsCheck")(function* () {
        yield* configured(
          Effect.gen(function* () {
            const service = yield* Secrets;
            for (const name of secretNames) {
              yield* service.get(name);
              yield* Console.log(`${name}: available`);
            }
          }),
        );
      }),
    ).pipe(
      Command.withDescription("Verify required native credentials without printing their values"),
    ),
  ]),
);

const schedule = Command.make(
  "schedule",
  { binary: Flag.String("binary") },
  Effect.fn("cli.schedule")(function* ({ binary }) {
    yield* configured(
      (process.platform === "win32" ? scheduledTask(binary) : launchAgent(binary)).pipe(
        Effect.flatMap(Console.log),
      ),
    );
  }),
).pipe(
  Command.withDescription(
    "Print a LaunchAgent or Task Scheduler XML for an installed binary; never installs it",
  ),
);

const doctor = Command.make(
  "doctor",
  {},
  Effect.fn("cli.doctor")(function* () {
    yield* configured(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* Console.log(
          JSON.stringify(
            {
              platform: process.platform,
              bun: Bun.version,
              hostname: settings.hostname,
              repository: settings.profile.repository,
              sources: settings.sources,
              stateDirectory: settings.stateDirectory,
              checkedAt: DateTime.formatIso(yield* DateTime.now),
              accessVerified: false,
              note: "Only Rustic traverses sources. Verify native credentials and source access through the real scheduled executable before cutover.",
            },
            null,
            2,
          ),
        );
      }),
    );
  }),
).pipe(
  Command.withDescription("Show resolved backup configuration without accessing the repository"),
);

export const makeBackupsCommand = () =>
  root.pipe(
    Command.withSubcommands([
      doctor,
      status,
      run,
      due,
      snapshots,
      check,
      restore,
      accept,
      maintenance,
      secrets,
      schedule,
    ]),
  );
