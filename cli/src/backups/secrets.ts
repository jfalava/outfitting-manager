import { Context, Effect, Layer, Redacted } from "effect";

import { BackupError, type SecretName, type BackupCredentials } from "./model.ts";

export class Secrets extends Context.Service<
  Secrets,
  {
    get(name: SecretName): Effect.Effect<Redacted.Redacted<string>, BackupError>;
    set(name: SecretName, value: Redacted.Redacted<string>): Effect.Effect<void, BackupError>;
  }
>()("backup/Secrets") {
  static layer(
    account: string,
    identities: BackupCredentials,
    platform: NodeJS.Platform = "darwin",
  ) {
    const store = platform === "win32" ? "Credential Manager" : "Keychain";
    return Layer.succeed(
      Secrets,
      Secrets.of({
        get: Effect.fn("Secrets.get")(function* (name) {
          const value = yield* Effect.tryPromise({
            try: () => Bun.secrets.get({ service: identities[name], name: account }),
            catch: () =>
              new BackupError({
                message: `${store} access failed for ${name}. Verify access as the scheduled user.`,
              }),
          }).pipe(
            Effect.timeout("20 seconds"),
            Effect.mapError(
              () =>
                new BackupError({ message: `${store} access failed or timed out for ${name}.` }),
            ),
          );
          if (value === null || value.length === 0) {
            return yield* new BackupError({
              message: `Missing ${store} credential ${name}. Run backup secrets set ${name}.`,
            });
          }
          return Redacted.make(value);
        }),
        set: Effect.fn("Secrets.set")(function* (name, value) {
          if (Redacted.value(value).length === 0) {
            return yield* new BackupError({ message: "Secret must not be empty." });
          }
          yield* Effect.tryPromise({
            try: () =>
              Bun.secrets.set({
                service: identities[name],
                name: account,
                value: Redacted.value(value),
              }),
            catch: () =>
              new BackupError({ message: `Could not store ${store} credential ${name}.` }),
          });
        }),
      }),
    );
  }
}
