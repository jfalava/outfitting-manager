import { isAbsolute } from "node:path";

import { Effect } from "effect";

import { BackupError } from "./model.ts";
import { Settings, type SettingsData } from "./settings.ts";

// systemd expands % specifiers everywhere and $ variables in ExecStart.
const escape = (value: string) =>
  value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
const quoted = (value: string) => `"${escape(value)}"`;
const argument = (value: string) => quoted(value.replaceAll("$", () => "$$"));

export const systemdUnits = Effect.fn("systemdUnits")(function* (binary: string) {
  const config = yield* Settings;
  if (!isAbsolute(binary) || !isAbsolute(config.rustic)) {
    return yield* new BackupError({
      message: "Use absolute paths for --binary and BACKUP_RUSTIC when generating systemd units.",
    });
  }
  if (config.configPath === undefined || config.backupProfile === undefined) {
    return yield* new BackupError({
      message: "Scheduling requires a config.toml path and backup profile.",
    });
  }
  if (
    [binary, config.rustic, config.configPath, config.repoRoot, config.home].some((value) =>
      /[\n\r]/.test(value),
    )
  ) {
    return yield* new BackupError({ message: "systemd unit paths must not contain newlines." });
  }
  return formatSystemdUnits(binary, {
    ...config,
    configPath: config.configPath,
    backupProfile: config.backupProfile,
  });
});

/** A systemd user service plus an hourly timer; run-due decides what is actually due. */
export function formatSystemdUnits(
  binary: string,
  config: SettingsData & { configPath: string; backupProfile: string },
): string {
  const args = [
    binary,
    "--config",
    config.configPath,
    "backups",
    "--profile",
    config.backupProfile,
    "run-due",
  ];
  // Home Manager profiles live in ~/.nix-profile on other distributions and under
  // /etc/profiles/per-user on NixOS; Rustic hooks resolve their commands through PATH.
  const path = [
    `${config.home}/.nix-profile/bin`,
    `/etc/profiles/per-user/${config.account}/bin`,
    "/run/current-system/sw/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(":");
  const environment = {
    HOME: config.home,
    USER: config.account,
    LOGNAME: config.account,
    PATH: path,
    BACKUP_RUSTIC: config.rustic,
  };
  const variables = Object.entries(environment)
    .map(([key, value]) => `Environment=${quoted(`${key}=${value}`)}`)
    .join("\n");
  return `# ~/.config/systemd/user/${config.scheduleLabel}.service
[Unit]
Description=Outfitting Rustic backups (${config.backupProfile})
# Order after the unit that keeps the Secret Service unlocked, for example:
# After=gnome-keyring-secrets.service
# Wants=gnome-keyring-secrets.service

[Service]
Type=oneshot
WorkingDirectory=${config.repoRoot.replaceAll("%", "%%")}
${variables}
# Bun.secrets reaches the Secret Service through libsecret on the user session bus.
Environment="XDG_RUNTIME_DIR=%t" "DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus"
# A Nix libsecret on LD_LIBRARY_PATH breaks Bun.secrets on non-NixOS hosts.
UnsetEnvironment=LD_LIBRARY_PATH
ExecStart=${args.map(argument).join(" ")}
Nice=10
IOSchedulingClass=idle

# ~/.config/systemd/user/${config.scheduleLabel}.timer
[Unit]
Description=Hourly wake-up for Outfitting Rustic backups (${config.backupProfile})

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target`;
}
