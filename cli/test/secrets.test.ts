import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

import { secretNames, type BackupCredentials } from "@/backups/model";
import { Secrets as BackupSecrets } from "@/backups/secrets";
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

const account = " Scheduled O'Brien ";
const credentials: BackupCredentials = {
  "access-key": " Team A's Access ",
  "secret-key": "Production Secret 02",
  "repository-password": "Archive's repository password",
  "alert-token": "Operations Alert Token!",
};

function nativeStore(entries: Array<[string, string]> = [], caseInsensitive = false) {
  const target = (value: string) => (caseInsensitive ? value.toUpperCase() : value);
  const stored = new Map(entries.map(([key, value]) => [target(key), value]));
  vi.stubGlobal("Bun", {
    secrets: {
      get: async ({ service, name }: { service: string; name: string }) =>
        stored.get(target(`${service}/${name}`)) ?? null,
      set: async (entry: { service: string; name: string; value: string }) => {
        stored.set(target(`${entry.service}/${entry.name}`), entry.value);
      },
    },
  });
  return { stored };
}

test.each(["darwin", "win32"] as const)(
  "%s backup credentials preserve every configured service and account exactly",
  async (platform) => {
    const { stored } = nativeStore(
      secretNames.map((name) => [
        `${credentials[name]}/${account}`,
        `${platform}-original-${name}`,
      ]),
      platform === "win32",
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const secrets = yield* BackupSecrets;
        for (const name of secretNames) {
          expect(Redacted.value(yield* secrets.get(name))).toBe(`${platform}-original-${name}`);
          yield* secrets.set(name, Redacted.make(`${platform}-rotated-${name}`));
          expect(Redacted.value(yield* secrets.get(name))).toBe(`${platform}-rotated-${name}`);
        }
      }).pipe(Effect.provide(BackupSecrets.layer(account, credentials, platform))),
    );
    expect([...stored]).toEqual(
      secretNames.map((name) => [
        platform === "win32"
          ? `${credentials[name]}/${account}`.toUpperCase()
          : `${credentials[name]}/${account}`,
        `${platform}-rotated-${name}`,
      ]),
    );
  },
);

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
    expect(await Effect.runPromise(apiToken)).toBe("orb-token");
    expect(await baseUrl()).toBe("https://example.workers.dev/api");
  });

  test("reads lockfiles credentials from env without requiring an Amp orb", async () => {
    setEnv({
      AMP_ORB: undefined,
      OUTFITTING_SYNC_TOKEN: "  host-token  ",
      OUTFITTING_SYNC_URL: "https://example.workers.dev/api/",
    });
    expect(await Effect.runPromise(apiToken)).toBe("host-token");
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
    await expect(Effect.runPromise(apiToken)).rejects.toThrow(
      "OUTFITTING_SYNC_TOKEN is required in a headless environment.",
    );
  });

  test.each(["1", undefined])("reads R2 environment credentials with AMP_ORB=%s", async (orb) => {
    setEnv({
      AMP_ORB: orb,
      OUTFITTING_S3_ENDPOINT: "0123456789abcdef0123456789abcdef",
      OUTFITTING_S3_ACCESS_KEY: " access ",
      OUTFITTING_S3_SECRET_KEY: " secret ",
    });
    vi.stubGlobal("Bun", {
      secrets: {
        get: () => {
          throw new Error("Native credentials must not be read");
        },
      },
    });
    expect(await Effect.runPromise(r2Credentials)).toEqual({
      endpoint: "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
      accessKeyId: "access",
      secretAccessKey: "secret",
    });
  });

  test.each([
    ["access-only", "access", undefined],
    ["secret-only", undefined, "secret"],
    ["blank-secret", "access", " "],
    ["blank-pair", " ", " "],
  ])(
    "rejects %s environment credentials instead of mixing with native values",
    async (_name, access, secret) => {
      setEnv({
        AMP_ORB: undefined,
        OUTFITTING_S3_ENDPOINT: undefined,
        OUTFITTING_S3_ACCESS_KEY: access,
        OUTFITTING_S3_SECRET_KEY: secret,
      });
      vi.stubGlobal("Bun", {
        secrets: {
          get: () => {
            throw new Error("Native credentials must not be read");
          },
        },
      });
      await expect(Effect.runPromise(r2Credentials)).rejects.toThrow("must both be non-empty");
    },
  );

  test("preserves native font credentials and allows an endpoint environment override", async () => {
    setEnv({
      AMP_ORB: undefined,
      OUTFITTING_S3_ENDPOINT: undefined,
      OUTFITTING_S3_ACCESS_KEY: undefined,
      OUTFITTING_S3_SECRET_KEY: undefined,
    });
    nativeStore([
      ["outfitting-fonts/r2-endpoint", "https://native.r2.cloudflarestorage.com"],
      ["outfitting-fonts/r2-access-key-id", "native-access"],
      ["outfitting-fonts/r2-secret-access-key", "native-secret"],
    ]);
    expect(await Effect.runPromise(r2Credentials)).toEqual({
      endpoint: "https://native.r2.cloudflarestorage.com",
      accessKeyId: "native-access",
      secretAccessKey: "native-secret",
    });
    setEnv({
      AMP_ORB: undefined,
      OUTFITTING_S3_ENDPOINT: "https://override.r2.cloudflarestorage.com/",
      OUTFITTING_S3_ACCESS_KEY: undefined,
      OUTFITTING_S3_SECRET_KEY: undefined,
    });
    expect(await Effect.runPromise(r2Credentials)).toEqual({
      endpoint: "https://override.r2.cloudflarestorage.com",
      accessKeyId: "native-access",
      secretAccessKey: "native-secret",
    });
  });

  test("requires R2 env vars in a headless environment", async () => {
    setEnv({
      AMP_ORB: "1",
      OUTFITTING_S3_ENDPOINT: undefined,
      OUTFITTING_S3_ACCESS_KEY: "access",
      OUTFITTING_S3_SECRET_KEY: "secret",
    });
    await expect(Effect.runPromise(r2Credentials)).rejects.toThrow(
      "OUTFITTING_S3_ENDPOINT is required in a headless environment.",
    );

    setEnv({
      AMP_ORB: "1",
      OUTFITTING_S3_ENDPOINT: "https://abc.r2.cloudflarestorage.com",
      OUTFITTING_S3_ACCESS_KEY: undefined,
      OUTFITTING_S3_SECRET_KEY: "secret",
    });
    await expect(Effect.runPromise(r2Credentials)).rejects.toThrow(
      "OUTFITTING_S3_ACCESS_KEY and OUTFITTING_S3_SECRET_KEY must both be non-empty when using environment credentials.",
    );
  });
});
