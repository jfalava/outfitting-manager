import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Effect, Layer, Redacted } from "effect";
import { afterEach, describe, expect, test, vi } from "vitest";

import { BackupError, secretNames, type BackupCredentials } from "@/backups/model";
import { Processes } from "@/backups/process";
import { Secrets as BackupSecrets, importSecretStore } from "@/backups/secrets";
import { Settings, type SettingsData } from "@/backups/settings";
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
const importedValues = {
  "access-key": "imported-access-19",
  "secret-key": "imported-secret-72",
  "repository-password": "imported-password-43",
  "alert-token": "imported-alert-86",
};

function nativeStore(entries: Array<[string, string]> = [], caseInsensitive = false) {
  const target = (value: string) => (caseInsensitive ? value.toUpperCase() : value);
  const stored = new Map(entries.map(([key, value]) => [target(key), value]));
  const writes: Array<{ service: string; name: string; value: string }> = [];
  vi.stubGlobal("Bun", {
    secrets: {
      get: async ({ service, name }: { service: string; name: string }) =>
        stored.get(target(`${service}/${name}`)) ?? null,
      set: async (entry: { service: string; name: string; value: string }) => {
        writes.push(entry);
        stored.set(target(`${entry.service}/${entry.name}`), entry.value);
      },
    },
  });
  return { stored, writes };
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

describe("SecretStore import", () => {
  function runImport(
    alert: SettingsData["alert"],
    values: Partial<typeof importedValues>,
    options: { credentials?: BackupCredentials; vault?: string; powerShellPrelude?: string } = {},
  ) {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const settings: SettingsData = {
      repoRoot: "C:\\fixture",
      home: "C:\\Users\\fixture",
      account,
      hostname: "fixture-host",
      rustic: "rustic.exe",
      stateDirectory: "C:\\fixture\\state",
      logFile: "C:\\fixture\\logs\\rustic.log",
      logDirectory: "C:\\fixture\\logs",
      credentials: options.credentials ?? credentials,
      scheduleLabel: "fixture-backups",
      alert,
      repository: "fixture-repository",
      jobs: ["photos"],
      dailyHour: 9,
      jobPolicies: {},
      sources: { photos: ["C:\\Photos"] },
      environment: {},
      profile: {
        repository: { repository: "s3:https://example.invalid/backups" },
        forget: { "keep-daily": 7 },
        backup: {
          snapshots: [
            {
              name: "photos",
              sources: ["C:\\Photos"],
              tags: ["photos"],
              "skip-if-unchanged": true,
            },
          ],
        },
      },
    };
    const result = Effect.runPromise(
      importSecretStore(options.vault ?? "Team's Vault").pipe(
        Effect.provide([
          Layer.succeed(Settings, settings),
          Layer.succeed(
            Processes,
            Processes.of({
              run: (_executable, args) => {
                if (options.powerShellPrelude !== undefined) {
                  return Effect.tryPromise({
                    try: async () => {
                      const output = await promisify(execFile)(process.env.OUTFITTING_TEST_PWSH!, [
                        "-NoProfile",
                        "-NonInteractive",
                        "-Command",
                        `${options.powerShellPrelude}; ${args[args.length - 1]!}`,
                      ]);
                      return { ...output, exitCode: 0 };
                    },
                    catch: (error) => new BackupError({ message: String(error) }),
                  });
                }
                return Effect.succeed({ stdout: JSON.stringify(values), stderr: "", exitCode: 0 });
              },
            }),
          ),
          BackupSecrets.layer(account, settings.credentials, "win32"),
        ]),
      ),
    );
    return { result };
  }

  const enabled: SettingsData["alert"] = {
    protocol: "v1",
    url: "https://example.invalid/v1/alerts",
  };

  test.each([false, true])(
    "imports configured identities with alerts enabled=%s",
    async (alerts) => {
      // An unrelated identity and a matching collision must both survive the import.
      const unrelated: [string, string] = ["unrelated-service/another-account", "keep-me"];
      const { stored } = nativeStore([
        unrelated,
        [`${credentials["secret-key"]}/${account}`, importedValues["secret-key"]],
      ]);
      const values = alerts
        ? importedValues
        : {
            "access-key": importedValues["access-key"],
            "secret-key": importedValues["secret-key"],
            "repository-password": importedValues["repository-password"],
          };
      const { result } = runImport(alerts ? enabled : { protocol: "disabled" }, values);
      const names = await result;
      expect(names).toEqual(
        alerts
          ? ["access-key", "secret-key", "repository-password", "alert-token"]
          : ["access-key", "secret-key", "repository-password"],
      );
      expect(stored).toEqual(
        new Map([
          unrelated,
          ...names.map((name): [string, string] => [
            `${credentials[name]}/${account}`,
            importedValues[name],
          ]),
        ]),
      );
    },
  );

  // Uses only a stub Get-Secret function, never the host's vault or native credentials.
  test.skipIf(!process.env.OUTFITTING_TEST_PWSH)(
    "PowerShell imports smart quotes and code-like service/vault names as literal data",
    async () => {
      const identities = {
        "access-key": "Workstation’s Access",
        "secret-key": "access’; Write-Output INJECTION-PROBE; #",
        "repository-password": "archive‘; throw 'injected'; #",
        "alert-token": "alert’$(Write-Output injected)",
      };
      const vault = "Team’s Vault‘; throw 'vault injection'; #";
      const fixture = Buffer.from(
        JSON.stringify({
          vault,
          names: Object.values(identities),
          values: Object.values(importedValues),
        }),
      ).toString("base64");
      const powerShellPrelude = `$fixture = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${fixture}')) | ConvertFrom-Json; function Get-Secret { param($Vault, $Name, [switch]$AsPlainText, $ErrorAction); if ($Vault -cne $fixture.vault) { throw 'Wrong vault' }; $index = [Array]::IndexOf([object[]]$fixture.names, $Name); if ($index -lt 0) { throw 'Wrong service name' }; $fixture.values[$index] }`;
      const { stored } = nativeStore();
      const { result } = runImport(enabled, importedValues, {
        credentials: identities,
        vault,
        powerShellPrelude,
      });
      await expect(result).resolves.toEqual(secretNames);
      expect(stored).toEqual(
        new Map(
          secretNames.map((name) => [`${identities[name]}/${account}`, importedValues[name]]),
        ),
      );
    },
  );

  test.each(secretNames)("rejects a differing %s before writing any credentials", async (name) => {
    const entry: [string, string] = [`${credentials[name]}/${account}`, "existing-local-value"];
    const { stored, writes } = nativeStore([entry]);
    const { result } = runImport(enabled, importedValues);
    await expect(result).rejects.toThrow(
      `Credential ${name} already exists with a different value`,
    );
    expect(stored).toEqual(new Map([entry]));
    expect(writes).toEqual([]);
  });

  test("requires the alert token when alerts are enabled, without writing repository credentials", async () => {
    const { stored, writes } = nativeStore();
    const { result } = runImport(enabled, {
      "access-key": importedValues["access-key"],
      "secret-key": importedValues["secret-key"],
      "repository-password": importedValues["repository-password"],
    });
    await expect(result).rejects.toThrow("SecretStore returned missing alert-token.");
    expect(stored.size).toBe(0);
    expect(writes).toEqual([]);
  });
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
