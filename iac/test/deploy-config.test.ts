import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_DEPLOY_CONFIG, deployConfigToEnv, loadDeployConfig } from "../src/deploy-config";

const ENV_KEYS = [
  "OUTFITTING_STACK_NAME",
  "OUTFITTING_KV_TITLE",
  "OUTFITTING_DB_NAME",
  "OUTFITTING_PRIVATE_FONTS_BUCKET",
  "OUTFITTING_ROUTER_NAME",
  "OUTFITTING_API_NAME",
  "OUTFITTING_DOMAIN",
  "OUTFITTING_DEPLOY_CONFIG",
] as const;

function withCleanEnv(run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("defaults to the separate manager API stack", () => {
  withCleanEnv(() => {
    const config = loadDeployConfig({
      configPath: join(tmpdir(), "missing-outfitting-deploy.json"),
    });
    expect(config.stackName).toBe("OutfittingManager");
    expect(config.domain).toBe("api.outfitting.jfa.dev");
    expect(config.workers).toEqual({
      router: "outfitting-manager-router",
      api: "outfitting-api",
    });
    expect(config.databaseName).toBe(DEFAULT_DEPLOY_CONFIG.databaseName);
  });
});

test("loads manager resources and ignores docs and installer settings", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "outfitting-manager-deploy-"));
    const path = join(dir, "outfitting.deploy.json");
    writeFileSync(
      path,
      JSON.stringify({
        domain: "api.example.com",
        docs: false,
        installerHosts: ["linux.example.com"],
        stackName: "my-manager",
        database: "my-db",
        kv: "my-kv",
        workers: {
          router: "r1",
          api: "a1",
          docs: "d1",
          installer: "i1",
        },
      }),
    );
    const config = loadDeployConfig({ configPath: path });

    expect(config.domain).toBe("api.example.com");
    expect(config.stackName).toBe("my-manager");
    expect(config.databaseName).toBe("my-db");
    expect(config.kvTitle).toBe("my-kv");
    expect(config.workers).toEqual({ router: "r1", api: "a1" });
    expect(config.configPath).toBe(path);
  });
});

test("environment overrides the config file", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "outfitting-manager-deploy-"));
    const path = join(dir, "outfitting.deploy.json");
    writeFileSync(path, JSON.stringify({ stackName: "from-file", domain: "file.example.com" }));
    process.env.OUTFITTING_STACK_NAME = "from-env";
    process.env.OUTFITTING_DOMAIN = "env.example.com";
    const config = loadDeployConfig({ configPath: path });

    expect(config.stackName).toBe("from-env");
    expect(config.domain).toBe("env.example.com");
  });
});

test("explicit overrides beat file and environment", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "outfitting-manager-deploy-"));
    const path = join(dir, "outfitting.deploy.json");
    writeFileSync(path, JSON.stringify({ domain: "file.example.com" }));
    process.env.OUTFITTING_DOMAIN = "env.example.com";
    const config = loadDeployConfig({
      configPath: path,
      overrides: { domain: "flag.example.com" },
    });

    expect(config.domain).toBe("flag.example.com");
  });
});

test("deployConfigToEnv includes only manager stack settings", () => {
  const env = deployConfigToEnv({
    ...DEFAULT_DEPLOY_CONFIG,
    domain: "api.example.com",
    configPath: undefined,
  });

  expect(env.OUTFITTING_DOMAIN).toBe("api.example.com");
  expect(env.OUTFITTING_ROUTER_NAME).toBe("outfitting-manager-router");
  expect(env.OUTFITTING_API_NAME).toBe("outfitting-api");
});

test("empty OUTFITTING_DOMAIN clears the custom domain", () => {
  withCleanEnv(() => {
    process.env.OUTFITTING_DOMAIN = "";
    const config = loadDeployConfig({
      configPath: join(tmpdir(), "missing-outfitting-deploy.json"),
    });

    expect(config.domain).toBeUndefined();
  });
});

test("rejects non-object config files", () => {
  withCleanEnv(() => {
    const dir = mkdtempSync(join(tmpdir(), "outfitting-manager-deploy-"));
    const path = join(dir, "bad.json");
    writeFileSync(path, "[1,2,3]");

    expect(() => loadDeployConfig({ configPath: path })).toThrow(/JSON object/);
  });
});
