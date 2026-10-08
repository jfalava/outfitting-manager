import { spawnSync } from "node:child_process";

import { Context, Effect } from "effect";

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
  alert(alert: TerminalAlert): void;
  resume(): void;
  close(interrupted?: boolean): void;
}

export interface TerminalSessionOptions {
  stream?: TerminalAlertStream;
  env?: NodeJS.ProcessEnv;
  supportsStatus?: (env: NodeJS.ProcessEnv) => boolean;
}

/** Read the capability advertisement without sending terminal queries or reading stdin. */
export function supportsProgramStatus(env: NodeJS.ProcessEnv): boolean {
  if (!env.TERM || env.TERM === "dumb") {
    return false;
  }
  const result = spawnSync("infocmp", ["-x", "-1", env.TERM], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 500,
    maxBuffer: 128 * 1024,
  });
  return result.status === 0 && /^\s*Pst=[^,\r\n]+,?$/m.test(result.stdout);
}

function terminalText(text: string): string {
  const cleaned = text
    // oxlint-disable-next-line no-control-regex -- OSC text must not contain C0/C1 controls or bidi overrides.
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let result = "";
  let bytes = 0;
  for (const character of cleaned) {
    bytes += Buffer.byteLength(character);
    if (bytes > 192) {
      break;
    }
    result += character;
  }
  return result;
}

/** One invocation owns one title stack entry and one application-scoped status record. */
export function createTerminalSession(
  options: TerminalSessionOptions = {},
): TerminalSessionControls {
  const stream = options.stream ?? process.stderr;
  const env = options.env ?? process.env;
  const supportsStatus = options.supportsStatus ?? supportsProgramStatus;
  const titles = stream.isTTY === true && env.OUTFITTING_TITLE_PROTOCOL === "xterm-window-stack";
  let status: boolean | undefined;
  let command = "";
  let activePhase = "Working";
  let state: "working" | "blocked" | "error" | undefined;
  let savedTitle = false;
  let closed = false;

  const report = (next: "working" | "blocked" | "error" | "clear" | "idle", label?: string) => {
    status ??= stream.isTTY === true && supportsStatus(env);
    if (!status) {
      return;
    }
    const kind = next === "blocked" ? ":kind=auth" : "";
    const msg =
      label === undefined ? "" : `:msg=${Buffer.from(terminalText(label)).toString("base64")}`;
    stream.write(`\u001b]7501;state=${next}:id=${APP}:app=${APP}${kind}${msg}${ST}`);
  };
  const title = (label: string) => {
    if (!titles || !command) {
      return;
    }
    if (!savedTitle) {
      savedTitle = true;
      stream.write("\u001b[22;2t");
    }
    stream.write(`\u001b]2;${terminalText(`Outfitting · ${command} · ${label}`)}${ST}`);
  };
  const phase = (label: string) => {
    if (closed || !command || state === "error") {
      return;
    }
    activePhase = terminalText(label);
    state = "working";
    title(activePhase);
    report("working", `${command}: ${activePhase}`);
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
    alert: (alert) => {
      if (closed || stream.isTTY !== true) {
        return;
      }
      state = alert === "error" ? "error" : "blocked";
      const label = alert === "error" ? "Failed" : "Password required";
      title(label);
      report(state, command ? `${command}: ${label}` : label);
      if (!status) {
        emitTerminalAlert(alert, stream);
      }
    },
    resume: () => {
      if (state === "blocked") {
        phase(activePhase);
      }
    },
    close: (interrupted = false) => {
      if (closed) {
        return;
      }
      closed = true;
      if (status && state !== "error") {
        report(interrupted ? "idle" : "clear");
      }
      if (savedTitle) {
        stream.write("\u001b[23;2t");
      }
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
      alert: emitTerminalAlert,
      resume: () => undefined,
      close: () => undefined,
    }),
  },
);

export const setTerminalPhase = (label: string) =>
  Effect.flatMap(TerminalSession, (session) => Effect.sync(() => session.phase(label)));

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
