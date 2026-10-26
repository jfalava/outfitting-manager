import { stat } from "node:fs/promises";

import { Console, Effect } from "effect";
import { Command } from "effect/cli";

import {
  autoMachineId,
  configuredProfile,
  loadConfig,
  sparseSourceRoot,
  type ManagerConfig,
} from "@/config";
import { tryPromise } from "@/effect";
import { type HostPlatform } from "@/platform";
import { runCommand } from "@/process";
import { envValue } from "@/secrets";
import { syncByorSparseSource } from "@/setup/source";
import {
  selectByorProfile,
  selectMacosByorProfile,
  selectWindowsByorProfiles,
  type ByorContract,
} from "@/source/contract";

async function sourcePathStatus(source: string): Promise<string | undefined> {
  try {
    if (!(await stat(source)).isDirectory()) {
      return "not a directory";
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return "missing";
    }
    throw cause;
  }
  try {
    await stat(`${source}/.git`);
    return undefined;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return "local source (no Git metadata)";
    }
    throw cause;
  }
}

async function sourceStatus(
  source: string | undefined,
  run: typeof runCommand,
  remote = false,
): Promise<string[]> {
  if (source === undefined) {
    return ["Source checkout: not configured"];
  }
  const lines = [`Source: ${source}`];
  const pathStatus = await sourcePathStatus(source);
  if (remote && pathStatus === "local source (no Git metadata)") {
    return [...lines, "Source checkout: cached snapshot (no Git metadata)"];
  }
  if (pathStatus !== undefined) {
    return [...lines, `Source checkout: ${pathStatus}`];
  }
  if (remote) {
    return [...lines, "Source checkout: cached snapshot (unexpected Git metadata)"];
  }
  const result = await run(
    "git",
    ["--no-optional-locks", "-C", source, "status", "--porcelain=v1", "--branch"],
    { inherit: false },
  );
  if (result.code !== 0) {
    return [...lines, "Source checkout: Git status unavailable"];
  }
  const [branch, ...changes] = result.stdout.trimEnd().split("\n");
  return [
    ...lines,
    `Source checkout: ${changes.length > 0 ? "dirty" : "clean"}`,
    `Git: ${branch?.replace(/^## /, "") ?? "unknown"}`,
  ];
}

function selectedProfile(
  contract: ByorContract,
  platform: HostPlatform,
  config: ManagerConfig,
): string {
  const configured = configuredProfile(config, platform);
  switch (platform) {
    case "linux":
      return selectByorProfile(contract, configured).name;
    case "macos":
      return selectMacosByorProfile(contract, configured).name;
    case "windows":
      return selectWindowsByorProfiles(contract, configured?.split(",")).names.join(",");
  }
}

function readSelectedProfile(platform: HostPlatform, config: ManagerConfig): string {
  try {
    return config.declarations === undefined
      ? "not selected"
      : selectedProfile(config.declarations, platform, config);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return `invalid (${reason})`;
  }
}

function statusSource(config: ManagerConfig, override: string | undefined): string | undefined {
  if (override !== undefined) {
    return override;
  }
  if (config.source?.kind === "local") {
    return config.source.path;
  }
  if (config.source?.kind === "remote") {
    return sparseSourceRoot(config.stateRoot);
  }
  return undefined;
}

export function formatStatusConfiguration(
  platform: HostPlatform,
  config: ManagerConfig,
  observed: { architecture: string; profile: string; inferredMachineId: string },
): string[] {
  const lines = [
    `Platform: ${platform} (${observed.architecture})`,
    `Profile: ${observed.profile}`,
    `Config: ${config.configPath}`,
    `Machine ID: ${config.machineId} (${config.machineIdOverridden ? "configured" : "inferred"})`,
    `Inferred machine ID: ${observed.inferredMachineId}`,
  ];
  if (config.source?.kind === "remote") {
    lines.push(
      "Source mode: remote",
      `Repository: ${config.source.repository}@${config.source.ref}`,
      `Cache: ${sparseSourceRoot(config.stateRoot)}`,
    );
  } else if (config.source?.kind === "local") {
    lines.push("Source mode: local");
  } else {
    lines.push("Source mode: not configured");
  }
  return lines;
}

async function cacheFreshnessLines(
  config: ManagerConfig,
  platform: HostPlatform,
  override: string | undefined,
): Promise<string[]> {
  if (override !== undefined || config.source?.kind !== "remote") {
    return [];
  }
  try {
    await syncByorSparseSource({
      config,
      platform,
      profile: configuredProfile(config, platform),
      offline: true,
    });
    return ["Cache validation: current"];
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return [`Cache validation: stale or missing (${reason})`];
  }
}

/** Inspect paths and Git without initializing state, fetching, or reading credentials. */
export async function readStatus(
  platform: HostPlatform,
  options: { config?: ManagerConfig; run?: typeof runCommand; envRepo?: string } = {},
): Promise<string> {
  const config = options.config ?? (await loadConfig());
  const override = options.envRepo ?? envValue("OUTFITTING_REPO");
  return [
    ...formatStatusConfiguration(platform, config, {
      architecture: process.arch,
      profile: readSelectedProfile(platform, config),
      inferredMachineId: autoMachineId(),
    }),
    ...(await cacheFreshnessLines(config, platform, override)),
    ...(await sourceStatus(
      statusSource(config, override),
      options.run ?? runCommand,
      override === undefined && config.source?.kind === "remote",
    )),
  ].join("\n");
}

export const makeStatusCommand = (platform: HostPlatform) =>
  Command.make("status", {}, () =>
    tryPromise(() => readStatus(platform)).pipe(Effect.flatMap(Console.log)),
  ).pipe(
    Command.withDescription("Inspect platform, profile, paths, machine ID, and source state."),
  );
