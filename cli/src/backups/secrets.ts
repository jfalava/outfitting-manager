import { Context, Effect, Layer, Redacted, Schema } from "effect";

import { BackupError, secretNames, type SecretName, type BackupCredentials } from "./model.ts";
import { Processes, parseJson } from "./process.ts";
import { Settings } from "./settings.ts";

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

// Explicit migration only. SecretStore is not a runtime dependency, and values never reach the console.
export const importSecretStore = Effect.fn("importSecretStore")(function* (vault: string) {
  if (process.platform !== "win32") {
    return yield* new BackupError({ message: "SecretStore import is Windows-only." });
  }
  const settings = yield* Settings;
  const processes = yield* Processes;
  const secrets = yield* Secrets;
  const names = secretNames.filter(
    (name) => name !== "alert-token" || settings.alert.protocol !== "disabled",
  );
  // Pass arbitrary native identities as data, never PowerShell source, including smart quotes.
  const request = Buffer.from(
    JSON.stringify({
      vault,
      credentials: names.map((name) => ({ name, service: settings.credentials[name] })),
    }),
  ).toString("base64");
  const script = `$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${request}')) | ConvertFrom-Json; $values = @{}; foreach ($credential in $request.credentials) { $value = Get-Secret -Vault $request.vault -Name $credential.service -AsPlainText -ErrorAction Stop; if ($null -ne $value) { $values[$credential.name] = $value } }; $values | ConvertTo-Json -Compress`;
  const output = yield* processes
    .run("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", script])
    .pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError(
        () =>
          new BackupError({
            message:
              "SecretStore import failed or timed out; unlock the named vault interactively.",
          }),
      ),
    );
  if (output.exitCode !== 0) {
    return yield* new BackupError({
      message: "SecretStore import failed; verify the vault and required credentials.",
    });
  }
  const values = yield* parseJson(
    Schema.Struct({
      "access-key": Schema.NonEmptyString,
      "secret-key": Schema.NonEmptyString,
      "repository-password": Schema.NonEmptyString,
      "alert-token": Schema.optionalKey(Schema.NonEmptyString),
    }),
  )(output.stdout).pipe(
    Effect.mapError(
      () => new BackupError({ message: "SecretStore returned missing or invalid credentials." }),
    ),
  );
  if (settings.alert.protocol !== "disabled" && values["alert-token"] === undefined) {
    return yield* new BackupError({ message: "SecretStore returned missing alert-token." });
  }
  for (const name of names) {
    const existing = yield* Effect.tryPromise({
      try: () => Bun.secrets.get({ service: settings.credentials[name], name: settings.account }),
      catch: () =>
        new BackupError({ message: "Could not inspect Credential Manager before import." }),
    });
    if (existing !== null && existing !== values[name]) {
      return yield* new BackupError({
        message: `Credential ${name} already exists with a different value; nothing was imported.`,
      });
    }
  }
  for (const name of names) {
    yield* secrets.set(name, Redacted.make(values[name]!));
    if (Redacted.value(yield* secrets.get(name)) !== values[name]) {
      return yield* new BackupError({ message: `Credential ${name} failed import verification.` });
    }
  }
  return names;
});
