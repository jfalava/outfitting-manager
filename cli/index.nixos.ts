#!/usr/bin/env bun

/** NixOS entrypoint: refuses to run unless this is NixOS with nix-ld and its libraries. */
import { BunRuntime } from "@effect/platform-bun";

import { makeNixosRootCommand } from "@/cli/nixos";
import { runCli } from "@/cli/run";
import { declareHostPlatform } from "@/platform";
import { hostGuardFailure } from "@/platform/guard";
import { ui } from "@/ui";

import packageJson from "./package.json" with { type: "json" };

declareHostPlatform("nixos");
const args = Bun.argv.slice(2);
const refusal = hostGuardFailure("nixos", args);
if (refusal !== undefined) {
  console.error(ui.error(refusal));
  process.exit(1);
}

const root = makeNixosRootCommand(packageJson.version);
const program = runCli(root, packageJson.version, args);

BunRuntime.runMain(program, { disableErrorReporting: true });
