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

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const scheduledTask = Effect.fn("scheduledTask")(function* (binary: string) {
  const config = yield* Settings;
  if (!isAbsolute(binary) || !isAbsolute(config.rustic)) {
    return yield* new BackupError({
      message:
        "Use absolute paths for --binary and BACKUP_RUSTIC when generating a scheduled task.",
    });
  }
  const user = `${config.environment.USERDOMAIN ?? config.hostname}\\${config.account}`;
  if (config.configPath === undefined || config.backupProfile === undefined) {
    return yield* new BackupError({
      message: "Scheduling requires a config.toml path and backup profile.",
    });
  }
  const script = `$ErrorActionPreference = 'Stop'; $env:BACKUP_RUSTIC = ${quote(config.rustic)}; & ${quote(binary)} --config ${quote(config.configPath)} backups --profile ${quote(config.backupProfile)} run-due; exit $LASTEXITCODE`;
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Rustic daily backups and weekly checks with receipt-based catch-up. No automatic retention.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><Repetition><Interval>PT1H</Interval><Duration>P1D</Duration><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><StartBoundary>2026-01-01T09:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
    <CalendarTrigger><StartBoundary>2026-01-04T15:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><Sunday/></DaysOfWeek></ScheduleByWeek></CalendarTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger>
  </Triggers>
  <Principals><Principal id="BackupUser"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
  <Actions Context="BackupUser"><Exec><Command>${xml(join(config.environment.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"))}</Command><Arguments>${xml(args.map((arg) => `"${arg}"`).join(" "))}</Arguments><WorkingDirectory>${xml(config.repoRoot)}</WorkingDirectory></Exec></Actions>
</Task>`;
});
