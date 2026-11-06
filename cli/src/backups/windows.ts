import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join, win32 } from "node:path";

import { Effect } from "effect";

import { BackupError } from "./model.ts";
import { Settings, type SettingsData } from "./settings.ts";

const xml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function findPwsh(path: string): Promise<string | undefined> {
  const name = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  for (const directory of path.split(delimiter).filter((entry) => isAbsolute(entry))) {
    const candidate = join(directory, name);
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

export const scheduledTask = Effect.fn("scheduledTask")(function* (
  binary: string,
  launcher: string | undefined,
) {
  const config = yield* Settings;
  if (
    !isAbsolute(binary) ||
    !isAbsolute(config.rustic) ||
    launcher === undefined ||
    !isAbsolute(launcher)
  ) {
    return yield* new BackupError({
      message:
        "Use absolute paths for --binary, --launcher, and BACKUP_RUSTIC when generating a scheduled task.",
    });
  }
  if (config.configPath === undefined || config.backupProfile === undefined) {
    return yield* new BackupError({
      message: "Scheduling requires a config.toml path and backup profile.",
    });
  }
  // Resolve now: a task pointing at a missing pwsh would silently stop running backups.
  // Windows spells the key `Path`; the copied environment is a plain, case-sensitive object.
  const path = Object.entries(config.environment).find(([key]) => key.toUpperCase() === "PATH");
  const pwsh = yield* Effect.promise(() => findPwsh(path?.[1] ?? ""));
  if (pwsh === undefined) {
    return yield* new BackupError({
      message: "PowerShell 7 (pwsh) must be on PATH to generate a scheduled task.",
    });
  }
  return formatScheduledTask(binary, pwsh, launcher, {
    ...config,
    configPath: config.configPath,
    backupProfile: config.backupProfile,
  });
});

export function formatScheduledTask(
  binary: string,
  pwsh: string,
  launcher: string,
  config: SettingsData & { configPath: string; backupProfile: string },
): string {
  const user = `${config.environment.USERDOMAIN ?? config.hostname}\\${config.account}`;
  const script = `$ErrorActionPreference = 'Stop'; $env:BACKUP_RUSTIC = ${quote(config.rustic)}; & ${quote(binary)} --config ${quote(config.configPath)} backups --profile ${quote(config.backupProfile)} run-due; exit $LASTEXITCODE`;
  // pwsh is a console program: started directly, it opens a focused Windows Terminal window on
  // every run. The windowless wscript launcher starts it hidden and returns its exit code;
  // `conhost --headless` also hides it but always exits 0.
  const systemRoot =
    Object.entries(config.environment).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1] ??
    "C:\\Windows";
  const args = [
    launcher,
    pwsh,
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
  <Actions Context="BackupUser"><Exec><Command>${xml(win32.join(systemRoot, "System32", "wscript.exe"))}</Command><Arguments>//B //Nologo ${xml(args.map((arg) => `"${arg}"`).join(" "))}</Arguments><WorkingDirectory>${xml(config.repoRoot)}</WorkingDirectory></Exec></Actions>
</Task>`;
}
