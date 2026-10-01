export type TerminalAlert = "password-required" | "error";

export interface TerminalAlertStream {
  readonly isTTY?: boolean;
  write(chunk: string): unknown;
}

const ALERT_BELL = "\u0007";

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
