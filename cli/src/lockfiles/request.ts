import { decodeResponse, ErrorBody, isJsonValue } from "@outfitting/contract";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpBody, HttpClient } from "effect/http";

import { toError } from "@/lockfiles/effect";
import { normalizeWorkerUrl, resolveLockfileCredentials } from "@/lockfiles/keychain";
import type { CliRequestInit, LockfileCredentials } from "@/lockfiles/types";

export class WorkerResponseError extends Schema.TaggedError<WorkerResponseError>()(
  "WorkerResponseError",
  {
    status: Schema.Finite,
    detail: Schema.String,
    message: Schema.String,
  },
) {}

function endpoint(workerUrl: string, parts: ReadonlyArray<string>): string {
  return `${workerUrl}/${parts.map(encodeURIComponent).join("/")}`;
}

const workerResponseError = Effect.fn("lockfiles.responseError")(function* (
  response: Response,
): Effect.fn.Return<WorkerResponseError, ReturnType<typeof toError>> {
  const contentType = response.headers.get("Content-Type") ?? "";
  let detail = response.statusText;
  if (contentType.includes("application/json")) {
    const raw: unknown = yield* Effect.tryPromise({ try: () => response.json(), catch: toError });
    if (isJsonValue(raw)) {
      const decoded = decodeResponse(ErrorBody, raw, "error");
      if (decoded) {
        detail = decoded.error;
      }
    }
  } else {
    detail = (yield* Effect.tryPromise({ try: () => response.text(), catch: toError })) || detail;
  }

  return new WorkerResponseError({
    status: response.status,
    detail,
    message: `Worker returned ${response.status}: ${detail}`,
  });
});

export const requestEffect = Effect.fn("lockfiles.request")(function* (
  parts: ReadonlyArray<string>,
  init: CliRequestInit = {},
  credentials?: LockfileCredentials,
): Effect.fn.Return<Response, WorkerResponseError | ReturnType<typeof toError>> {
  const resolved =
    credentials ??
    (yield* Effect.tryPromise({
      try: resolveLockfileCredentials,
      catch: toError,
    }));
  const url = endpoint(normalizeWorkerUrl(resolved.workerUrl), parts);
  const headers = {
    ...init.headers,
    Authorization: `Bearer ${resolved.token}`,
  } satisfies Record<string, string>;

  const body =
    init.body === undefined
      ? undefined
      : HttpBody.uint8Array(
          init.body instanceof Uint8Array ? init.body : new Uint8Array(init.body),
          init.headers?.["Content-Type"],
        );
  const httpRequest = (init.method === "PUT" ? HttpClient.put : HttpClient.get)(url, {
    headers,
    body,
  });
  const httpResponse = yield* Effect.provide(
    httpRequest.pipe(Effect.timeout(15_000), Effect.mapError(toError)),
    FetchHttpClient.layer,
  );
  const responseBytes = yield* httpResponse.arrayBuffer.pipe(Effect.mapError(toError));
  const response = yield* Effect.try({
    try: () =>
      new Response(responseBytes, { status: httpResponse.status, headers: httpResponse.headers }),
    catch: toError,
  });
  if (response.ok) {
    return response;
  }
  const error = yield* workerResponseError(response);
  return yield* error;
});

export function request(
  parts: ReadonlyArray<string>,
  init: CliRequestInit = {},
  credentials?: LockfileCredentials,
): Promise<Response> {
  return Effect.runPromise(requestEffect(parts, init, credentials));
}
