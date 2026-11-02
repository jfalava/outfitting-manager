#!/usr/bin/env bun

/** Generic Linux entrypoint. Darwin, Windows, and NixOS compile their platform-specific files. */
import { BunRuntime } from "@effect/platform-bun";

import { makeLinuxRootCommand } from "@/cli/linux";
import { runCli } from "@/cli/run";
import { hostGuardFailure } from "@/platform/guard";
import { ui } from "@/ui";

import packageJson from "./package.json" with { type: "json" };

const args = Bun.argv.slice(2);
const refusal = hostGuardFailure("linux", args);
if (refusal !== undefined) {
  console.error(ui.error(refusal));
  process.exit(1);
}

const root = makeLinuxRootCommand(packageJson.version);
const program = runCli(root, packageJson.version, args);

BunRuntime.runMain(program, { disableErrorReporting: true });
