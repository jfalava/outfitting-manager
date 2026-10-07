import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { expect, test } from "vitest";

import { Processes, successful } from "@/backups/process";

test("process capture drains stdout and stderr concurrently and never interprets shell syntax", async () => {
  const literal = "name with spaces; $(echo injected) 'quoted'";
  const output = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Processes).run(process.execPath, [
        "-e",
        "process.stdout.write('a'.repeat(180000)); process.stderr.write('b'.repeat(210000)); process.stdout.write(process.argv[1]); process.exitCode=7",
        literal,
      ]);
    }).pipe(Effect.provide(Processes.layer.pipe(Layer.provide(BunServices.layer)))),
  );
  expect(output.exitCode).toBe(7);
  expect(output.stdout).toBe("a".repeat(180_000) + literal);
  expect(output.stderr).toBe("b".repeat(210_000));
  const error = await Effect.runPromise(successful(output, "fixture")).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(String(error)).toContain("fixture exited 7");
});

test("oversized output fails instead of silently accepting a truncated JSON capture", async () => {
  const error = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Processes).run(process.execPath, [
        "-e",
        "process.stdout.write('x'.repeat(9*1024*1024))",
      ]);
    }).pipe(Effect.provide(Processes.layer.pipe(Layer.provide(BunServices.layer)))),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toContain("capture command output completely");
});
