import { createHash } from "node:crypto";
import { hostname, homedir, userInfo } from "node:os";
import { resolve, join } from "node:path";

import { Context, Effect, Layer, Schema } from "effect";

import { composeBackupProfile } from "@/backups/composition";
import { loadConfig } from "@/config/load";
import type { ManagerConfig } from "@/config/types";
import { syncByorSparseSource } from "@/setup/source";

import { BackupError, Profile, Retention, macJobs, windowsJobs, type Job } from "./model.ts";

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
  readonly alertUrl: string;
  readonly repository: string;
  readonly profile: Profile;
  readonly jobs: ReadonlyArray<Job>;
  readonly dailyHour: number;
  readonly jobRetention: Partial<Record<Job, typeof Retention.Type>>;
  readonly sources: Partial<Record<Job, ReadonlyArray<string>>>;
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
    logFile: windows
      ? join(localAppData, "rustic/rustic-gaming-pc.log")
      : join(home, "Library/Logs/rustic-protondrive.log"),
    dailyHour: windows ? 9 : 10,
    jobs: windows ? windowsJobs : macJobs,
    jobRetention: windows ? { "mmo-screenshots": { "keep-monthly": 3 } } : {},
  };
}

function substitutionsFor(windows: boolean, home: string) {
  if (windows) {
    return {
      APPDATA: process.env.APPDATA ?? join(home, "AppData/Roaming"),
      USERPROFILE: process.env.USERPROFILE ?? home,
      LOCALAPPDATA: process.env.LOCALAPPDATA ?? join(home, "AppData/Local"),
    };
  }
  const drive =
    process.env.PROTON_DRIVE_PATH ??
    join(home, "Library/CloudStorage/ProtonDrive-jfalava@protonmail.com-folder");
  return {
    PROTON_DRIVE_PATH: drive,
    PROTON_IMAGES_DIR: process.env.PROTON_IMAGES_DIR ?? join(drive, "Imágenes".normalize("NFD")),
  };
}

function resolveSources(
  profile: Profile,
  substitutions: Record<string, string | undefined>,
): Profile {
  const substitute = (text: string) =>
    text.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      const value = substitutions[key];
      if (value === undefined) {
        throw new Error(`Unsupported backup substitution: ${key}.`);
      }
      return value;
    });
  return {
    ...profile,
    backup: {
      snapshots: profile.backup.snapshots.map((snapshot) => {
        const effective: Profile["backup"]["snapshots"][number] = {
          ...snapshot,
          sources: [substitute(snapshot.sources[0]), ...snapshot.sources.slice(1).map(substitute)],
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
  const name = requested ?? manager.backups?.profile;
  const declaration = name === undefined ? undefined : manager.backups?.profiles[name];
  if (name === undefined || declaration === undefined) {
    throw new Error("Select a declared backup profile with config wizard or backups --profile.");
  }
  if (declaration.platform !== (platform === "win32" ? "windows" : "macos")) {
    throw new Error(`Backup profile ${name} is for ${declaration.platform}, not this host.`);
  }
  return { name, declaration };
}

export async function loadBackupSettings(
  manager: ManagerConfig,
  requested?: string,
  platform = process.platform,
): Promise<SettingsData> {
  const { name, declaration } = selectProfile(manager, requested, platform);
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
  const effective = resolveSources(profile, substitutionsFor(platform === "win32", host.home));
  return {
    ...host,
    repoRoot: resolve(repoRoot),
    configPath: manager.configPath,
    backupProfile: name,
    alertUrl: "https://backup-alert.jfalava.workers.dev/",
    repository: createHash("sha256").update(JSON.stringify(profile.repository)).digest("hex"),
    profile: effective,
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
        catch: (cause) => new BackupError({ message: String(cause) }),
      }),
    );
  }
}
