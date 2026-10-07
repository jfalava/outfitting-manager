import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { Schema } from "effect";
import {
  parse as parseToml,
  stringify as stringifyToml,
  type TomlValueWithoutBigInt,
} from "smol-toml";

import { Profile, type JobPolicy } from "@/backups/model";
import {
  normalizeBackupPath,
  normalizeBackups,
  type BackupProfileDeclaration,
} from "@/source/contract";

export type TomlTable = Record<string, TomlValueWithoutBigInt>;

function isTable(value: TomlValueWithoutBigInt): value is TomlTable {
  return Schema.is(Schema.Record(Schema.String, Schema.Unknown))(value) && !(value instanceof Date);
}

const decodeSnapshots = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ name: Schema.NonEmptyString })),
);

function appendSnapshots(
  previous: TomlValueWithoutBigInt | undefined,
  value: TomlValueWithoutBigInt[],
): TomlValueWithoutBigInt[] {
  const snapshots = Array.isArray(previous) ? [...previous, ...value] : [...value];
  const names = new Set<string>();
  for (const snapshot of decodeSnapshots(snapshots)) {
    if (names.has(snapshot.name)) {
      throw new Error(`Duplicate backup snapshot name: ${snapshot.name}.`);
    }
    names.add(snapshot.name);
  }
  return snapshots;
}

function mergeValue(
  left: TomlValueWithoutBigInt,
  right: TomlValueWithoutBigInt,
  path: string,
): TomlValueWithoutBigInt {
  if (isTable(left) && isTable(right)) {
    return mergeTable(left, right, path);
  }
  return right;
}

function mergeTable(left: TomlTable, right: TomlTable, path = ""): TomlTable {
  const result: TomlTable = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const currentPath = path.length > 0 ? `${path}.${key}` : key;
    if (currentPath === "backup.snapshots" && Array.isArray(value)) {
      result[key] = appendSnapshots(result[key], value);
    } else if (key in result) {
      result[key] = mergeValue(result[key]!, value, currentPath);
    } else {
      result[key] = isTable(value) ? mergeTable({}, value, currentPath) : value;
    }
  }
  return result;
}

export function composeTomlDocuments(documents: ReadonlyArray<TomlTable>): TomlTable {
  return documents.reduce((result, document) => mergeTable(result, document), {});
}

export interface ComposedBackupProfile {
  profile: string;
  platform: BackupProfileDeclaration["platform"];
  files: string[];
  jobs: Readonly<Record<string, JobPolicy>>;
  hash: string;
  document: TomlTable;
  toml: string;
}

const LegacyGlobal = Schema.Struct({
  "log-file": Schema.optionalKey(Schema.String),
  "log-level-logfile": Schema.optionalKey(Schema.Literal("info")),
  hooks: Schema.optionalKey(
    Schema.Struct({
      "run-failed": Schema.Array(
        Schema.Struct({ command: Schema.NonEmptyString, "on-failure": Schema.Literal("warn") }),
      ),
    }),
  ),
});
const RepositoryOptions = Schema.Struct({
  bucket: Schema.optionalKey(Schema.NonEmptyString),
  endpoint: Schema.optionalKey(Schema.NonEmptyString),
  region: Schema.optionalKey(Schema.NonEmptyString),
  root: Schema.optionalKey(Schema.NonEmptyString),
});

async function safeSourcePath(root: string, path: string): Promise<string> {
  const normalized = normalizeBackupPath(path);
  const physicalRoot = await realpath(root);
  const absolute = await realpath(join(physicalRoot, normalized));
  const rel = relative(physicalRoot, absolute).split(sep).join("/");
  if (isAbsolute(rel) || rel === ".." || rel === "" || rel.startsWith("../")) {
    throw new Error(`Backup file is outside the source root: ${path}.`);
  }
  return absolute;
}

