import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployConfigToEnv, loadDeployConfig } from "../src/deploy-config";

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
    expect(config.databaseName).toBe("outfitting-lockfiles");
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

test("loads manager resources from the config file", () => {
  withCleanEnv(() => {
    const path = join(process.cwd(), "outfitting.deploy.json");
    writeFileSync(
      path,
      JSON.stringify({
        domain: "api.example.com",
        stackName: "my-manager",
        database: "my-db",
        kv: "my-kv",
        privateFonts: "my-fonts",
        workers: { router: "r1", api: "a1" },
      }),
    );
    const config = loadDeployConfig({ configPath: path });

    expect(config.domain).toBe("api.example.com");
    expect(config.stackName).toBe("my-manager");
    expect(config.databaseName).toBe("my-db");
    expect(config.kvTitle).toBe("my-kv");
    expect(config.privateFontsBucket).toBe("my-fonts");
    expect(config.workers).toEqual({ router: "r1", api: "a1" });
    expect(config.configPath).toBe(path);
  });
});

test.each([
  [{ databse: "typo-db" }, "unknown keys: databse"],
  [{ installerHosts: ["linux.example.com"] }, "unknown keys: installerHosts"],
  [{ kvTitle: "old-alias" }, "unknown keys: kvTitle"],
  [{ workers: { router: "r1", docs: "d1" } }, "workers in deploy config"],
  [{ workers: "r1" }, "workers in deploy config"],
])("rejects %j instead of silently using default resources", (file, message) => {
  withCleanEnv(() => {
    const path = join(process.cwd(), "outfitting.deploy.json");
    writeFileSync(path, JSON.stringify(file));
    expect(() => loadDeployConfig({ configPath: path })).toThrow(message);
  });
});

test("environment overrides the config file", () => {
  withCleanEnv(() => {
    const path = join(process.cwd(), "outfitting.deploy.json");
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
    const path = join(process.cwd(), "outfitting.deploy.json");
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
    stackName: "stack",
    kvTitle: "kv",
    databaseName: "db",
    privateFontsBucket: "fonts",
    workers: { router: "router", api: "api" },
    domain: "api.example.com",
    configPath: "/ignored/outfitting.deploy.json",
  });

  expect(env).toEqual({
    OUTFITTING_STACK_NAME: "stack",
    OUTFITTING_KV_TITLE: "kv",
    OUTFITTING_DB_NAME: "db",
    OUTFITTING_PRIVATE_FONTS_BUCKET: "fonts",
    OUTFITTING_ROUTER_NAME: "router",
    OUTFITTING_API_NAME: "api",
    OUTFITTING_DOMAIN: "api.example.com",
  });
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
    const path = join(process.cwd(), "bad.json");
    writeFileSync(path, "[1,2,3]");

    expect(() => loadDeployConfig({ configPath: path })).toThrow(/JSON object/);
  });
});
