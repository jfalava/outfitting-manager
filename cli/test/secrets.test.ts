import { afterEach, describe, expect, test, vi } from "vitest";

import { r2Credentials } from "@/fonts/keychain";
import { envValue, inAmpOrb } from "@/secrets";
import { apiToken, baseUrl, storeApiToken, storeWorkerUrl } from "@/sync/keychain";

const ENV_KEYS = [
  "AMP_ORB",
  "OUTFITTING_SYNC_TOKEN",
  "OUTFITTING_SYNC_URL",
  "OUTFITTING_S3_ENDPOINT",
  "OUTFITTING_S3_ACCESS_KEY",
  "OUTFITTING_S3_SECRET_KEY",
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  saved.set(key, process.env[key]);
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const key of ENV_KEYS) {
    const original = saved.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setEnv({});
});

describe("orb environment credentials", () => {
  test("treats AMP_ORB=1 as an Amp orb", () => {
    setEnv({ AMP_ORB: "1" });
    expect(inAmpOrb()).toBe(true);
    setEnv({ AMP_ORB: undefined });
    expect(inAmpOrb()).toBe(false);
    expect(envValue("AMP_ORB")).toBeUndefined();
  });

  test("reads lockfiles credentials from env in a headless environment", async () => {
    setEnv({
      AMP_ORB: "1",
      OUTFITTING_SYNC_TOKEN: "  orb-token  ",
      OUTFITTING_SYNC_URL: "https://example.workers.dev/api/",
    });
    expect(await apiToken()).toBe("orb-token");
    expect(await baseUrl()).toBe("https://example.workers.dev/api");
  });

  test("reads lockfiles credentials from env without requiring an Amp orb", async () => {
    setEnv({
      AMP_ORB: undefined,
      OUTFITTING_SYNC_TOKEN: "  host-token  ",
      OUTFITTING_SYNC_URL: "https://example.workers.dev/api/",
    });
    expect(await apiToken()).toBe("host-token");
    expect(await baseUrl()).toBe("https://example.workers.dev/api");
  });

  test("requires the lockfiles Worker URL in a headless environment", async () => {
    setEnv({
      AMP_ORB: "1",
      OUTFITTING_SYNC_URL: undefined,
    });
    await expect(baseUrl()).rejects.toThrow(
      "OUTFITTING_SYNC_URL is required in a headless environment.",
    );
  });

  test("requires an unconfigured Worker URL to be saved with sync configure worker", async () => {
    setEnv({
      AMP_ORB: undefined,
      OUTFITTING_SYNC_URL: undefined,
    });
    vi.stubGlobal("Bun", {
      secrets: { get: vi.fn().mockResolvedValue(null) },
    });
    await expect(baseUrl()).rejects.toThrow(
      "Sync Worker URL is not configured. Run 'outfitting-manager sync configure worker' first.",
    );
  });

  test("stores sync credentials under the new keychain service and names", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Bun", { secrets: { get: vi.fn(), set } });

    await storeWorkerUrl("https://example.workers.dev/api/");
    await storeApiToken("  sync-token-value  ");

    expect(set.mock.calls).toEqual([
      [
        {
          service: "outfitting-sync",
          name: "sync-url",
          value: "https://example.workers.dev/api",
        },
      ],
      [
        {
          service: "outfitting-sync",
          name: "sync-token",
          value: "sync-token-value",
        },
      ],
    ]);
  });

  test("requires OUTFITTING_SYNC_TOKEN in a headless environment", async () => {
    setEnv({
      AMP_ORB: "1",
      OUTFITTING_SYNC_TOKEN: undefined,
    });
    await expect(apiToken()).rejects.toThrow(
      "OUTFITTING_SYNC_TOKEN is required in a headless environment.",
    );
  });

  test("reads R2 credentials from env in a headless environment", async () => {
    setEnv({
      AMP_ORB: "1",
      OUTFITTING_S3_ENDPOINT: "0123456789abcdef0123456789abcdef",
      OUTFITTING_S3_ACCESS_KEY: " access ",
      OUTFITTING_S3_SECRET_KEY: " secret ",
    });
    expect(await r2Credentials()).toEqual({
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      accessKeyId: "access",
      secretAccessKey: "secret",
    });
  });

  test("requires R2 env vars in a headless environment", async () => {
    setEnv({
      AMP_ORB: "1",
      OUTFITTING_S3_ENDPOINT: undefined,
      OUTFITTING_S3_ACCESS_KEY: "access",
      OUTFITTING_S3_SECRET_KEY: "secret",
    });
    await expect(r2Credentials()).rejects.toThrow(
      "OUTFITTING_S3_ENDPOINT is required in a headless environment.",
    );

    setEnv({
      AMP_ORB: "1",
      OUTFITTING_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
      OUTFITTING_S3_ACCESS_KEY: undefined,
      OUTFITTING_S3_SECRET_KEY: "secret",
    });
    await expect(r2Credentials()).rejects.toThrow(
      "OUTFITTING_S3_ACCESS_KEY and OUTFITTING_S3_SECRET_KEY are required in a headless environment.",
    );
  });
});
