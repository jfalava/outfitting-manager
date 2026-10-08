#!/usr/bin/env bun

/** Generic Linux entrypoint. Darwin and Windows compile their platform-specific files. */
import { BunRuntime } from "@effect/platform-bun";

import { makeLinuxRootCommand } from "@/cli/linux";
import { runCli } from "@/cli/run";

import packageJson from "./package.json" with { type: "json" };

const root = makeLinuxRootCommand(packageJson.version);
const program = runCli(root, packageJson.version, Bun.argv.slice(2));

BunRuntime.runMain(program, { disableErrorReporting: true });
