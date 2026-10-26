import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import { createInterface } from "node:readline";

import { Cause, Context, Effect, Exit, Schema, Terminal } from "effect";

export type TerminalAlert = "password-required" | "error";

export interface TerminalAlertStream {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

const ALERT_BELL = "\u0007";
const ST = "\u001b\\";
const APP = "outfitting-manager";

export interface TerminalSessionControls {
  begin(path: ReadonlyArray<string>): void;
  phase(label: string): void;
  progress(done: number, total: number): void;
  blocked(kind: "permission" | "question" | "auth", label: string): void;
  cancel(): void;
  summary(message: string, hasErrors?: boolean): void;
  alert(alert: TerminalAlert): void;
  resume(): void;
  close(outcome?: "done" | "idle" | "error"): void;
}

export interface TerminalSessionOptions {
  stream?: TerminalAlertStream;
  env?: NodeJS.ProcessEnv;
}

/** Bridge the Effect service into legacy Promise-based credential helpers. */
export const terminalSessionContext = new AsyncLocalStorage<TerminalSessionControls>();

export async function terminalPrompt(message: string): Promise<string> {
  const session = terminalSessionContext.getStore();
  session?.blocked("question", message);
  const input = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve, reject) => {
      input.once("SIGINT", () => reject(new Terminal.QuitError()));
      input.once("close", () => reject(new Terminal.QuitError()));
      input.question(`${message} `, resolve);
    });
  } finally {
    input.close();
    session?.resume();
  }
}

function terminalText(text: string, limit = 192): string {
  const cleaned = text
    // oxlint-disable-next-line no-control-regex -- OSC text must not contain C0/C1 controls or bidi overrides.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let result = "";
  let bytes = 0;
  for (const character of cleaned) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) {
      break;
    }
    result += character;
  }
  return result;
}

/** Flush bounded reports before runMain exits; embedders may supply their own stream. */
function writeReport(title: string, sequence: string, stream?: TerminalAlertStream): void {
  const windowTitle = `\u001b]2;${title}${ST}`;
  if (stream !== undefined) {
    stream.write(windowTitle);
    stream.write(sequence);
    return;
  }
  const bytes = Buffer.from(windowTitle + sequence);
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(2, bytes, offset, bytes.length - offset);
  }
}

