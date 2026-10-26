import { maskedPrompt } from "@/masked-prompt";
import { envValue, inAmpOrb, storedSecret } from "@/secrets";
import { terminalPrompt } from "@/terminal-alert";

const SECRET_SERVICE = "outfitting-fonts";
const ENDPOINT_SECRET_NAME = "r2-endpoint";
const ACCESS_KEY_SECRET_NAME = "r2-access-key-id";
const SECRET_KEY_SECRET_NAME = "r2-secret-access-key";

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

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

export async function r2Endpoint(): Promise<string> {
  const fromEnv = envValue("OUTFITTING_S3_ENDPOINT");
  if (fromEnv) {
    return normalizeR2Endpoint(fromEnv);
  }
  if (inAmpOrb()) {
    throw new Error("OUTFITTING_S3_ENDPOINT is required in a headless environment.");
  }

  const stored = await storedSecret(SECRET_SERVICE, ENDPOINT_SECRET_NAME);
  if (stored) {
    return normalizeR2Endpoint(stored);
  }

  const value = (
    await terminalPrompt("R2 S3 endpoint or Cloudflare account ID (stored in your OS keychain):")
  ).trim();
  if (!value) {
    throw new Error("An R2 endpoint is required.");
  }
  return storeR2Endpoint(value);
}

export async function storeR2Credentials(
  accessKeyId: string,
  secretAccessKey: string,
): Promise<void> {
  const id = accessKeyId.trim();
  const secret = secretAccessKey.trim();
  if (!id || !secret) {
    throw new Error("An R2 access key ID and secret access key are required.");
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

export async function promptAndStoreR2Credentials(): Promise<void> {
  const accessKeyId = (
    await terminalPrompt("R2 access key ID (stored in your OS keychain):")
  ).trim();
  const secretAccessKey =
    (await maskedPrompt("R2 secret access key (stored in your OS keychain): "))?.trim() ?? null;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("An R2 access key ID and secret access key are required.");
  }
  await storeR2Credentials(accessKeyId, secretAccessKey);
}

async function storedCredential(name: string): Promise<string | null> {
  return storedSecret(SECRET_SERVICE, name);
}

export async function r2Credentials(): Promise<R2Credentials> {
  const accessKeyId = envValue("OUTFITTING_S3_ACCESS_KEY");
  const secretAccessKey = envValue("OUTFITTING_S3_SECRET_KEY");
  const hasEnvironmentCredentials =
    process.env["OUTFITTING_S3_ACCESS_KEY"] !== undefined ||
    process.env["OUTFITTING_S3_SECRET_KEY"] !== undefined;
  if (hasEnvironmentCredentials || inAmpOrb()) {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "OUTFITTING_S3_ACCESS_KEY and OUTFITTING_S3_SECRET_KEY must both be non-empty when using environment credentials.",
      );
    }
    const endpoint = await r2Endpoint();
    return { endpoint, accessKeyId, secretAccessKey };
  }

  const endpoint = await r2Endpoint();
  const storedAccessKeyId = await storedCredential(ACCESS_KEY_SECRET_NAME);
  const storedSecretAccessKey = await storedCredential(SECRET_KEY_SECRET_NAME);
  if (storedAccessKeyId && storedSecretAccessKey) {
    return { endpoint, accessKeyId: storedAccessKeyId, secretAccessKey: storedSecretAccessKey };
  }
  await promptAndStoreR2Credentials();
  const storedId = await storedCredential(ACCESS_KEY_SECRET_NAME);
  const storedSecretValue = await storedCredential(SECRET_KEY_SECRET_NAME);
  if (!storedId || !storedSecretValue) {
    throw new Error("An R2 access key ID and secret access key are required.");
  }
  return { endpoint, accessKeyId: storedId, secretAccessKey: storedSecretValue };
}
