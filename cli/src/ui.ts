import pc from "picocolors";

const INFO_ICON = "󰋼";
const NOTE_ICON = "󰎞";
const WARNING_ICON = "󰀪";
const ERROR_ICON = "󰅚";

function statusLine(icon: string, color: (value: string) => string, message: string): string {
  const lines = message.replace(/\r\n?/g, "\n").replace(/\n+$/g, "").split("\n");
  return lines
    .map((line, index) => (index === 0 ? `  ${color(icon)} ${line}` : `    ${line}`))
    .join("\n");
}

export const ui = {
  success: (message: string): string => `${pc.green("✓")} ${message}`,
  key: (value: string): string => pc.cyan(value),
  hash: (value: string): string => pc.yellow(value),
  muted: (value: string): string => pc.dim(value),
  heading: (value: string): string => pc.bold(value),
  info: (message: string): string => statusLine(INFO_ICON, pc.cyan, message),
  note: (message: string): string => statusLine(NOTE_ICON, pc.blue, message),
  warning: (message: string): string => statusLine(WARNING_ICON, pc.yellow, message),
  error: (message: string): string => statusLine(ERROR_ICON, pc.red, message),
};
