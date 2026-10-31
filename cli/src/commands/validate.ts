import { Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import { configuredProfile, loadConfig, sparseSourceRoot } from "@/config";
import { tryPromise } from "@/effect";
import { platformLabel, type HostPlatform } from "@/platform";
import { envValue } from "@/secrets";
import { syncByorSparseSource } from "@/setup/source";
import {
  profileNames,
  selectByorProfile,
  selectMacosByorProfile,
  selectWindowsByorProfiles,
  validateByorSource,
  type ByorContract,
} from "@/source/contract";
import { ui } from "@/ui";

function resolveValidatePlatform(
  contract: ByorContract,
  platformFlag: string | undefined,
): HostPlatform {
  if (platformFlag === "linux" || platformFlag === "windows" || platformFlag === "macos") {
    if (profileNames(contract, platformFlag).length === 0) {
      throw new Error(`config.toml does not declare any ${platformLabel(platformFlag)} profiles.`);
    }
    return platformFlag;
  }
  if (platformFlag !== undefined) {
    throw new Error(`--platform must be linux, windows, or macos (got \`${platformFlag}\`).`);
  }

  const declared = (["linux", "windows", "macos"] as const).filter(
    (platform) => profileNames(contract, platform).length > 0,
  );
  if (declared.length > 1) {
    throw new Error(
      `config.toml declares multiple platforms (${declared.join(", ")}). Pass --platform ${declared.join("|")}.`,
    );
  }
  if (declared.length === 1) {
    return declared[0]!;
  }
  throw new Error("config.toml does not declare any Linux, Windows, or macOS profiles.");
}

/** Summary lines for the declarations that were just validated. */
function validatedDetails(
  contract: ByorContract,
  platform: HostPlatform,
  profile: string | undefined,
): string[] {
  switch (platform) {
    case "linux": {
      const { name, linux } = selectByorProfile(contract, profile);
      const backends = (["apt", "pacman", "nix"] as const).filter(
        (backend) => linux[backend] !== undefined,
      );
      return [`profile: ${name}`, `backends: ${backends.join(", ")}`];
    }
    case "macos": {
      const { name, macos } = selectMacosByorProfile(contract, profile);
      return [`profile: ${name}`, `flake: ${macos.nix.flake}`, `attribute: ${macos.nix.attribute}`];
    }
    case "windows": {
      const { names, wingetPaths } = selectWindowsByorProfiles(contract, profile?.split(","));
      return [
        `profiles: ${names.join(", ")}`,
        `winget: ${names.map((name) => `${name}=${wingetPaths[name]}`).join(", ")}`,
      ];
    }
  }
}

async function validateConfiguredSource(options: {
  repo: string | undefined;
  profile: string | undefined;
  platform: string | undefined;
}): Promise<string[]> {
  const config = await loadConfig();
  const contract = config.declarations;
  if (contract === undefined) {
    throw new Error(`No profile declarations are configured in ${config.configPath}.`);
  }
  const target = resolveValidatePlatform(contract, options.platform?.toLowerCase());
  const selectedProfile = configuredProfile(config, target, options.profile);
  const localPath =
    options.repo ??
    envValue("OUTFITTING_REPO") ??
    (config.source?.kind === "local" ? config.source.path : undefined);
  if (localPath === undefined && config.source?.kind !== "remote") {
    throw new Error(`No source is configured in ${config.configPath}.`);
  }
  if (localPath === undefined) {
    await syncByorSparseSource({
      config,
      platform: target,
      profile: selectedProfile,
      offline: true,
    });
  }
  const root = localPath ?? sparseSourceRoot(config.stateRoot);
  await validateByorSource(root, target, selectedProfile, contract);
  return [
    ui.success(`BYOR contract valid: ${root}`),
    `platform: ${target}`,
    ...validatedDetails(contract, target, selectedProfile),
  ];
}

/** Validate the configured TOML declarations and selected source without applying them. */
export const validateCommand = Command.make(
  "validate",
  {
    repo: Flag.String("repo").pipe(
      Flag.optional,
      Flag.withDescription("Local source path override (defaults to config.toml)."),
    ),
    profile: Flag.String("profile").pipe(
      Flag.optional,
      Flag.withDescription(
        "Profile to validate; comma-separated for Windows. Required when several exclusive profiles exist.",
      ),
    ),
    platform: Flag.String("platform").pipe(
      Flag.optional,
      Flag.withDescription(
        "Platform to validate when the contract declares more than one (linux|windows|macos).",
      ),
    ),
  },
  ({ repo, profile, platform }) =>
    Effect.gen(function* () {
      const lines = yield* tryPromise(() =>
        validateConfiguredSource({
          repo: Option.getOrUndefined(repo),
          profile: Option.getOrUndefined(profile),
          platform: Option.getOrUndefined(platform),
        }),
      );
      for (const line of lines) {
        yield* Console.log(line);
      }
    }),
).pipe(
  Command.withDescription(
    "Validate config.toml declarations and the selected source without changing the system.",
  ),
);
