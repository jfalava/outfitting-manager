import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Schema, Terminal } from "effect";
import { CliError, Command } from "effect/cli";

import { normalizeCommandAlias } from "@/arguments";
import { makeCommandHelpLayer } from "@/cli/help";
import { CliFailure } from "@/errors";
import {
  createTerminalSession,
  TerminalSession,
  type TerminalSessionControls,
  type TerminalSessionOptions,
} from "@/terminal-alert";
import { ui } from "@/ui";

/** This CLI uses branches as namespaces and leaves as executable commands. */
function withTerminalCommands<Name extends string, Input, ContextInput, E, R>(
  command: Command.Command<Name, Input, ContextInput, E, R>,
  session: TerminalSessionControls,
  parentPath: ReadonlyArray<string> = [],
): Command.Command<Name, Input, ContextInput, E, R> {
  const path = [...parentPath, command.name];
  if (command.subcommands.length === 0) {
    return command.pipe(Command.provideEffectDiscard(Effect.sync(() => session.begin(path))));
  }
  const children = command.subcommands.flatMap<Command.Command.SubcommandEntry>((group) => {
    const commands = group.commands.map((child) => withTerminalCommands(child, session, path));
    return group.group === undefined ? commands : [{ group: group.group, commands }];
  });
  // Reattaching the same tree preserves its input, error and service contracts.
  return command.pipe(Command.withSubcommands(children)) as Command.Command<
    Name,
    Input,
    ContextInput,
    E,
    R
  >;
}

/** Publish the outcome after command resources have finished cleanup. */
export const runCli = Effect.fnUntraced(function* <Name extends string, Input, ContextInput, E, R>(
  root: Command.Command<Name, Input, ContextInput, E, R>,
  version: string,
  args: ReadonlyArray<string>,
  terminalOptions?: TerminalSessionOptions,
) {
  // Let runMain install signal handlers before terminal side effects.
  yield* Effect.yieldNow;

  const session = createTerminalSession(terminalOptions);
  let failed = false;
  let quit = false;
  const command = withTerminalCommands(root, session);
  yield* Effect.sync(() => normalizeCommandAlias(args)).pipe(
    Effect.flatMap((normalized) =>
      Command.runWith(command, { version })(normalized.length === 0 ? ["--help"] : normalized),
    ),
    Effect.provide([makeCommandHelpLayer(command), BunServices.layer]),
    Effect.provideService(TerminalSession, session),
    Effect.scoped,
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }
      return Effect.sync(() => {
        const errors = cause.reasons
          .flatMap((reason) =>
            Cause.isFailReason(reason)
              ? [reason.error]
              : Cause.isDieReason(reason)
                ? [reason.defect]
                : [],
          )
          .filter(
            (error) =>
              !Schema.is(Terminal.QuitError)(error instanceof CliFailure ? error.cause : error),
          );
        if (errors.length === 0) {
          quit = true;
          session.cancel();
          process.exitCode = 130;
          return;
        }
        failed = true;
        process.exitCode = 1;
        session.alert("error");
        for (const error of errors) {
          if (!CliError.isCliError(error)) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(ui.error(message));
          }
        }
      });
    }),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
        session.close(
          interrupted || quit
            ? "idle"
            : Exit.isFailure(exit) || failed || Number(process.exitCode ?? 0) !== 0
              ? "error"
              : "done",
        );
      }),
    ),
  );
});
