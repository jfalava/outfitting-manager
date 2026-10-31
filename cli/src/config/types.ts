import type { BackupCredentials } from "@/backups/model";
import type { ByorBackupsDeclaration, ByorContract } from "@/source/contract";

/** Platform profile selected for this machine. */
export interface LinuxConfig {
  profile: string;
}

export interface MacosConfig {
  profile: string;
}

export interface WindowsConfig {
  profiles: string[];
}

export interface FontsConfig {
  bucket: string;
}

export type BackupsConfig = {
  profile: string;
  profiles: ByorBackupsDeclaration["profiles"];
  /** Machine-local log directory; supports platform builtin path bindings. */
  logDirectory?: string;
  /** Native service names, not credential values. Required before running backup commands. */
  credentials?: BackupCredentials;
  /** Label used only when generating a macOS LaunchAgent. */
  scheduleLabel?: string;
} & (
  | { alertsDisabled?: true; alertUrl?: never }
  | {
      alertsDisabled?: never;
      /** Full POST /v1/alerts endpoint; the credential selects the email policy. */
      alertUrl: string;
    }
);

export type ConfiguredSource =
  | { kind: "local"; path: string }
  | { kind: "remote"; repository: string; ref: string };

export interface ManagerConfigFile {
  /** Optional override; when omitted, auto `user:arch-os` is used. */
  machineId?: string;
  source?: ConfiguredSource;
  linux?: LinuxConfig;
  macos?: MacosConfig;
  windows?: WindowsConfig;
  fonts?: FontsConfig;
  backups?: BackupsConfig;
  declarations?: ByorContract;
}

export interface ManagerConfig {
  /** Absolute path to the authoritative TOML configuration. */
  configPath: string;
  /** Absolute state root directory. */
  stateRoot: string;
  /** Effective machine id used for lock/inventory pushes. */
  machineId: string;
  /** Whether machineId came from config/env (true) or auto-detect (false). */
  machineIdOverridden: boolean;
  /** Selected source, resolved against configPath when local. */
  source?: ConfiguredSource;
  /** Configured platform selections; flags/environment may override per invocation. */
  linux?: LinuxConfig;
  macos?: MacosConfig;
  windows?: WindowsConfig;
  fonts?: FontsConfig;
  backups?: BackupsConfig;
  /** Validated profile declarations, absent until configured. */
  declarations?: ByorContract;
}
