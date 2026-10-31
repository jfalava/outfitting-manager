import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import { CliError, Command } from "effect/cli";
import { afterEach, describe, expect, test, vi } from "vitest";

import { makeLinuxUpdateCommand } from "@/commands/update/linux";
import { makeWindowsUpdateCommand } from "@/commands/update/windows";

const execFileAsync = promisify(execFile);
afterEach(() => vi.restoreAllMocks());
const cliEntry = fileURLToPath(new URL("../index.macos.ts", import.meta.url));

const runCliWithEnv = async (
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd?: string,
) => {
  try {
    const result = await execFileAsync("bun", [cliEntry, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      cwd,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
};

describe("update and provision commands", () => {
  test.each<[string, Command.Command.Any, string, string]>([
    ["linux", makeLinuxUpdateCommand(), "scoop", 'Expected: "apt" | "pacman"'],
    ["windows", makeWindowsUpdateCommand(), "apt", 'Expected: "winget" | "scoop"'],
  ])(
    "%s update rejects a foreign package manager before running",
    async (_platform, update, foreign, expected) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      const root = Command.make("outfitting-manager").pipe(
        Command.withSubcommands([
          update.pipe(Command.provideEffectDiscard(Effect.die(new Error("update ran")))),
        ]),
      );
      const exit = await Effect.runPromiseExit(
        Command.runWith(root, { version: "1.0.0" })(["update", "--package-manager", foreign]).pipe(
          Effect.provide(BunServices.layer),
        ) as Effect.Effect<void, unknown>,
      );
      expect(Exit.isFailure(exit) && CliError.isCliError(Cause.squash(exit.cause))).toBe(true);
      expect(error.mock.calls.flat().join("\n")).toContain(
        `Invalid value for flag --package-manager: "${foreign}". ${expected}`,
      );
    },
  );

  test.each(["relative environment", "flag overrides stale environment", "unconfigured"])(
    "provision preserves deployment selection across directories: %s",
    async (selection) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "outfitting-provision-")));
      const iac = join(root, "iac");
      const loader = fileURLToPath(new URL("../../iac/src/deploy-config.ts", import.meta.url));
      try {
        await mkdir(iac);
        await writeFile(join(iac, "alchemy.run.ts"), "");
        // Only the deploy subprocess is fake; it resolves the real config without Cloudflare access.
        await writeFile(
          join(iac, "package.json"),
          JSON.stringify({ scripts: { alchemy: "bun fake-alchemy.ts" } }),
        );
        await writeFile(
          join(iac, "fake-alchemy.ts"),
          `
          import { loadDeployConfig } from ${JSON.stringify(loader)};
          const config = loadDeployConfig();
          await Bun.write("resolved.json", JSON.stringify({ domain: config.domain ?? null, configPath: config.configPath ?? null }));
          console.log("url: https://" + (config.domain ?? "fixture.workers.dev"));
        `,
        );
        const configPath = join(root, "deployment.json");
        await writeFile(configPath, JSON.stringify({ domain: "manager.example.com" }));
        const args = ["provision", "--skip-configure"];
        if (selection === "flag overrides stale environment")
          args.push("--deploy-config", "deployment.json");
        const { code, stdout, stderr } = await runCliWithEnv(
          args,
          {
            OUTFITTING_IAC_DIR: iac,
            OUTFITTING_STATE_ROOT: root,
            OUTFITTING_CONFIG: undefined,
            OUTFITTING_DOMAIN: undefined,
            OUTFITTING_SYNC_TOKEN: "fixture-only-token",
            OUTFITTING_DEPLOY_CONFIG:
              selection === "relative environment"
                ? "deployment.json"
                : selection === "flag overrides stale environment"
                  ? "missing.json"
                  : undefined,
          },
          root,
        );
        expect(code, `${stdout}\n${stderr}`).toBe(0);
        const resolved = JSON.parse(await readFile(join(iac, "resolved.json"), "utf8"));
        const configured = selection !== "unconfigured";
        expect(resolved.domain).toBe(configured ? "manager.example.com" : null);
        expect(resolved.configPath).toBe(configured ? configPath : null);
        expect(stdout).toContain(
          configured ? "https://manager.example.com/api" : "https://fixture.workers.dev/api",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
