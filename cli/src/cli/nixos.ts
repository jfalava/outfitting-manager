import { Command } from "effect/cli";

import { makeBackupsCommand } from "@/commands/backups";
import { configCommand } from "@/commands/config";
import { makeDebugCommand } from "@/commands/debug";
import { makeNixCommand } from "@/commands/nix";
import { provisionCommand } from "@/commands/provision";
import { recoverCommand } from "@/commands/recover";
import { makeSelfUpdateCommand } from "@/commands/self-update";
import { nixosInitCommand } from "@/commands/setup/nixos";
import { sourceCommand } from "@/commands/source";
import { makeStatusCommand } from "@/commands/status";
import { syncCommand } from "@/commands/sync";
import { validateCommand } from "@/commands/validate";

/**
 * NixOS root command surface. The system flake owns packages and fonts, so apply,
 * update, diff, and fonts are left out; `nix switch` activates only this host.
 */
export const makeNixosRootCommand = (currentVersion: string) =>
  Command.make("outfitting-manager").pipe(
    Command.withDescription(
      "Portable maintenance tools for Outfitting-managed machines. Use --config <path> to select a config.toml file.",
    ),
    Command.withSubcommands([
      nixosInitCommand,
      configCommand,
      makeBackupsCommand(),
      sourceCommand,
      validateCommand,
      makeNixCommand("nixos"),
      recoverCommand,
      syncCommand,
      makeStatusCommand("nixos"),
      provisionCommand,
      makeSelfUpdateCommand(currentVersion),
      makeDebugCommand("nixos"),
    ]),
  );
