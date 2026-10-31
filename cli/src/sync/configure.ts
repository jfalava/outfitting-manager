import { Console, Effect } from "effect";

import { tryPromise } from "@/effect";
import { promptCredential } from "@/secrets";
import { promptAndStoreApiToken, storeWorkerUrl } from "@/sync/keychain";
import { ui } from "@/ui";

export const configureWorker = (requestedUrl?: string) =>
  Effect.gen(function* () {
    const value =
      requestedUrl ??
      (yield* promptCredential(
        "Sync Worker URL (stored in your OS keychain)",
        false,
        "A Worker URL is required.",
      ));

    const url = yield* tryPromise(() => storeWorkerUrl(value));
    yield* Console.log(ui.success(`Stored Worker URL: ${ui.key(url)}`));
    return undefined;
  });

export const configureToken = Effect.gen(function* () {
  yield* promptAndStoreApiToken;
  yield* Console.log(ui.success("Stored API token in your OS keychain."));
});