export async function composeBackupProfile(options: {
  root: string;
  profile: string;
  declaration: BackupProfileDeclaration;
}): Promise<ComposedBackupProfile> {
  const declaration = normalizeBackups({
    defaultProfile: options.profile,
    profiles: { [options.profile]: options.declaration },
  })!.profiles[options.profile]!;
  const documents: TomlTable[] = [];
  for (const path of declaration.files) {
    const source = await safeSourcePath(options.root, path);
    let parsed: TomlTable;
    try {
      parsed = parseToml(await readFile(source, "utf8"), { integersAsBigInt: false });
    } catch (cause) {
      throw new Error(`Backup TOML ${path} is missing or invalid.`, { cause });
    }
    documents.push(parsed);
  }
  const document = composeTomlDocuments(documents);
  const jobs = declaration.jobs ?? {};
  validateComposedBackup(document, declaration.platform, jobs);
  const canonical = JSON.stringify({
    platform: declaration.platform,
    files: declaration.files,
    document,
    jobs,
  });
  return {
    profile: options.profile,
    platform: declaration.platform,
    files: [...declaration.files],
    jobs,
    hash: createHash("sha256").update(canonical).digest("hex"),
    document,
    toml: `${stringifyToml(document).trimEnd()}\n`,
  };
}

export function validateComposedBackup(
  document: TomlTable,
  platform: BackupProfileDeclaration["platform"],
  policies: Readonly<Record<string, JobPolicy>> = {},
): void {
  // Legacy global logging/hooks are deliberately replaced by manager-owned logging and alerts.
  const { global, ...managed } = document;
  if (global !== undefined) {
    Schema.decodeUnknownSync(LegacyGlobal, { onExcessProperty: "error" })(global);
  }
  const profile = Schema.decodeUnknownSync(Profile, { onExcessProperty: "error" })(managed);
  if (profile.repository.options !== undefined) {
    Schema.decodeSync(RepositoryOptions, { onExcessProperty: "error" })(profile.repository.options);
  }
  validateJobInventory(profile, policies);
  for (const snapshot of profile.backup.snapshots) {
    validateSubstitutions([...snapshot.sources, ...(snapshot.globs ?? [])], platform);
  }
}

function validateJobInventory(profile: Profile, policies: Readonly<Record<string, JobPolicy>>) {
  const names = new Set(profile.backup.snapshots.map((snapshot) => snapshot.name));
  if (names.size !== profile.backup.snapshots.length) {
    throw new Error("Backup snapshot names must be unique.");
  }
  for (const job of Object.keys(policies)) {
    if (!names.has(job)) {
      throw new Error(`Job policy ${job} does not match a declared Rustic snapshot.`);
    }
  }
  for (const snapshot of profile.backup.snapshots) {
    if (
      !snapshot.tags.includes(snapshot.name) ||
      snapshot.tags.some(
        (tag) =>
          tag.length === 0 ||
          tag.trim() !== tag ||
          tag.includes(",") ||
          [...tag].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
          (tag !== snapshot.name && names.has(tag)),
      )
    ) {
      throw new Error(
        `Snapshot ${snapshot.name} must have only its own job identity tag; tags cannot contain commas, controls, or surrounding whitespace.`,
      );
    }
    const { "keep-id": _ids, ...defaults } = profile.forget;
    const policy = Object.hasOwn(policies, snapshot.name) ? policies[snapshot.name] : undefined;
    const retention = {
      ...defaults,
      ...policy?.retention,
    };
    if (!Object.values(retention).some((count) => count !== undefined && count !== 0)) {
      throw new Error(`Job ${snapshot.name} needs at least one enabled retention counter.`);
    }
  }
}

function validateSubstitutions(
  values: ReadonlyArray<string>,
  platform: BackupProfileDeclaration["platform"],
): void {
  const allowed =
    platform === "macos"
      ? ["PROTON_DRIVE_PATH", "PROTON_IMAGES_DIR"]
      : ["APPDATA", "USERPROFILE", "LOCALAPPDATA"];
  for (const value of values) {
    for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
      if (!allowed.includes(match[1]!)) {
        throw new Error(`Unsupported backup substitution: ${match[1]}.`);
      }
    }
  }
}

export function backupPlan(profile: ComposedBackupProfile): string {
  return [
    `profile: ${profile.profile}`,
    `platform: ${profile.platform}`,
    `files:`,
    ...profile.files.map((file) => `  - ${file}`),
    `job policies: ${JSON.stringify(profile.jobs)}`,
    `declaration hash: ${profile.hash}`,
  ].join("\n");
}
