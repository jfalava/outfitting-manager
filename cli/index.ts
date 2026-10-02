#!/usr/bin/env bun

/** Generic Linux entrypoint. Darwin and Windows compile their platform-specific files. */
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { CliError, Command } from "effect/cli";

import { normalizeCommandAlias } from "@/arguments";
import { makeCommandHelpLayer } from "@/cli/help";
import { makeLinuxRootCommand } from "@/cli/linux";
import { emitTerminalAlert } from "@/terminal-alert";
import { ui } from "@/ui";

import packageJson from "./package.json" with { type: "json" };

const root = makeLinuxRootCommand(packageJson.version);
const program = Effect.sync(() => normalizeCommandAlias(Bun.argv.slice(2))).pipe(
  Effect.flatMap((args) =>
    Command.runWith(root, {
      version: packageJson.version,
    })(args.length === 0 ? ["--help"] : args),
  ),
  Effect.provide([makeCommandHelpLayer(root), BunServices.layer]),
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
