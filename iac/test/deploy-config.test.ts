import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  const previousCwd = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "outfitting-deploy-cwd-"));
  process.chdir(directory);
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    run();
  } finally {
    process.chdir(previousCwd);
    rmSync(directory, { recursive: true });
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

test("defaults to the Worker URL without selecting a production deployment", () => {
  withCleanEnv(() => {
    const config = loadDeployConfig();
    expect(config.stackName).toBe("OutfittingManager");
    expect(config.domain).toBeUndefined();
    expect(config.configPath).toBeUndefined();
    expect(config.workers).toEqual({
      router: "outfitting-manager-router",
      api: "outfitting-api",
    });
    expect(config.databaseName).toBe(DEFAULT_DEPLOY_CONFIG.databaseName);
  });
});

test("explicit production config preserves the existing hostname and resource identities", () => {
  withCleanEnv(() => {
    const config = loadDeployConfig({
      configPath: join(import.meta.dir, "../outfitting.production.deploy.json"),
    });
    expect(config).toMatchObject({
      domain: "outfitting.jfa.dev",
      stackName: "OutfittingManager",
      databaseName: "outfitting-lockfiles",
      kvTitle: "outfitting-lockfiles",
      privateFontsBucket: "outfitting-private-fonts",
      workers: { router: "outfitting-manager-router", api: "outfitting-api" },
    });
    Object.assign(process.env, deployConfigToEnv(config));
    expect(loadDeployConfig()).toEqual({ ...config, configPath: undefined });
  });
});

test.each(["flag", "environment"])("rejects a missing config selected by %s", (selection) => {
  withCleanEnv(() => {
    const path = join(process.cwd(), "missing.json");
    if (selection === "environment") process.env.OUTFITTING_DEPLOY_CONFIG = path;
    expect(() => loadDeployConfig(selection === "flag" ? { configPath: path } : undefined)).toThrow(
      `Deploy config does not exist: ${path}`,
    );
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
    const path = join(process.cwd(), "outfitting.deploy.json");
    writeFileSync(path, JSON.stringify({ domain: "file.example.com" }));
    process.env.OUTFITTING_DOMAIN = "";
    const config = loadDeployConfig();

    expect(config.domain).toBeUndefined();
    expect(deployConfigToEnv(config).OUTFITTING_DOMAIN).toBe("");
  });
});

test.each([undefined, "", "   "])(
  "explicit domain %j clears file and environment values",
  (domain) => {
    withCleanEnv(() => {
      writeFileSync(
        join(process.cwd(), "outfitting.deploy.json"),
        JSON.stringify({ domain: "file.example.com" }),
      );
      process.env.OUTFITTING_DOMAIN = "env.example.com";
      expect(loadDeployConfig({ overrides: { domain } }).domain).toBeUndefined();
    });
  },
);

test("rejects malformed JSON selected through the environment", () => {
  withCleanEnv(() => {
    const path = join(process.cwd(), "bad.json");
    writeFileSync(path, "{");
    process.env.OUTFITTING_DEPLOY_CONFIG = path;
    expect(() => loadDeployConfig()).toThrow(`Could not parse deploy config at ${path}`);
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
