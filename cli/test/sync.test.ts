import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Clock, Effect, Fiber, Result } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect, test, vi } from "vitest";

import { CliFailure } from "@/errors";
import {
  inferOutputPath,
  isGitTrackedFile,
  normalizeSha256,
  normalizeWorkerUrl,
  pullLockfile,
  pushLockfile,
  resolveKindSelection,
} from "@/sync";
import { requestEffect, WorkerResponseError } from "@/sync/request";

const execFileAsync = promisify(execFile);

describe("sync command helpers", () => {
  test("infers common lockfile names", () => {
    expect(inferOutputPath("nix")).toBe("flake.lock");
    expect(inferOutputPath("bun")).toBe("bun.lock");
    expect(inferOutputPath("bun-global-inventory")).toBe("bun-global-inventory.json");
    expect(inferOutputPath("homebrew-inventory")).toBe("homebrew-inventory.txt");
    expect(inferOutputPath("npm")).toBe("package-lock.json");
    expect(inferOutputPath("powershell-inventory")).toBe("powershell-inventory.json");
    expect(inferOutputPath("private-fonts")).toBe("private-fonts-inventory.json");
    expect(inferOutputPath("scoop-inventory")).toBe("scoop-inventory.json");
    expect(inferOutputPath("windows")).toBe("windows.lock.json");
    expect(inferOutputPath("winget")).toBe("winget.json");
    expect(inferOutputPath("custom-kind")).toBeUndefined();
  });

  test("distinguishes repository-owned lockfiles from external lock state", async () => {
    const repository = await mkdtemp(join(tmpdir(), "outfitting-lockfiles-test-"));
    const trackedPath = join(repository, "tracked.lock");
    const untrackedPath = join(repository, "untracked.lock");
    const trackedLink = join(repository, "tracked-link.lock");

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(trackedPath, "tracked");
      await writeFile(untrackedPath, "untracked");
      await symlink(untrackedPath, trackedLink);
      await execFileAsync("git", ["-C", repository, "add", "tracked.lock", "tracked-link.lock"]);

      expect(await isGitTrackedFile(trackedPath)).toBe(true);
      expect(await isGitTrackedFile(untrackedPath)).toBe(false);
      expect(await isGitTrackedFile(trackedLink)).toBe(true);
      expect(await isGitTrackedFile(join(repository, "new", "nested", "snapshot.lock"))).toBe(
        false,
      );
      await expect(
        Effect.runPromise(
          pullLockfile({
            machine: "test-machine",
            kind: "test-kind",
            outPath: trackedPath,
          }),
        ),
      ).rejects.toThrow(`Refusing to overwrite Git-tracked file: ${trackedPath}`);
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });

  test("normalizes Worker URLs", () => {
    expect(normalizeWorkerUrl("https://example.workers.dev/")).toBe("https://example.workers.dev");
    expect(() => normalizeWorkerUrl("not a URL")).toThrow("Worker URL must be a valid URL.");
    expect(() => normalizeWorkerUrl("file:///tmp/worker")).toThrow("Worker URL must use HTTPS");
    expect(() => normalizeWorkerUrl("http://remote.example/api")).toThrow("must use HTTPS");
    expect(() => normalizeWorkerUrl("https://user:secret@remote.example/api")).toThrow(
      "must not contain credentials",
    );
    expect(() => normalizeWorkerUrl("https://remote.example/api?token=secret")).toThrow(
      "must not contain credentials",
    );
  });

  test("push uses the supplied lockfile credential snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outfitting-lockfiles-push-test-"));
    const path = join(directory, "flake.lock");
    const contents = '{ "version": 7 }\n';
    await writeFile(path, contents);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://lockfiles.example/api/lockfiles/test-machine/nix");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer snapshot-token");
      return new Response(
        JSON.stringify({
          hash: "a".repeat(64),
          size: new TextEncoder().encode(contents).byteLength,
        }),
        { status: 200 },
      );
    });
    const bytes = new TextEncoder().encode(contents);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    vi.stubGlobal("Bun", {
      file: () => ({
        exists: async () => true,
        arrayBuffer: async () => body,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await Effect.runPromise(
        pushLockfile({
          machine: "test-machine",
          kind: "nix",
          path,
          credentials: {
            workerUrl: "https://lockfiles.example/api",
            token: "snapshot-token",
          },
        }),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects an injected HTTP credential snapshot before sending a bearer token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { requestEffect } = await import("@/sync/request");
      await expect(
        Effect.runPromise(
          requestEffect(
            ["lockfiles", "machine", "nix"],
            {},
            {
              workerUrl: "http://remote.example/api",
              token: "sensitive-token",
            },
          ),
        ),
      ).rejects.toThrow("must use HTTPS");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("validates and normalizes SHA-256 preconditions", () => {
    expect(normalizeSha256("A".repeat(64))).toBe("a".repeat(64));
    expect(() => normalizeSha256("abc")).toThrow("64-character SHA-256");
  });

  test("sync uses one deadline for headers and body and aborts a stalled transfer", async () => {
    const fetchStarted = Promise.withResolvers<void>();
    const headersReady = Promise.withResolvers<void>();
    const bodyStarted = Promise.withResolvers<void>();
    let signal: AbortSignal | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let settledAt: number | undefined;
    const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      fetchStarted.resolve();
      await headersReady.promise;
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            start(stream) {
              controller = stream;
              signal?.addEventListener("abort", () => stream.error(signal?.reason), { once: true });
            },
            pull() {
              bodyStarted.resolve();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    };
    fetcher.preconnect = () => {};

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.gen(function* () {
          const result = yield* Effect.result(
            requestEffect(
              ["lockfiles", "machine", "nix"],
              {},
              {
                workerUrl: "https://sync.example/api",
                token: "fixture-token",
              },
            ),
          );
          settledAt = yield* Clock.currentTimeMillis;
          return result;
        }).pipe(Effect.forkChild);
        yield* Effect.promise(() => fetchStarted.promise);
        yield* TestClock.adjust(9_000);
        headersReady.resolve();
        yield* Effect.promise(() => bodyStarted.promise);
        yield* TestClock.adjust(5_999);
        expect(settledAt).toBeUndefined();
        expect(signal?.aborted).toBe(false);
        yield* TestClock.adjust(1_001);
        // Complete the wrong implementations too, so they fail instead of hanging.
        if (!signal?.aborted) {
          controller.enqueue(new Uint8Array([0x00, 0xff, 0x42]));
          controller.close();
        }
        const result = yield* Fiber.join(fiber);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(CliFailure);
          expect(result.failure.cause).toMatchObject({ _tag: "TimeoutError" });
        }
        expect(settledAt).toBe(15_000);
        expect(signal?.aborted).toBe(true);
      }).pipe(
        Effect.provide(TestClock.layer()),
        Effect.provideService(FetchHttpClient.Fetch, fetcher),
      ),
    );
  });

  test.each([200, 401, 412])(
    "sync preserves buffered responses and HTTP errors: %s",
    async (status) => {
      const bytes = new Uint8Array([0x00, 0xff, 0x42]);
      const fetcher = async () =>
        new Response(status === 200 ? bytes : JSON.stringify({ error: "fixture failure" }), {
          status,
          headers: {
            "Content-Type": status === 200 ? "application/octet-stream" : "application/json",
            ETag: '"fixture"',
          },
        });
      fetcher.preconnect = () => {};
      const result = await Effect.runPromise(
        requestEffect(
          ["lockfiles", "machine", "nix"],
          {},
          {
            workerUrl: "https://sync.example/api",
            token: "fixture-token",
          },
        ).pipe(Effect.result, Effect.provideService(FetchHttpClient.Fetch, fetcher)),
      );
      if (status === 200) {
        expect(Result.isSuccess(result)).toBe(true);
        if (Result.isSuccess(result)) {
          expect(new Uint8Array(await result.success.arrayBuffer())).toEqual(bytes);
          expect(result.success.headers.get("ETag")).toBe('"fixture"');
        }
      } else {
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(WorkerResponseError);
          expect(result.failure).toMatchObject({ status, detail: "fixture failure" });
        }
      }
    },
  );

  test("treats omitted and all kinds as the all selection", () => {
    expect(resolveKindSelection(undefined)).toEqual({ mode: "all" });
    expect(resolveKindSelection("all")).toEqual({ mode: "all" });
    expect(resolveKindSelection(" ALL ")).toEqual({ mode: "all" });
    expect(resolveKindSelection("nix")).toEqual({ mode: "one", kind: "nix" });
    expect(resolveKindSelection(" homebrew-inventory ")).toEqual({
      mode: "one",
      kind: "homebrew-inventory",
    });
  });
});
