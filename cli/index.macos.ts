#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { CliError, Command } from "effect/cli";

import { normalizeCommandAlias } from "@/arguments";
import { makeMacosRootCommand } from "@/cli";
import { emitTerminalAlert } from "@/terminal-alert";
import { ui } from "@/ui";

import packageJson from "./package.json" with { type: "json" };

const program = Effect.sync(() => normalizeCommandAlias(Bun.argv.slice(2))).pipe(
  Effect.flatMap((args) =>
    Command.runWith(makeMacosRootCommand(packageJson.version), {
      version: packageJson.version,
    })(args.length === 0 ? ["--help"] : args),
  ),
  Effect.provide(BunServices.layer),
  Effect.catch((error) =>
    Effect.sync(() => {
      process.exitCode = 1;
      if (!CliError.isCliError(error)) {
        emitTerminalAlert("error");
        const message = error instanceof Error ? error.message : String(error);
        console.error(ui.error(message));
      }
    }),
  ),
  Effect.catchDefect((defect) =>
    Effect.sync(() => {
      process.exitCode = 1;
      emitTerminalAlert("error");
      const message = defect instanceof Error ? defect.message : String(defect);
      console.error(ui.error(message));
    }),
  ),
);

BunRuntime.runMain(program, { disableErrorReporting: true });
