import { Context, Effect, Layer, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { BackupError } from "./model.ts";

export interface ProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class Processes extends Context.Service<
  Processes,
  {
    run(
      executable: string,
      args: ReadonlyArray<string>,
      env?: Record<string, string | undefined>,
    ): Effect.Effect<ProcessOutput, BackupError>;
  }
>()("backup/Processes") {
  static readonly layer = Layer.effect(
    Processes,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const collect = Effect.fn("Processes.collect")(function* (
        stream: Stream.Stream<Uint8Array, unknown>,
      ) {
        return yield* stream.pipe(
          Stream.decodeText(),
          Stream.runFoldEffect(
            () => "",
            (text, chunk) =>
              text.length + chunk.length > 8 * 1024 * 1024
                ? Effect.fail(
                    new BackupError({
                      message:
                        "Command output exceeded 8 MiB; refusing to accept an incomplete capture.",
                    }),
                  )
                : Effect.succeed(text + chunk),
          ),
          Effect.mapError(
            () => new BackupError({ message: "Could not capture command output completely." }),
          ),
        );
      });
      const run = Effect.fn("Processes.run")(function* (
        executable: string,
        args: ReadonlyArray<string>,
        env?: Record<string, string | undefined>,
      ) {
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(executable, args, {
              env: env ?? process.env,
              extendEnv: false,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              shell: false,
              forceKillAfter: "5 seconds",
            }),
          )
          .pipe(
            Effect.mapError(() => new BackupError({ message: `Could not start ${executable}.` })),
          );
        return yield* Effect.all(
          {
            stdout: collect(handle.stdout),
            stderr: collect(handle.stderr),
            exitCode: handle.exitCode.pipe(
              Effect.mapError(() => new BackupError({ message: `${executable} was terminated.` })),
            ),
          },
          { concurrency: "unbounded" },
        );
      }, Effect.scoped);
      return Processes.of({ run });
    }),
  );
}

export const successful = Effect.fn("successful")(function* (
  output: ProcessOutput,
  operation: string,
) {
  if (output.exitCode !== 0) {
    return yield* new BackupError({
      message: `${operation} exited ${output.exitCode}: ${output.stderr.slice(-4_000)}`,
    });
  }
  return output;
});

export const parseJson = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
