import { Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { envValue, inAmpOrb, promptCredential, storedSecret } from "@/secrets";

const SECRET_SERVICE = "outfitting-fonts";
const ENDPOINT_SECRET_NAME = "r2-endpoint";
const ACCESS_KEY_SECRET_NAME = "r2-access-key-id";
const SECRET_KEY_SECRET_NAME = "r2-secret-access-key";

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

export const R2_ENDPOINT_PROMPT =
  "R2 S3 endpoint or Cloudflare account ID (stored in your OS keychain)";
export const R2_ENDPOINT_MISSING = "An R2 endpoint is required.";
const R2_KEYS_MISSING = "An R2 access key ID and secret access key are required.";

export interface R2Credentials {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export function normalizeR2Endpoint(value: string): string {
  const trimmed = value.trim();
  if (ACCOUNT_ID.test(trimmed)) {
    return `https://${trimmed.toLowerCase()}.r2.cloudflarestorage.com`;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("R2 endpoint must be an HTTPS URL or a 32-character Cloudflare account ID.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("R2 endpoint must use HTTPS.");
  }

  return parsed.toString().replace(/\/$/, "");
}

export async function storeR2Endpoint(value: string): Promise<string> {
  const endpoint = normalizeR2Endpoint(value);
  await Bun.secrets.set({
    service: SECRET_SERVICE,
    name: ENDPOINT_SECRET_NAME,
    value: endpoint,
  });
  return endpoint;
}

const r2Endpoint = Effect.gen(function* () {
  const fromEnv = envValue("OUTFITTING_S3_ENDPOINT");
  if (fromEnv) {
    return normalizeR2Endpoint(fromEnv);
  }
  if (inAmpOrb()) {
    return yield* new CliFailure({
      message: "OUTFITTING_S3_ENDPOINT is required in a headless environment.",
    });
  }
  const stored = yield* tryPromise(() => storedSecret(SECRET_SERVICE, ENDPOINT_SECRET_NAME));
  if (stored) {
    return normalizeR2Endpoint(stored);
  }
  const value = yield* promptCredential(R2_ENDPOINT_PROMPT, false, R2_ENDPOINT_MISSING);
  return yield* tryPromise(() => storeR2Endpoint(value));
});

export async function storeR2Credentials(
  accessKeyId: string,
  secretAccessKey: string,
): Promise<void> {
  const id = accessKeyId.trim();
  const secret = secretAccessKey.trim();
  if (!id || !secret) {
    throw new Error(R2_KEYS_MISSING);
  }
  await Bun.secrets.set({
    service: SECRET_SERVICE,
    name: ACCESS_KEY_SECRET_NAME,
    value: id,
  });
  await Bun.secrets.set({
    service: SECRET_SERVICE,
    name: SECRET_KEY_SECRET_NAME,
    value: secret,
  });
}

/** Prompt for both R2 keys, store them, and return the stored values. */
export const promptAndStoreR2Credentials = Effect.gen(function* () {
  const accessKeyId = yield* promptCredential(
    "R2 access key ID (stored in your OS keychain)",
    false,
    R2_KEYS_MISSING,
  );
  const secretAccessKey = yield* promptCredential(
    "R2 secret access key (stored in your OS keychain)",
    true,
    R2_KEYS_MISSING,
  );
  yield* tryPromise(() => storeR2Credentials(accessKeyId, secretAccessKey));
  return { accessKeyId, secretAccessKey };
});

export const r2Credentials = Effect.gen(function* () {
  const accessKeyId = envValue("OUTFITTING_S3_ACCESS_KEY");
  const secretAccessKey = envValue("OUTFITTING_S3_SECRET_KEY");
  const hasEnvironmentCredentials =
    process.env["OUTFITTING_S3_ACCESS_KEY"] !== undefined ||
    process.env["OUTFITTING_S3_SECRET_KEY"] !== undefined;
  if (hasEnvironmentCredentials || inAmpOrb()) {
    if (!accessKeyId || !secretAccessKey) {
      return yield* new CliFailure({
        message:
          "OUTFITTING_S3_ACCESS_KEY and OUTFITTING_S3_SECRET_KEY must both be non-empty when using environment credentials.",
      });
    }
    const endpoint = yield* r2Endpoint;
    return { endpoint, accessKeyId, secretAccessKey } satisfies R2Credentials;
  }

  const endpoint = yield* r2Endpoint;
  const storedId = yield* tryPromise(() => storedSecret(SECRET_SERVICE, ACCESS_KEY_SECRET_NAME));
  const storedKey = yield* tryPromise(() => storedSecret(SECRET_SERVICE, SECRET_KEY_SECRET_NAME));
  const keys =
    storedId && storedKey
      ? { accessKeyId: storedId, secretAccessKey: storedKey }
      : yield* promptAndStoreR2Credentials;
  return { endpoint, ...keys } satisfies R2Credentials;
});
