import { BunServices } from "@effect/platform-bun";
import { Effect, Redacted } from "effect";
import { Prompt } from "effect/cli";

import { CliFailure } from "@/errors";
import { withTerminalInput } from "@/terminal-alert";

export function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export function inAmpOrb(): boolean {
  return envValue("AMP_ORB") === "1";
}

export async function storedSecret(service: string, name: string): Promise<string | null> {
  try {
    return await Bun.secrets.get({
      service,
      name,
    });
  } catch (cause) {
    if (isUnavailableSecretsStore(cause)) {
      return null;
    }
    throw cause;
  }
}

function isUnavailableSecretsStore(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) {
    return false;
  }
  return cause.code === "ERR_SECRETS_PLATFORM_ERROR";
}

/** Prompt for a keychain value. Secret input is masked; a blank answer fails with `missing`. */
export function promptCredential(message: string, secret: boolean, missing: string) {
  return Effect.gen(function* () {
    if (!process.stdin.isTTY) {
      return yield* new CliFailure({
        message: `${missing} Entering it requires an interactive terminal.`,
      });
    }
    const answer = secret
      ? Redacted.value(
          yield* withTerminalInput(Prompt.Password({ message }), "auth", "Credential required"),
        )
      : yield* withTerminalInput(Prompt.String({ message }), "question", message);
    const value = answer.trim();
    if (value.length === 0) {
      return yield* new CliFailure({ message: missing });
    }
    return value;
  }).pipe(Effect.provide(BunServices.layer));
}
