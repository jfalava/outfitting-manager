#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";

import { makeMacosRootCommand } from "@/cli";
import { runCli } from "@/cli/run";

import packageJson from "./package.json" with { type: "json" };

const root = makeMacosRootCommand(packageJson.version);
const program = runCli(root, packageJson.version, Bun.argv.slice(2));

BunRuntime.runMain(program, { disableErrorReporting: true });
