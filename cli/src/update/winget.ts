import { Console, Effect } from "effect";

import { loadConfig, type ManagerConfig } from "@/config";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { runCommand, which } from "@/process";
import { ui } from "@/ui";
import {
  publishWindowsLock,
  recordWindowsOperation,
  type WindowsPackageAction,
} from "@/update/windows-lock";

const UPGRADE_ALL_ARGS = [
  "upgrade",
  "--all",
  "--accept-source-agreements",
  "--accept-package-agreements",
];

export function wingetPackageArgs(
  action: WindowsPackageAction,
  name: string,
  source?: "winget" | "msstore",
): string[] {
  return [
    action,
    "--id",
    name,
    "--exact",
    ...(source === undefined ? [] : ["--source", source]),
    "--accept-source-agreements",
    ...(action === "uninstall" ? [] : ["--accept-package-agreements"]),
  ];
}

export interface UpdateWingetOptions {
  config?: ManagerConfig;
  noPush?: boolean;
  run?: typeof runCommand;
  which?: typeof which;
}

/** Upgrade every installed WinGet package and optionally record the operation. */
export const updateWinget = (options: UpdateWingetOptions = {}) =>
  Effect.gen(function* () {
    const run = options.run ?? runCommand;
    const whichFn = options.which ?? which;
    const wingetPath = yield* tryPromise(() => whichFn("winget"));
    if (wingetPath === undefined) {
      return yield* new CliFailure({ message: "WinGet is not installed or not in PATH." });
    }

    const config = options.config ?? (yield* tryPromise(() => loadConfig()));
    yield* Console.log(ui.heading("Updating WinGet packages…"));
    const result = yield* tryPromise(() => run("winget", UPGRADE_ALL_ARGS, { inherit: true }));
    if (result.code !== 0) {
      return yield* new CliFailure({
        message:
          `winget ${UPGRADE_ALL_ARGS.join(" ")} failed (exit ${result.code}): ${result.stderr || result.stdout}`.trim(),
      });
    }

    yield* tryPromise(() =>
      recordWindowsOperation({
        config,
        manager: "winget",
        action: "upgrade",
        name: "*",
        args: UPGRADE_ALL_ARGS,
        status: "success",
        exitCode: 0,
      }),
    );
    yield* publishWindowsLock(config, options.noPush);
    yield* Console.log(ui.success("WinGet update complete."));
  });
