import { createHash } from "node:crypto";
import { hostname, homedir, userInfo } from "node:os";
import { resolve, join, win32 } from "node:path";

import { Context, Effect, Layer, Schema } from "effect";

import { composeBackupProfile } from "@/backups/composition";
import { loadConfig } from "@/config/load";
import type { ManagerConfig } from "@/config/types";
import { errorMessage } from "@/errors";
import { syncByorSparseSource } from "@/setup/source";
import type { BackupPlatform } from "@/source/contract";

import { BackupError, Profile, type BackupCredentials, type JobPolicy, type Job } from "./model.ts";
import {
  requireAbsoluteBackupPath,
  resolveBackupBindings,
  substituteBackupPaths,
} from "./paths.ts";

export interface SettingsData {
  readonly repoRoot: string;
  readonly configPath?: string;
  readonly backupProfile?: string;
  readonly home: string;
  readonly account: string;
  readonly hostname: string;
  readonly rustic: string;
  readonly stateDirectory: string;
  readonly logFile: string;
  readonly logDirectory: string;
  readonly credentials: BackupCredentials;
  readonly scheduleLabel: string;
  readonly alert:
    | { readonly protocol: "disabled" }
    | {
        readonly protocol: "v1";
        readonly url: string;
      };
  readonly repository: string;
  readonly profile: Profile;
  readonly jobs: ReadonlyArray<Job>;
  readonly dailyHour: number;
  readonly jobPolicies: Readonly<Record<Job, JobPolicy>>;
  readonly sources: Readonly<Record<Job, ReadonlyArray<string>>>;
  readonly environment: Record<string, string | undefined>;
}

function hostSettings(windows: boolean) {
  const home = homedir();
  const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData/Local");
  return {
    home,
    account: userInfo().username,
    hostname: windows
      ? (process.env.COMPUTERNAME ?? hostname())
      : (hostname().split(".")[0] ?? hostname()),
    rustic: process.env.BACKUP_RUSTIC ?? "rustic",
    stateDirectory: windows
      ? join(localAppData, "rustic-backup")
      : join(home, "Library/Application Support/rustic-backup"),
    logDirectory: windows ? win32.join(localAppData, "rustic") : join(home, "Library/Logs"),
    dailyHour: windows ? 9 : 10,
  };
}

function builtinPaths(windows: boolean, home: string) {
  const entries: Array<[string, string]> = [["HOME", home]];
  if (windows) {
    entries.push(
      ["APPDATA", process.env.APPDATA ?? join(home, "AppData/Roaming")],
      ["USERPROFILE", process.env.USERPROFILE ?? home],
      ["LOCALAPPDATA", process.env.LOCALAPPDATA ?? join(home, "AppData/Local")],
    );
  }
  return Object.fromEntries(entries);
}

function resolveSources(
  profile: Profile,
  substitutions: Readonly<Record<string, string>>,
  platform: BackupPlatform,
): Profile {
  const substitute = (text: string) => substituteBackupPaths(text, substitutions);
  const source = (text: string) => requireAbsoluteBackupPath(substitute(text), platform);
  return {
    ...profile,
    backup: {
      snapshots: profile.backup.snapshots.map((snapshot) => {
        const effective: Profile["backup"]["snapshots"][number] = {
          ...snapshot,
          sources: [source(snapshot.sources[0]), ...snapshot.sources.slice(1).map(source)],
        };
        if (snapshot.globs !== undefined) {
          return { ...effective, globs: snapshot.globs.map(substitute) };
        }
        return effective;
      }),
    },
  };
}

function selectProfile(
  manager: ManagerConfig,
  requested: string | undefined,
  platform: NodeJS.Platform,
) {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Backups support macOS and Windows only.");
  }
  const backups = manager.backups;
  const name = requested ?? backups?.profile;
  const declaration = name === undefined ? undefined : backups?.profiles[name];
  if (backups === undefined || name === undefined || declaration === undefined) {
    throw new Error("Select a declared backup profile with config wizard or backups --profile.");
  }
  if (declaration.platform !== (platform === "win32" ? "windows" : "macos")) {
    throw new Error(`Backup profile ${name} is for ${declaration.platform}, not this host.`);
  }
  return { name, declaration, backups };
}

export async function loadBackupSettings(
  manager: ManagerConfig,
  requested?: string,
  platform = process.platform,
): Promise<SettingsData> {
  const { name, declaration, backups } = selectProfile(manager, requested, platform);
  if (backups.credentials === undefined) {
    throw new Error("Declare native service names in backups.credentials before using backups.");
  }
  const services = Object.values(backups.credentials);
  if (
    new Set(services.map((service) => (platform === "win32" ? service.toUpperCase() : service)))
      .size !== services.length
  ) {
    throw new Error(
      "backups.credentials requires distinct service names, case-insensitively distinct on Windows.",
    );
  }
  if (backups.alertUrl === undefined && backups.alertsDisabled !== true) {
    throw new Error("Configure backups.alertUrl or explicitly set backups.alertsDisabled = true.");
  }
  const repoRoot =
    manager.source?.kind === "local"
      ? manager.source.path
      : (
          await syncByorSparseSource({
            config: manager,
            platform: declaration.platform,
            offline: true,
          })
        ).root;
  const composed = await composeBackupProfile({ root: repoRoot, profile: name, declaration });
  const profile = Schema.decodeUnknownSync(Profile)(composed.document);
  const host = hostSettings(platform === "win32");
  const builtins = builtinPaths(platform === "win32", host.home);
  const substitutions = resolveBackupBindings(declaration.paths, builtins, declaration.platform);
  const effective = resolveSources(profile, substitutions, declaration.platform);
  const logDirectory = requireAbsoluteBackupPath(
    substituteBackupPaths(backups.logDirectory ?? host.logDirectory, builtins),
    declaration.platform,
  );
  return {
    ...host,
    logDirectory,
    logFile: (platform === "win32" ? win32.join : join)(logDirectory, "rustic.log"),
    credentials: backups.credentials,
    scheduleLabel: backups.scheduleLabel ?? `dev.outfitting.backups.${name}`,
    repoRoot: resolve(repoRoot),
    configPath: manager.configPath,
    backupProfile: name,
    alert:
      backups.alertUrl === undefined
        ? { protocol: "disabled" }
        : {
            protocol: "v1",
            url: backups.alertUrl,
          },
    repository: createHash("sha256").update(JSON.stringify(profile.repository)).digest("hex"),
    profile: effective,
    jobs: effective.backup.snapshots.map((snapshot) => snapshot.name),
    jobPolicies: composed.jobs,
    sources: Object.fromEntries(
      effective.backup.snapshots.map((snapshot) => [snapshot.name, snapshot.sources]),
    ),
    environment: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith("AWS_") && !key.startsWith("RUSTIC_"),
      ),
    ),
  };
}

export class Settings extends Context.Service<Settings, SettingsData>()("backup/Settings") {
  static layer(requested?: string, platform = process.platform) {
    return Layer.effect(
      Settings,
      Effect.tryPromise({
        try: async () => loadBackupSettings(await loadConfig(), requested, platform),
        catch: (cause) => new BackupError({ message: errorMessage(cause) }),
      }),
    );
  }
}
