/** Bindings for the Outfitting API worker (lockfile storage). */
interface Env {
  LOCKFILES: KVNamespace;
  DB: D1Database;
  OUTFITTING_SYNC_TOKEN: SecretsStoreSecret;
}
