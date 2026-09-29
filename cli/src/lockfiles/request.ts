import { decodeResponse, ErrorBody, isJsonValue } from "@outfitting/contract";

import { resolveLockfileCredentials } from "@/lockfiles/keychain";
import type { CliRequestInit, LockfileCredentials } from "@/lockfiles/types";

export class WorkerResponseError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Worker returned ${status}: ${detail}`);
    this.name = "WorkerResponseError";
  }
}

function endpoint(workerUrl: string, parts: ReadonlyArray<string>): string {
  return `${workerUrl}/${parts.map(encodeURIComponent).join("/")}`;
}

export async function request(
  parts: ReadonlyArray<string>,
  init: CliRequestInit = {},
  credentials?: LockfileCredentials,
): Promise<Response> {
  const resolved = credentials ?? (await resolveLockfileCredentials());
  const url = endpoint(resolved.workerUrl, parts);
  const headers = { ...init.headers, Authorization: `Bearer ${resolved.token}` };

  const response = await fetch(url, {
    ...init,
    headers,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  if (response.ok) {
    return response;
  }

  const contentType = response.headers.get("Content-Type") ?? "";
  let detail = response.statusText;
  if (contentType.includes("application/json")) {
    const raw: unknown = await response.json();
    if (isJsonValue(raw)) {
      const body = decodeResponse(ErrorBody, raw, "error");
      if (body) {
        detail = body.error;
      }
    }
  } else {
    detail = (await response.text()) || detail;
  }

  throw new WorkerResponseError(response.status, detail);
}
