import { isAbsolute, join } from "node:path";

import { Effect } from "effect";

import { BackupError } from "./model.ts";
import { Settings } from "./settings.ts";

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const launchAgent = Effect.fn("launchAgent")(function* (binary: string) {
  const config = yield* Settings;
  if (!isAbsolute(binary) || !isAbsolute(config.rustic)) {
    return yield* new BackupError({
      message: "Use absolute paths for --binary and BACKUP_RUSTIC when generating a LaunchAgent.",
    });
  }
  if (config.configPath === undefined || config.backupProfile === undefined) {
    return yield* new BackupError({
      message: "Scheduling requires a config.toml path and backup profile.",
    });
  }
  const args = [
    binary,
    "--config",
    config.configPath,
    "backups",
    "--profile",
    config.backupProfile,
    "run-due",
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.jfa.rustic-backup</string>
  <key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${xml(config.repoRoot)}</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>${xml(config.home)}</string>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>BACKUP_RUSTIC</key><string>${xml(config.rustic)}</string>
    ${Object.entries(config.substitutions)
      .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
      .join("\n    ")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>15</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(join(config.home, "Library/Logs/rustic-wrapper.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(config.home, "Library/Logs/rustic-wrapper.error.log"))}</string>
</dict></plist>`;
});
