import { Writable } from "node:stream";

import { Effect } from "effect";
import { afterEach, expect, test, vi } from "vitest";

import { withActivity, withProgress } from "@/ui/progress";

function captureStream(isTTY: boolean) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  Object.defineProperty(stream, "isTTY", { value: isTTY });
  return {
    stream: stream as unknown as NodeJS.WriteStream,
    output: () => chunks.join(""),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

test("non-TTY apply progress announces the phase once, not once per operation", async () => {
  const output = captureStream(false);

  await Effect.runPromise(
    withProgress(
      "Applying Linux packages",
      3,
      (progress) =>
        Effect.gen(function* () {
          yield* progress.track("Installing curl", Effect.void);
          yield* progress.track("Installing git", Effect.void);
          yield* progress.track("Installing ripgrep", Effect.void);
        }),
      { stream: output.stream },
    ),
  );

  expect(output.output().trim().split("\n")).toHaveLength(1);
  expect(output.output()).toContain("Applying Linux packages (3 operations)");
  expect(output.output()).not.toContain("Installing curl");
});

test("TTY activity status redraws elapsed time without a fake percentage or ETA", async () => {
  vi.useFakeTimers();
  const output = captureStream(true);
  const pending = Effect.runPromise(
    withActivity("Checking Nix source", Effect.sleep("2 seconds"), { stream: output.stream }),
  );

  await vi.advanceTimersByTimeAsync(1_200);
  expect(output.output()).toContain("Checking Nix source");
  expect(output.output()).toContain("1s");
  expect(output.output()).not.toContain("ETA");
  expect(output.output()).not.toContain("%");

  await vi.advanceTimersByTimeAsync(800);
  await pending;
});

test("a failed attempted operation still closes and finalizes its TTY progress bar", async () => {
  const output = captureStream(true);

  await expect(
    Effect.runPromise(
      withProgress(
        "Windows apply",
        2,
        (progress) => progress.track("WinGet install: Example.Editor", Effect.fail("failed")),
        { stream: output.stream },
      ),
    ),
  ).rejects.toBe("failed");

  expect(output.output()).toContain("WinGet install: Example.Editor");
  expect(output.output()).toContain("1/2 tried");
  expect(output.output()).toContain("\n");
});