/** One foreground invocation owns the root record. No capability queries touch stdin. */
export function createTerminalSession(
  options: TerminalSessionOptions = {},
): TerminalSessionControls {
  const stream = options.stream ?? process.stderr;
  const env = options.env ?? process.env;
  let enabled =
    stream.isTTY === true && env.TERM !== "dumb" && env.OUTFITTING_PROGRAM_STATUS !== "0";
  let command = "";
  let activePhase = "Working";
  let percentage: number | undefined;
  let state: "working" | "blocked" | "error" = "working";
  let kind: "permission" | "question" | "auth" | undefined;
  let blockedLabel = "";
  let summary: string | undefined;
  let hasErrors = false;
  let cancelled = false;
  let previous: string | undefined;
  let closed = false;

  const report = (
    next: "working" | "blocked" | "error" | "idle" | "done",
    label: string,
    message?: string,
  ) => {
    if (!enabled || !command) {
      return;
    }
    const progress = next === "working" || next === "blocked" ? percentage : undefined;
    const suffix = progress === undefined ? "" : ` ${progress}%`;
    const title = `${terminalText(`Outfitting: ${label}`, 192 - Buffer.byteLength(suffix))}${suffix}`;
    const pairs = [
      `state=${next}`,
      `app=${APP}`,
      `title=${Buffer.from(title).toString("base64")}`,
      `msg=${Buffer.from(terminalText(message ?? `${command}: ${label}`, 2048)).toString("base64")}`,
    ];
    if (next === "blocked") {
      pairs.push(`kind=${kind}`);
    }
    if (progress !== undefined) {
      pairs.push(`progress=${progress}`);
    }
    const sequence = `\u001b]7501;${pairs.join(":")}${ST}`;
    if (sequence === previous) {
      return;
    }
    try {
      writeReport(title, sequence, options.stream);
      previous = sequence;
    } catch {
      // Terminal output must not fail an operation or its cleanup.
      enabled = false;
    }
  };
  const phase = (label: string) => {
    if (closed || !command || state === "error") {
      return;
    }
    activePhase = terminalText(label);
    percentage = undefined;
    state = "working";
    report("working", activePhase);
  };

  return {
    begin: (path) => {
      if (closed || command || stream.isTTY !== true) {
        return;
      }
      command = terminalText(path.slice(1).join(" "));
      phase("Working");
    },
    phase,
    progress: (done, total) => {
      if (closed || !command || state === "error") {
        return;
      }
      percentage =
        total > 0 && Number.isFinite(total) && Number.isFinite(done)
          ? Math.floor((Math.max(0, Math.min(done, total)) * 100) / total)
          : undefined;
      report(state, state === "blocked" ? blockedLabel : activePhase);
    },
    blocked: (nextKind, label) => {
      if (closed || !command || state === "error") {
        return;
      }
      state = "blocked";
      kind = nextKind;
      blockedLabel = terminalText(label);
      report("blocked", blockedLabel);
    },
    cancel: () => {
      if (!closed) {
        cancelled = true;
      }
    },
    summary: (message, errors = false) => {
      if (closed) {
        return;
      }
      summary = terminalText(message, 2048);
      hasErrors ||= errors;
    },
    alert: (alert) => {
      if (closed || !command || stream.isTTY !== true) {
        return;
      }
      state = alert === "error" ? "error" : "blocked";
      const label = alert === "error" ? "Failed" : "Password required";
      kind = "auth";
      blockedLabel = label;
      report(state, label);
      if (!enabled) {
        try {
          emitTerminalAlert(alert, stream);
        } catch {
          // A closed terminal must not replace the original command result.
        }
      }
    },
    resume: () => {
      if (!closed && state === "blocked") {
        state = "working";
        report("working", activePhase);
      }
    },
    close: (outcome = "done") => {
      if (closed) {
        return;
      }
      closed = true;
      const next =
        outcome === "error" || state === "error" || hasErrors
          ? "error"
          : outcome === "idle" || cancelled
            ? "idle"
            : "done";
      const label = next === "error" ? "Failed" : next === "idle" ? "Cancelled" : "Done";
      if (next === "idle") {
        summary = undefined;
      }
      report(next, label, summary);
    },
  };
}

/** Library callers retain existing alerts; the CLI provides an invocation-specific session. */
export const TerminalSession = Context.Reference<TerminalSessionControls>(
  "@outfitting/cli/TerminalSession",
  {
    defaultValue: () => ({
      begin: () => undefined,
      phase: () => undefined,
      progress: () => undefined,
      blocked: () => undefined,
      cancel: () => undefined,
      summary: () => undefined,
      alert: emitTerminalAlert,
      resume: () => undefined,
      close: () => undefined,
    }),
  },
);

export const setTerminalPhase = (label: string) =>
  Effect.flatMap(TerminalSession, (session) => Effect.sync(() => session.phase(label)));

/** Preserve progress across a prompt, and remember cancellation even if callers catch QuitError. */
export const withTerminalInput = Effect.fnUntraced(function* <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  kind: "permission" | "question" | "auth" = "question",
  label = "Waiting for input",
) {
  const session = yield* TerminalSession;
  yield* Effect.sync(() => session.blocked(kind, label));
  return yield* effect.pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        if (Schema.is(Terminal.QuitError)(error)) {
          session.cancel();
        }
      }),
    ),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
          session.cancel();
        }
        session.resume();
      }),
    ),
  );
});

/**
 * Use the terminal's configured bell sound without polluting redirected output.
 * A password alert is one bell; an error alert is two bells.
 */
export function emitTerminalAlert(
  alert: TerminalAlert,
  stream: TerminalAlertStream = process.stderr,
): void {
  if (stream.isTTY !== true) {
    return;
  }

  stream.write(ALERT_BELL.repeat(alert === "error" ? 2 : 1));
}
