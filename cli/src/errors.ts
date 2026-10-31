import { Data } from "effect";

export class CliFailure extends Data.TaggedError("CliFailure")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function isNotFound(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

export const toCliFailure = (cause: unknown, message?: string): CliFailure =>
  cause instanceof CliFailure
    ? cause
    : new CliFailure({
        message: message ?? errorMessage(cause),
        cause,
      });
