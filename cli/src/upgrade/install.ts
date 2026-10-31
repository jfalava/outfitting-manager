import { spawn } from "node:child_process";
import { chmod, rename, writeFile } from "node:fs/promises";

import { Effect, Result, Schedule, Schema } from "effect";

import { toError } from "@/effect";
import { CliFailure, errorMessage } from "@/errors";
import { ui } from "@/ui";
import { extractZipBinary } from "@/upgrade/archive";
import type { CliRelease, Fetcher } from "@/upgrade/release";

const quotePowerShellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_ATTEMPTS = 3;

export class DownloadError extends Schema.TaggedError<DownloadError>()("DownloadError", {
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

function isRetryableNetworkError(cause: unknown): boolean {
  return cause instanceof Error && /connection|fetch|network|socket|timeout/i.test(cause.message);
}

/** Map a fetch or body-read rejection, treating timeouts and network faults as retryable. */
function downloadFailure(label: string, signal: AbortSignal) {
  return (cause: unknown) =>
    new DownloadError({
      message: signal.aborted
        ? `${label} timed out after ${DOWNLOAD_TIMEOUT_MS}ms.`
        : `${label}: ${errorMessage(cause)}`,
      retryable: signal.aborted || isRetryableNetworkError(cause),
    });
}

const downloadAttemptEffect = Effect.fn("upgrade.downloadAttempt")(function* (
  url: string,
  label: string,
  fetcher: Fetcher,
): Effect.fn.Return<Uint8Array, DownloadError> {
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const response = yield* Effect.tryPromise({
    try: () =>
      fetcher(url, {
        headers: { "User-Agent": "outfitting-manager" },
        redirect: "follow",
        signal,
      }),
    catch: downloadFailure(label, signal),
  });
  if (!response.ok) {
    return yield* new DownloadError({
      message: `${label} failed with HTTP ${response.status}: ${url}`,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    });
  }
  return yield* Effect.tryPromise({
    try: async () => new Uint8Array(await response.arrayBuffer()),
    catch: downloadFailure(label, signal),
  });
});

/** Retry retryable failures twice, after 250ms and 500ms. */
export const downloadBytesEffect = (
  url: string,
  label: string,
  fetcher: Fetcher = globalThis.fetch,
): Effect.Effect<Uint8Array, DownloadError> =>
  downloadAttemptEffect(url, label, fetcher).pipe(
    Effect.retry({
      times: DOWNLOAD_ATTEMPTS - 1,
      while: (error) => error.retryable,
      schedule: Schedule.exponential("250 millis"),
    }),
    Effect.withSpan("upgrade.downloadBytes"),
  );

export const installReleaseEffect = Effect.fn("upgrade.installRelease")(function* (
  release: CliRelease,
  targetPath: string,
): Effect.fn.Return<void, DownloadError | CliFailure> {
  const assetBytes = yield* downloadBytesEffect(release.assetUrl, "Release asset");
  const checksumBytes = yield* downloadBytesEffect(release.checksumUrl, "Release checksum");
  const expectedChecksum = yield* Effect.try({
    try: () => checksumFromFile(new TextDecoder().decode(checksumBytes)),
    catch: toError,
  });
  const actualChecksum = yield* Effect.try({
    try: () => new Bun.CryptoHasher("sha256").update(assetBytes).digest("hex"),
    catch: toError,
  });
  if (actualChecksum !== expectedChecksum) {
    return yield* new CliFailure({
      message: `Downloaded release asset checksum mismatch (expected ${expectedChecksum}, received ${actualChecksum}).`,
    });
  }

  const bytes = yield* Effect.try({
    try: () => extractZipBinary(assetBytes, release.executableName),
    catch: toError,
  });

  const temporaryPath = `${targetPath}.upgrade-${process.pid}`;
  yield* Effect.tryPromise({
    try: () => writeFile(temporaryPath, bytes, { mode: 0o755 }),
    catch: toError,
  });

  if (process.platform === "win32") {
    return yield* Effect.try({
      try: () => scheduleWindowsReplacement(temporaryPath, targetPath),
      catch: toError,
    });
  }

  yield* Effect.tryPromise({ try: () => chmod(temporaryPath, 0o755), catch: toError });
  yield* Effect.tryPromise({ try: () => rename(temporaryPath, targetPath), catch: toError });

  // On macOS, ad-hoc sign the binary so it can access the keychain (Bun.secrets) without being killed (exit 137).
  // Newer Bun versions produce unsigned binaries that are killed on first keychain access, causing silent outfit failures.
  if (process.platform === "darwin") {
    const signing = yield* Effect.result(
      Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["codesign", "--force", "--sign", "-", targetPath], {
            stdout: "ignore",
            stderr: "ignore",
          });
          return proc.exited;
        },
        catch: toError,
      }),
    );
    if (Result.isFailure(signing)) {
      yield* Effect.logWarning(
        ui.warning(
          `Could not codesign ${targetPath}: ${signing.failure.message}. The binary may be killed on keychain access.`,
        ),
      );
    } else if (signing.success !== 0) {
      yield* Effect.logWarning(
        ui.warning(
          `Codesign failed for ${targetPath} (exit ${signing.success}). The binary may be killed on keychain access (exit 137). Run 'codesign --force --sign - ${targetPath}' manually.`,
        ),
      );
    }
  }
});

export function checksumFromFile(contents: string): string {
  const checksum = /^([a-fA-F0-9]{64})(?:\s|$)/.exec(contents.trim())?.[1];
  if (!checksum) {
    throw new Error("Release checksum file is invalid.");
  }
  return checksum.toLowerCase();
}

export function scheduleWindowsReplacement(
  temporaryPath: string,
  targetPath: string,
  waitingProcessId = process.pid,
): void {
  const script = [
    `Wait-Process -Id ${waitingProcessId}`,
    `Move-Item -LiteralPath ${quotePowerShellLiteral(temporaryPath)} -Destination ${quotePowerShellLiteral(targetPath)} -Force`,
  ].join("; ");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn(
    "cmd.exe",
    [
      "/d",
      "/c",
      "start",
      "",
      "/b",
      "pwsh.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-WindowStyle",
      "Hidden",
      "-EncodedCommand",
      encodedScript,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}
