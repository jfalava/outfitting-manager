import { spawn } from "node:child_process";

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Inherit stdio (default true). */
  inherit?: boolean;
  /** With inherit false, receive stderr line by line instead of capturing it. */
  onStderrLine?: (line: string) => void;
}

export interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ChildProcessEvents {
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
}

/**
 * Run a subprocess. When inherit is true, streams live to the terminal and
 * still captures nothing; callers that need output should set inherit false.
 */
export function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const inherit = options.inherit !== false;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    }) as ReturnType<typeof spawn> & ChildProcessEvents;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const onStderrLine = options.onStderrLine;
    if (!inherit) {
      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      if (onStderrLine === undefined) {
        child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      } else {
        let pending = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
          const lines = (pending + chunk).split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            onStderrLine(line.replace(/\r$/, ""));
          }
        });
        // "close" follows the end of every stdio stream, so the last line arrives first.
        child.stderr?.on("end", () => {
          if (pending.length > 0) {
            onStderrLine(pending);
          }
        });
      }
    }

    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

export async function which(command: string): Promise<string | undefined> {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const result = await runCommand(probe, [command], { inherit: false });
    if (result.code !== 0) {
      return undefined;
    }
    const line = result.stdout.trim().split(/\r?\n/)[0]?.trim();
    return line || undefined;
  } catch {
    return undefined;
  }
}
