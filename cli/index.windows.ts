#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";

import { runCli } from "@/cli/run";
import { makeWindowsRootCommand } from "@/cli/windows";

import packageJson from "./package.json" with { type: "json" };

const root = makeWindowsRootCommand(packageJson.version);
const program = runCli(root, packageJson.version, Bun.argv.slice(2));

BunRuntime.runMain(program, { disableErrorReporting: true });
