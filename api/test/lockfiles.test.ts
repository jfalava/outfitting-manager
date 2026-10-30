import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";

import { decodeResponse, ErrorBody, isJsonValue, StalePushBody } from "@outfitting/contract";
import { describe, expect, test } from "vitest";

import { app, lockfileKey, parseIfMatch, sha256 } from "@/index";

/** D1 and KV stand-ins over in-memory SQLite and a Map, covering what the routes call. */
function storageEnv(): Env {
  const db = new DatabaseSync(":memory:");
  for (const name of ["0001_create_lockfiles.sql", "0002_add_lockfile_heads.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    sql,
    params,
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
  });
  const blobs = new Map<string, ArrayBuffer>();
  const partialEnv = {
    OUTFITTING_SYNC_TOKEN: { get: async () => "token" },
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: ReturnType<typeof statement>[]) => {
        db.exec("BEGIN");
        const results = statements.map(({ sql, params }) => ({
          meta: { changes: Number(db.prepare(sql).run(...params).changes) },
        }));
        db.exec("COMMIT");
        return results;
      },
    },
    LOCKFILES: {
      put: async (key: string, value: ArrayBuffer) => void blobs.set(key, value),
      get: async (key: string) => blobs.get(key) ?? null,
    },
  };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the stand-ins implement only the binding methods the routes call.
  return partialEnv as unknown as Env;
}

async function jsonBody(response: Response) {
  const raw: unknown = await response.json();
  expect(isJsonValue(raw)).toBe(true);
  if (!isJsonValue(raw)) {
    throw new Error("expected JSON body");
  }
  return raw;
}

describe("lockfile helpers", () => {
  test("builds the specified content-addressed KV key", () => {
    expect(lockfileKey("jfalava:x64-wsl", "nix", "abc123")).toBe(
      "lockfile:jfalava:x64-wsl:nix:abc123",
    );
  });

  test("hashes raw bytes with SHA-256", async () => {
    const content = await new Blob(["hello"]).arrayBuffer();
    expect(await sha256(content)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  test("parses a quoted SHA-256 If-Match precondition", () => {
    const hash = "a".repeat(64);
    expect(parseIfMatch(`"${hash}"`)).toBe(hash);
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(() => parseIfMatch(hash)).toThrow("quoted lowercase SHA-256");
    expect(() => parseIfMatch('"ABC"')).toThrow("quoted lowercase SHA-256");
  });
});

describe("lockfile promotion", () => {
  test("a stale push leaves no version behind", async () => {
    const env = storageEnv();
    const url = "http://worker.test/lockfiles/machine/nix";
    const push = (body: string, headers: Record<string, string> = {}) =>
      app.request(
        url,
        { method: "PUT", body, headers: { Authorization: "Bearer token", ...headers } },
        env,
      );

    expect((await push("first\n")).status).toBe(200);
    const stale = await push("second\n", { "If-Match": `"${"0".repeat(64)}"` });
    expect(stale.status).toBe(412);
    const firstHash = await sha256(await new Blob(["first\n"]).arrayBuffer());
    expect(decodeResponse(StalePushBody, await jsonBody(stale), "stale")).toMatchObject({
      current_hash: firstHash,
    });

    const secondHash = await sha256(await new Blob(["second\n"]).arrayBuffer());
    const removal = await app.request(
      `${url}/${secondHash}`,
      { method: "DELETE", headers: { Authorization: "Bearer token" } },
      env,
    );
    expect(removal.status).toBe(404);
  });
});

describe("authentication", () => {
  const partialEnv = {
    OUTFITTING_SYNC_TOKEN: {
      get: async () => "correct-token",
    },
  } satisfies Pick<Env, "OUTFITTING_SYNC_TOKEN">;
  const env = partialEnv as Env;

  test("rejects a missing bearer token", async () => {
    const response = await app.request("http://worker.test/lockfiles/jfalava%3Ax64-wsl", {}, env);
    expect(response.status).toBe(401);
    expect(decodeResponse(ErrorBody, await jsonBody(response), "auth")).toEqual({
      error: "Unauthorized",
    });
  });

  test("rejects a wrong bearer token", async () => {
    const response = await app.request(
      "http://worker.test/lockfiles/jfalava%3Ax64-wsl",
      { headers: { Authorization: "Bearer wrong-token" } },
      env,
    );
    expect(response.status).toBe(401);
    expect(decodeResponse(ErrorBody, await jsonBody(response), "auth")).toEqual({
      error: "Unauthorized",
    });
  });

  test("accepts the configured bearer token", async () => {
    const response = await app.request(
      "http://worker.test/not-found",
      { headers: { Authorization: "Bearer correct-token" } },
      env,
    );
    expect(response.status).toBe(404);
    expect(decodeResponse(ErrorBody, await jsonBody(response), "not-found")).toEqual({
      error: "Not found",
    });
  });
});
