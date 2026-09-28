import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import pc from "picocolors";

import { toCliFailure } from "@/errors";
import { storeWorkerUrl } from "@/lockfiles/keychain";
import { ui } from "@/ui";

import {
  deployConfigToEnv,
  loadDeployConfig,
  type DeployConfig,
  type DeployOverrides,
} from "../../../iac/src/deploy-config";

function optionalFlag(value: Option.Option<string>): string | undefined {
  return Option.getOrUndefined(value);
}

function stackDirectory(): string {
  const candidates = [
    process.env["OUTFITTING_IAC_DIR"],
    resolve(process.cwd(), "iac"),
    resolve(import.meta.dir, "../../../iac"),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const directory = candidates.find((candidate) =>
    existsSync(resolve(candidate, "alchemy.run.ts")),
  );
  if (!directory) {
    throw new Error(
      "The Alchemy stack is unavailable. Run from the manager repository root or set OUTFITTING_IAC_DIR to iac/.",
    );
  }
  return directory;
}

function stripTerminalColors(value: string): string {
  const escape = String.fromCharCode(27);
  return ["0", "1", "2", "22", "31", "32", "33", "36", "39", "90"].reduce(
    (current, code) => current.replaceAll(`${escape}[${code}m`, ""),
    value,
  );
}

async function runAlchemyDeploy(options: {
  deployConfig: DeployConfig;
  workerToken: string;
}): Promise<{ url: string }> {
  const directory = stackDirectory();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

  const child = Bun.spawn(["bun", "run", "alchemy", "deploy", "--yes", "--adopt"], {
    cwd: directory,
    env: {
      ...environment,
      ...deployConfigToEnv(options.deployConfig),
      OUTFITTING_LOCKFILES_TOKEN: options.workerToken,
    },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  const output = stripTerminalColors(`${stdout}\n${stderr}`);
  if (output.trim()) {
    console.info(output.trim());
  }
  if (exitCode !== 0) {
    throw new Error(`Alchemy deploy failed with exit code ${exitCode}.`);
  }

  const url =
    output.match(/\burl\s*[:=]\s*["']?(https?:\/\/[^\s"']+)/i)?.[1] ??
    output.match(/https?:\/\/[^\s"']+workers\.dev[^\s"']*/i)?.[0] ??
    (options.deployConfig.domain ? `https://${options.deployConfig.domain}` : undefined);

  if (!url) {
    throw new Error(
      "Alchemy deploy completed but did not report the Worker URL. Configure it with outfitting-manager sync configure-worker.",
    );
  }
  return { url };
}

function printProvisioned(apiBaseUrl: string, resolved: DeployConfig): void {
  console.info();
  console.info(pc.green(pc.bold("✓ Outfitting Manager API stack provisioned")));
  console.info(`${pc.dim("API")}       ${pc.cyan(apiBaseUrl)}`);
  console.info(`${pc.dim("Stack")}     ${resolved.stackName}`);
  console.info(`${pc.dim("Router")}    ${resolved.workers.router}`);
  console.info(`${pc.dim("API name")}  ${resolved.workers.api}`);
  if (resolved.domain) {
    console.info(`${pc.dim("Domain")}    ${resolved.domain}`);
  }
  if (resolved.configPath) {
    console.info(`${pc.dim("Config")}    ${resolved.configPath}`);
  }
  console.info(`${pc.dim("Token")}     ${pc.dim("stored in the OS keychain")}`);
  console.info();
}

export const provisionCommand = Command.make(
  "provision",
  {
    deployConfig: Flag.String("deploy-config").pipe(
      Flag.optional,
      Flag.withDescription(
        "Path to outfitting.deploy.json (see iac/outfitting.deploy.example.json).",
      ),
    ),
    domain: Flag.String("domain").pipe(
      Flag.optional,
      Flag.withDescription(
        "Hostname for the manager API router (empty string clears the default).",
      ),
    ),
    stackName: Flag.String("stack-name").pipe(
      Flag.optional,
      Flag.withDescription("Alchemy stack name (default OutfittingManager)."),
    ),
    apiName: Flag.String("api-name").pipe(
      Flag.optional,
      Flag.withDescription("Cloudflare worker name for the API (default outfitting-api)."),
    ),
    routerName: Flag.String("router-name").pipe(
      Flag.optional,
      Flag.withDescription(
        "Cloudflare worker name for the manager API router (default outfitting-manager-router).",
      ),
    ),
    databaseName: Flag.String("database-name").pipe(
      Flag.optional,
      Flag.withDescription("D1 database name (default outfitting-lockfiles)."),
    ),
    kvTitle: Flag.String("kv-title").pipe(
      Flag.optional,
      Flag.withDescription("KV namespace title (default outfitting-lockfiles)."),
    ),
    privateFonts: Flag.String("private-fonts").pipe(
      Flag.optional,
      Flag.withDescription("R2 bucket name for private fonts."),
    ),
    token: Flag.String("token").pipe(
      Flag.optional,
      Flag.withDescription(
        "OUTFITTING_LOCKFILES_TOKEN value. Defaults to env, else generates and stores one.",
      ),
    ),
    skipConfigure: Flag.Boolean("skip-configure").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Do not write lockfiles worker URL / token to the OS keychain."),
    ),
  },
  (flags) =>
    Effect.gen(function* () {
      const overrides: DeployOverrides = {
        stackName: optionalFlag(flags.stackName),
        databaseName: optionalFlag(flags.databaseName),
        kvTitle: optionalFlag(flags.kvTitle),
        privateFontsBucket: optionalFlag(flags.privateFonts),
        workers: {
          router: optionalFlag(flags.routerName),
          api: optionalFlag(flags.apiName),
        },
      };
      // Only set domain when the flag is present so omitted flags keep defaults.
      if (Option.isSome(flags.domain)) {
        overrides.domain = flags.domain.value.trim() || undefined;
      }

      const resolved = yield* Effect.try({
        try: () =>
          loadDeployConfig({
            configPath: optionalFlag(flags.deployConfig),
            overrides,
          }),
        catch: (cause) => toCliFailure(cause, "Invalid provision configuration."),
      });

      const workerToken =
        optionalFlag(flags.token)?.trim() ||
        process.env["OUTFITTING_LOCKFILES_TOKEN"]?.trim() ||
        randomBytes(32).toString("hex");

      const deployment = yield* Effect.tryPromise({
        try: () =>
          runAlchemyDeploy({
            deployConfig: resolved,
            workerToken,
          }),
        catch: (cause) => toCliFailure(cause, "Could not deploy the manager API stack."),
      });

      const routerUrl = deployment.url.replace(/\/$/, "");
      const apiBaseUrl = `${routerUrl}/api`;

      if (!flags.skipConfigure) {
        yield* Effect.tryPromise({
          try: async () => {
            await storeWorkerUrl(apiBaseUrl);
            await Bun.secrets.set({
              service: "outfitting-lockfiles",
              name: "api-token",
              value: workerToken,
            });
          },
          catch: (cause) =>
            toCliFailure(
              cause,
              `Stack deployed, but credentials could not be stored in the OS keychain: ${
                cause instanceof Error ? cause.message : String(cause)
              }. Set them with sync configure-worker / configure-token.`,
            ),
        });
      }

      yield* Effect.sync(() => printProvisioned(apiBaseUrl, resolved));
      yield* Console.log(ui.muted("Next: outfitting-manager sync list"));
    }),
).pipe(Command.withDescription("Deploy the Outfitting Manager API Alchemy stack."));
