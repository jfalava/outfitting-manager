import { Console, Effect } from "effect";

import { tryPromise } from "@/effect";
import {
  promptAndStoreR2Credentials,
  R2_ENDPOINT_MISSING,
  R2_ENDPOINT_PROMPT,
  storeR2Endpoint,
} from "@/fonts/keychain";
import { promptCredential } from "@/secrets";
import { ui } from "@/ui";

export const configureEndpoint = (requestedEndpoint?: string) =>
  Effect.gen(function* () {
    const value =
      requestedEndpoint ??
      (yield* promptCredential(R2_ENDPOINT_PROMPT, false, R2_ENDPOINT_MISSING));

    const endpoint = yield* tryPromise(() => storeR2Endpoint(value));
    yield* Console.log(ui.success(`Stored R2 endpoint: ${ui.key(endpoint)}`));
    return undefined;
  });

export const configureCredentials = Effect.gen(function* () {
  yield* promptAndStoreR2Credentials;
  yield* Console.log(ui.success("Stored R2 credentials in your OS keychain."));
});
