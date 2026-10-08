import { BunServices } from "@effect/platform-bun";
import { Effect, Exit } from "effect";
import { CliError, Command } from "effect/cli";

import { normalizeCommandAlias } from "@/arguments";
import { makeCommandHelpLayer } from "@/cli/help";
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

/** Keep error reporting inside the title scope, so restoration always happens last. */
export const runCli = Effect.fnUntraced(function* <Name extends string, Input, ContextInput, E, R>(
  root: Command.Command<Name, Input, ContextInput, E, R>,
  version: string,
  args: ReadonlyArray<string>,
  terminalOptions?: TerminalSessionOptions,
) {
  // Let runMain install signal handlers before terminal side effects.
  yield* Effect.yieldNow;

  const session = yield* Effect.acquireRelease(
    Effect.sync(() => createTerminalSession(terminalOptions)),
    (resource, exit) => Effect.sync(() => resource.close(Exit.hasInterrupts(exit))),
  );
  const command = withTerminalCommands(root, session);
  yield* Effect.sync(() => normalizeCommandAlias(args)).pipe(
    Effect.flatMap((normalized) =>
      Command.runWith(command, { version })(normalized.length === 0 ? ["--help"] : normalized),
    ),
    Effect.provide([makeCommandHelpLayer(command), BunServices.layer]),
    Effect.catch((error) =>
      Effect.sync(() => {
        process.exitCode = 1;
        if (!CliError.isCliError(error)) {
          session.alert("error");
          const message = error instanceof Error ? error.message : String(error);
          console.error(ui.error(message));
        }
      }),
    ),
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        process.exitCode = 1;
        session.alert("error");
        const message = defect instanceof Error ? defect.message : String(defect);
        console.error(ui.error(message));
      }),
    ),
    Effect.provideService(TerminalSession, session),
  );
}, Effect.scoped);
