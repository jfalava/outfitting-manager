import { Effect } from "effect";

import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { envValue, inAmpOrb, promptCredential, storedSecret } from "@/secrets";

const SECRET_SERVICE = "outfitting-fonts";
const ENDPOINT_SECRET_NAME = "r2-endpoint";
const ACCESS_KEY_SECRET_NAME = "r2-access-key-id";
const SECRET_KEY_SECRET_NAME = "r2-secret-access-key";
const BUCKET_SECRET_NAME = "r2-bucket";

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
/** S3/R2 bucket naming: 3-63 lowercase letters, digits, and hyphens, alphanumeric at both ends. */
const BUCKET_NAME = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

export const R2_ENDPOINT_PROMPT =
  "R2 S3 endpoint, bucket URL, or Cloudflare account ID (stored in your OS keychain)";
export const R2_ENDPOINT_MISSING = "An R2 endpoint is required.";
const R2_KEYS_MISSING = "An R2 access key ID and secret access key are required.";

export interface R2Credentials {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface R2Location {
  /** The bare S3 origin, such as `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  /** The bucket named by a bucket URL's single path segment. */
  readonly bucket?: string;
}

/**
 * Parse an account ID, a bare S3 endpoint, or a single-bucket URL such as the one Cloudflare shows
 * on a bucket's page (`https://<account>.r2.cloudflarestorage.com/<bucket>`).
 */
export function parseR2Location(value: string): R2Location {
  const trimmed = value.trim();
  if (ACCOUNT_ID.test(trimmed)) {
    return { endpoint: `https://${trimmed.toLowerCase()}.r2.cloudflarestorage.com` };
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
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("R2 endpoint must not include credentials, a query, or a fragment.");
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length > 1) {
    throw new Error("R2 endpoint may name at most one bucket, as https://<host>/<bucket>.");
  }
  const bucket = segments[0];
  if (bucket !== undefined && !BUCKET_NAME.test(bucket)) {
    throw new Error(`${bucket} is not a valid R2 bucket name.`);
  }
  return bucket === undefined ? { endpoint: parsed.origin } : { endpoint: parsed.origin, bucket };
}

/** Normalize an endpoint used for S3 requests; a bucket path is rejected rather than ignored. */
export function normalizeR2Endpoint(value: string): string {
  const { endpoint, bucket } = parseR2Location(value);
  if (bucket !== undefined) {
    throw new Error(
      `R2 endpoint ${endpoint}/${bucket} includes a bucket; use ${endpoint} and set the bucket separately, or rerun "fonts configure-endpoint" with the bucket URL.`,
    );
  }
  return endpoint;
}

/** Store the endpoint and, from a bucket URL, its bucket; an endpoint alone clears a stored bucket. */
export async function storeR2Endpoint(value: string): Promise<R2Location> {
  const location = parseR2Location(value);
  await Bun.secrets.set({
    service: SECRET_SERVICE,
    name: ENDPOINT_SECRET_NAME,
    value: location.endpoint,
  });
  if (location.bucket === undefined) {
    await Bun.secrets.delete({ service: SECRET_SERVICE, name: BUCKET_SECRET_NAME });
  } else {
    await Bun.secrets.set({
      service: SECRET_SERVICE,
      name: BUCKET_SECRET_NAME,
      value: location.bucket,
    });
  }
  return location;
}

/** The bucket stored by `fonts configure-endpoint`; headless environments never read native secrets. */
export const r2StoredBucket = Effect.gen(function* () {
  if (inAmpOrb()) {
    return undefined;
  }
  const stored = yield* tryPromise(() => storedSecret(SECRET_SERVICE, BUCKET_SECRET_NAME));
  return stored?.trim() || undefined;
});

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
  return (yield* tryPromise(() => storeR2Endpoint(value))).endpoint;
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
