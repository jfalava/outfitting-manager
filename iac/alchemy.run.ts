import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

import {
  apiName,
  databaseName,
  deployConfig,
  deployDomain,
  kvTitle,
  privateFontsBucket,
  routerName,
  stackName,
} from "./src/config";
import { defineManagedSecrets } from "./src/secrets";

/** Existing account Secrets Store (provider always adopts; never deleted). */
export const SharedSecretsStore = Cloudflare.SecretsStore.Store("OutfittingManagerSecretsStore");

const API_SECRET_NAMES = ["OUTFITTING_LOCKFILES_TOKEN"] as const;

const debugObservability = {
  enabled: true,
  headSamplingRate: 1,
  logs: {
    enabled: true,
    invocationLogs: true,
    headSamplingRate: 1,
    persist: true,
  },
  traces: {
    enabled: true,
    headSamplingRate: 1,
    persist: true,
  },
} as const;

const compatibility = {
  date: "2026-08-20",
  flags: ["nodejs_compat" as const],
};

/** Existing lockfiles KV namespace (title match; deploy with --adopt). */
export const OutfittingApiKv = Cloudflare.KV.Namespace("OutfittingManagerApiKv", {
  title: kvTitle,
});

/** Existing D1 database + migrations from the api package. */
export const OutfittingApiDb = Cloudflare.D1.Database("OutfittingManagerApiDb", {
  name: databaseName,
  migrations: "../api/migrations",
});

/** Existing private fonts R2 bucket. */
export const OutfittingPrivateFonts = Cloudflare.R2.Bucket("OutfittingManagerPrivateFonts", {
  name: privateFontsBucket,
});

export const OutfittingApi = Cloudflare.Worker("OutfittingManagerApi", {
  name: apiName,
  main: "../api/src/index.ts",
  workersDev: false,
  observability: debugObservability,
  compatibility,
  env: {
    LOCKFILES: OutfittingApiKv,
    DB: OutfittingApiDb,
  },
});

export default Alchemy.Stack(
  stackName,
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const sharedSecretsStore = yield* SharedSecretsStore;
    yield* OutfittingPrivateFonts;
    const api = yield* OutfittingApi;

    yield* defineManagedSecrets(sharedSecretsStore, API_SECRET_NAMES);
    yield* api.bind("ApiSecretsStoreBindings", {
      bindings: API_SECRET_NAMES.map((secretName) => ({
        type: "secrets_store_secret" as const,
        name: secretName,
        secretName,
        storeId: sharedSecretsStore.storeId,
      })),
    });

    const routerBase = {
      name: routerName,
      main: "../router/src/index.ts",
      workersDev: deployDomain === undefined,
      observability: debugObservability,
      compatibility,
      env: { API: api },
    };
    const routerProps =
      deployDomain === undefined ? routerBase : { ...routerBase, domain: { name: deployDomain } };
    const router = yield* Cloudflare.Worker("OutfittingManagerRouter", routerProps);

    return {
      url: router.url,
      routerUrl: router.url,
      apiUrl: Output.interpolate`${router.url}/api`,
      domain: deployDomain ?? null,
      workers: deployConfig.workers,
    };
  }),
);
