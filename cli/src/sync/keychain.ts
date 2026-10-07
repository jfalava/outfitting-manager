import { maskedPrompt } from "@/masked-prompt";
import { envValue, inAmpOrb, storedSecret } from "@/secrets";
import type { LockfileCredentials } from "@/sync/types";

const SECRET_SERVICE = "outfitting-sync";
const TOKEN_SECRET_NAME = "sync-token";
const URL_SECRET_NAME = "sync-url";

export function normalizeWorkerUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Worker URL must be a valid URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Worker URL must use HTTPS to protect the API token.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Worker URL must not contain credentials, a query, or a fragment.");
  }

  return parsed.toString().replace(/\/$/, "");
}

export async function storeWorkerUrl(value: string): Promise<string> {
  const url = normalizeWorkerUrl(value);
  await Bun.secrets.set({
    service: SECRET_SERVICE,
    name: URL_SECRET_NAME,
    value: url,
  });
  return url;
}

export async function baseUrl(): Promise<string> {
  const fromEnv = envValue("OUTFITTING_SYNC_URL");
  if (fromEnv) {
    return normalizeWorkerUrl(fromEnv);
  }

  if (inAmpOrb()) {
    throw new Error("OUTFITTING_SYNC_URL is required in a headless environment.");
  }

  const stored = await storedSecret(SECRET_SERVICE, URL_SECRET_NAME);

  if (stored) {
    return normalizeWorkerUrl(stored);
  }

  throw new Error(
    "Sync Worker URL is not configured. Run 'outfitting-manager sync configure worker' first.",
  );
}

export async function storeApiToken(token: string): Promise<string> {
  const value = token.trim();
  if (!value) {
    throw new Error("An API token is required.");
  }

  await Bun.secrets.set({
    service: SECRET_SERVICE,
    name: TOKEN_SECRET_NAME,
    value,
  });
  return value;
}

export async function promptAndStoreApiToken(): Promise<string> {
  const token =
    (await maskedPrompt("Sync API token (stored in your OS keychain): "))?.trim() ?? null;
  if (!token) {
    throw new Error("An API token is required.");
  }

  return storeApiToken(token);
}

export async function apiToken(): Promise<string> {
  const fromEnv = envValue("OUTFITTING_SYNC_TOKEN");
  if (fromEnv) {
    return fromEnv;
  }

  if (inAmpOrb()) {
    throw new Error("OUTFITTING_SYNC_TOKEN is required in a headless environment.");
  }

  // Bun.secrets is experimental and does not isolate credentials between scripts running as the same OS user. That is acceptable for this personal tool, but the keychain entry is not a hard security boundary.
  const token = await storedSecret(SECRET_SERVICE, TOKEN_SECRET_NAME);

  return token || promptAndStoreApiToken();
}

export async function resolveLockfileCredentials(): Promise<LockfileCredentials> {
  return {
    workerUrl: await baseUrl(),
    token: await apiToken(),
  };
}
