import { Effect } from "effect";

import { toCliFailure, type CliFailure } from "@/errors";
import { TerminalSession, terminalSessionContext } from "@/terminal-alert";

export const toError = (cause: unknown): CliFailure => toCliFailure(cause);

export const tryPromise = Effect.fnUntraced(function* <A>(try_: () => Promise<A>) {
  const session = yield* TerminalSession;
  return yield* Effect.tryPromise({
    try: () => terminalSessionContext.run(session, try_),
    catch: toError,
  });
});
