import { Console, Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { loadConfig, type ManagerConfig } from "@/config";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { runCommand, which } from "@/process";
import { ui } from "@/ui";
import { runScoopCommand } from "@/update/scoop-command";
import {
  isWingetAlreadyInstalledExitCode,
  publishWindowsLock,
  recordWindowsOperation,
  type WindowsPackageAction,
  type WindowsPackageManager,
} from "@/update/windows-lock";
import { reportPackageFailure } from "@/update/windows-report";
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

export function windowsPackageCommandArgs(
  manager: WindowsPackageManager,
  action: WindowsPackageAction,
  name: string,
): string[] {
  if (manager === "winget") {
    return wingetPackageArgs(action, name);
  }
  return [action, name];
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

const runPackage = Effect.fn("runWindowsPackage")(function* (
  options: WindowsPackageBatchOptions,
  executable: string,
  name: string,
  failures: string[],
) {
  const { manager, action } = options;
  const run = options.run ?? runCommand;
  const args = windowsPackageCommandArgs(manager, action, name);
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
      config: options.config,
      manager,
      action,
      name,
      args,
      status,
      exitCode: result.code,
    }),
  );

  if (status === "failed") {
    // --strict exists only on install; a failed uninstall always stops the batch.
    yield* reportPackageFailure(
      `${manager} ${action} ${name} failed (exit ${result.code})`,
      action !== "install" || options.strict === true,
      failures,
      Console.log,
    );
  } else if (alreadyInstalled) {
    yield* Console.log(ui.muted(`WinGet package already installed and up to date: ${name}`));
  }
});

export const runWindowsPackageBatch = (options: WindowsPackageBatchOptions) =>
  Effect.gen(function* () {
    const executable = yield* tryPromise(() => (options.which ?? which)(options.manager));
    if (executable === undefined) {
      return yield* new CliFailure({
        message: `${options.manager} is not installed or not in PATH.`,
      });
    }
    const failures: string[] = [];
    for (const name of options.packages) {
      yield* runPackage(options, executable, name, failures);
    }

    yield* publishWindowsLock(options.config, options.noPush);

    if (failures.length > 0) {
      return yield* new CliFailure({
        message: `${options.manager} ${options.action} was partial: ${failures.join("; ")}.`,
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
