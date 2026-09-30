import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { loadConfig, type ManagerConfig } from "@/config";
import { CliFailure } from "@/errors";
import { pushLockfile } from "@/lockfiles";
import { tryPromise } from "@/lockfiles/effect";
import { runCommand, which } from "@/process";
import { ui } from "@/ui";
import { runScoopCommand } from "@/update/scoop-command";
import {
  isWingetAlreadyInstalledExitCode,
  recordWindowsOperation,
  WINDOWS_LOCK_KIND,
  windowsLockPath,
  type WindowsPackageAction,
  type WindowsPackageManager,
} from "@/update/windows-lock";
import { wingetPackageArgs } from "@/update/winget";

const packageArguments = Argument.String("package").pipe(
  Argument.variadic({ min: 1 }),
  Argument.withDescription("Package IDs or Scoop package names."),
);

const noPushFlag = Flag.Boolean("no-push").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Update local tracking without uploading windows.lock.json."),
);

const strictFlag = Flag.Boolean("strict").pipe(
  Flag.withDefault(false),
  Flag.withDescription("Stop at the first package installation failure."),
);

function commandArgs(
  manager: WindowsPackageManager,
  action: WindowsPackageAction,
  name: string,
): string[] {
  if (manager === "winget") {
    return wingetPackageArgs(action, name);
  }
  return [action, name];
}

function runPackage(options: {
  manager: WindowsPackageManager;
  action: WindowsPackageAction;
  name: string;
  config: ManagerConfig;
  strict: boolean;
  run: typeof runCommand;
  whichFn: typeof which;
}) {
  return Effect.gen(function* () {
    const { manager, action, name, config, strict, run, whichFn } = options;
    const executable = yield* tryPromise(() => whichFn(manager === "scoop" ? "scoop" : manager));
    if (executable === undefined) {
      return yield* new CliFailure({
        message: `${manager} is not installed or not in PATH.`,
      });
    }

    const args = commandArgs(manager, action, name);
    const result = yield* tryPromise(() =>
      manager === "scoop"
        ? runScoopCommand(run, executable, args, { inherit: true })
        : run(executable, args, { inherit: true }),
    );
    const alreadyInstalled =
      manager === "winget" && action === "install" && isWingetAlreadyInstalledExitCode(result.code);
    const status = result.code === 0 || alreadyInstalled ? "success" : "failed";
    yield* tryPromise(() =>
      recordWindowsOperation({
        config,
        manager,
        action,
        name,
        args,
        status,
        exitCode: result.code,
      }),
    );

    if (status === "failed") {
      const message = `${manager} ${action} ${name} failed (exit ${result.code})`;
      if (action === "install" && !strict) {
        yield* Console.log(ui.muted(`Warning: ${message}; continuing.`));
        return false;
      }
      return yield* new CliFailure({
        message: `${message}.`,
      });
    }
    if (alreadyInstalled) {
      yield* Console.log(ui.muted(`WinGet package already installed and up to date: ${name}`));
    }
    return true;
  });
}

export interface WindowsPackageBatchOptions {
  manager: WindowsPackageManager;
  action: WindowsPackageAction;
  packages: ReadonlyArray<string>;
  config: ManagerConfig;
  strict?: boolean;
  noPush?: boolean;
  run?: typeof runCommand;
  which?: typeof which;
}

export const runWindowsPackageBatch = (options: WindowsPackageBatchOptions) =>
  Effect.gen(function* () {
    const run = options.run ?? runCommand;
    const whichFn = options.which ?? which;
    const failures: string[] = [];
    for (const name of options.packages) {
      const succeeded = yield* runPackage({
        manager: options.manager,
        action: options.action,
        name,
        config: options.config,
        strict: options.strict === true,
        run,
        whichFn,
      });
      if (!succeeded) {
        failures.push(name);
      }
    }

    if (options.noPush) {
      yield* Console.log(ui.muted("Updated local tracking; skipped upload (--no-push)."));
    } else {
      yield* pushLockfile({
        machine: options.config.machineId,
        kind: WINDOWS_LOCK_KIND,
        path: windowsLockPath({ root: options.config.stateRoot }),
      });
    }

    if (failures.length > 0) {
      yield* Console.log(
        ui.muted(
          `${options.manager} install was partial; failed packages: ${failures.join(", ")}.`,
        ),
      );
      return yield* new CliFailure({
        message: `${options.manager} ${options.action} was partial; failed packages: ${failures.join(", ")}.`,
      });
    }
  });

function makePackageCommand(manager: WindowsPackageManager, action: WindowsPackageAction) {
  const description = `${action === "install" ? "Install" : "Remove"} tracked ${manager} packages and record the operation.`;
  const runBatch = (packages: ReadonlyArray<string>, noPush: boolean, strict: boolean) =>
    Effect.gen(function* () {
      const config = yield* tryPromise(() => loadConfig());
      yield* runWindowsPackageBatch({
        manager,
        action,
        packages,
        config,
        noPush,
        strict,
      }).pipe(Effect.orDie);
    });
  if (action === "install") {
    return Command.make(
      action,
      { packages: packageArguments, noPush: noPushFlag, strict: strictFlag },
      ({ packages, noPush, strict }) => runBatch(packages, noPush, strict),
    ).pipe(Command.withDescription(description));
  }
  return Command.make(
    action,
    { packages: packageArguments, noPush: noPushFlag },
    ({ packages, noPush }) => runBatch(packages, noPush, false),
  ).pipe(Command.withDescription(description));
}

export const windowsPackageCommands = [
  Command.make("winget").pipe(
    Command.withDescription(
      "Install or remove a package through WinGet and track it in windows.lock.json.",
    ),
    Command.withSubcommands([
      makePackageCommand("winget", "install"),
      makePackageCommand("winget", "uninstall"),
    ]),
  ),
  Command.make("scoop").pipe(
    Command.withDescription(
      "Install or remove a package through Scoop and track it in windows.lock.json.",
    ),
    Command.withSubcommands([
      makePackageCommand("scoop", "install"),
      makePackageCommand("scoop", "uninstall"),
    ]),
  ),
] as const;

export function windowsPackageCommandArgs(
  manager: WindowsPackageManager,
  action: WindowsPackageAction,
  name: string,
): string[] {
  return commandArgs(manager, action, name);
}
