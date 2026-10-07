import { Option } from "effect";
import { Argument, Command } from "effect/cli";

import { configureToken, configureWorker } from "@/sync";

const configureWorkerCommand = Command.make(
  "worker",
  {
    url: Argument.String("url").pipe(
      Argument.optional,
      Argument.withDescription("HTTP(S) URL of the deployed sync Worker."),
    ),
  },
  ({ url }) => configureWorker(Option.getOrUndefined(url)),
).pipe(Command.withDescription("Store the sync Worker URL in the OS keychain."));

const configureTokenCommand = Command.make("token", {}, () => configureToken).pipe(
  Command.withDescription("Prompt for and store the sync API token in the OS keychain."),
);

export const configureCommand = Command.make("configure").pipe(
  Command.withDescription("Configure the sync Worker URL or API token."),
  Command.withSubcommands([configureWorkerCommand, configureTokenCommand]),
);
