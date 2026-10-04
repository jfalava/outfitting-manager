import { Schema } from "effect";

export class BackupError extends Schema.TaggedError<BackupError>()("BackupError", {
  message: Schema.String,
}) {}

// Job IDs are also receipt filenames and single Rustic identity tags.
export const Job = Schema.String.check(
  Schema.isPattern(/^(?!check$|con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)[a-z0-9][a-z0-9_-]{0,63}$/),
);
export type Job = typeof Job.Type;

export const SnapshotId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Snapshot = Schema.Struct({
  id: Schema.optionalKey(SnapshotId),
  parent: Schema.optionalKey(SnapshotId),
  tree: SnapshotId,
  hostname: Schema.NonEmptyString,
  paths: Schema.NonEmptyArray(Schema.NonEmptyString),
  tags: Schema.Array(Schema.String),
  time: Schema.DateTimeUtcFromString,
  delete: Schema.optionalKey(Schema.Unknown),
  summary: Schema.Struct({
    total_files_processed: Count,
    total_bytes_processed: Count,
  }),
});
export type Snapshot = typeof Snapshot.Type;

// Historical metadata can contain empty paths or omit backup statistics.
// New backup results still use the strict Snapshot schema above.
export const SnapshotMetadata = Schema.Struct({
  ...Snapshot.fields,
  paths: Schema.Array(Schema.String),
  summary: Schema.optionalKey(Snapshot.fields.summary),
});
export type SnapshotMetadata = typeof SnapshotMetadata.Type;

export const Anchor = Schema.Struct({
  id: SnapshotId,
  tree: SnapshotId,
  files: Count,
  bytes: Count,
});
export type Anchor = typeof Anchor.Type;

export const JobState = Schema.Struct({
  version: Schema.Literal(1),
  repository: Schema.NonEmptyString,
  hostname: Schema.NonEmptyString,
  job: Job,
  startedAt: Schema.DateTimeUtcFromString,
  finishedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  outcome: Schema.Literals([
    "running",
    "accepted-changed",
    "accepted-unchanged",
    "failed",
    "review-required",
  ]),
  error: Schema.optionalKey(Schema.String),
  acceptedAt: Schema.optionalKey(Schema.DateTimeUtcFromString),
  current: Schema.optionalKey(Anchor),
  previous: Schema.optionalKey(Anchor),
  candidate: Schema.optionalKey(Anchor),
  knownIds: Schema.Array(SnapshotId),
});
export type JobState = typeof JobState.Type;

const RetentionCount = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(-1),
  Schema.isLessThanOrEqualTo(2_147_483_647),
);
export const RetentionCounters = Schema.Struct({
  "keep-daily": Schema.optionalKey(RetentionCount),
  "keep-weekly": Schema.optionalKey(RetentionCount),
  "keep-monthly": Schema.optionalKey(RetentionCount),
});
export const Retention = Schema.Struct({
  ...RetentionCounters.fields,
  "keep-id": Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});

export const JobPolicy = Schema.Struct({
  retention: Schema.optionalKey(RetentionCounters),
  skipIfProcessesRunning: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/))).check(
      Schema.isMaxLength(32),
    ),
  ),
});
export type JobPolicy = typeof JobPolicy.Type;

export const Profile = Schema.Struct({
  repository: Schema.Struct({
    repository: Schema.NonEmptyString,
    options: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
  forget: Retention,
  backup: Schema.Struct({
    snapshots: Schema.Array(
      Schema.Struct({
        name: Job,
        sources: Schema.NonEmptyArray(Schema.NonEmptyString),
        tags: Schema.NonEmptyArray(Schema.NonEmptyString),
        globs: Schema.optionalKey(Schema.Array(Schema.String)),
        "skip-if-unchanged": Schema.Boolean,
      }),
    ).check(Schema.isMinLength(1)),
  }),
});
export type Profile = typeof Profile.Type;

export const SnapshotGroups = Schema.Array(
  Schema.Struct({ snapshots: Schema.Array(SnapshotMetadata) }),
);
export const RetentionPlan = Schema.Array(
  Schema.Struct({
    items: Schema.Array(
      Schema.Struct({
        snapshot: SnapshotMetadata,
        keep: Schema.Boolean,
      }),
    ),
  }),
);
