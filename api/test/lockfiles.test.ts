import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { URL } from "node:url";

import { describe, expect, test } from "vitest";

import { app } from "@/index";

const migrations = new URL("../migrations/", import.meta.url);

/** D1 and KV stand-ins over in-memory SQLite and a Map, covering the binding methods the Worker calls. */
function storage() {
  const db = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrations)
    .filter((file) => file.endsWith(".sql"))
    .toSorted()) {
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  const statement = (sql: string, params: SQLInputValue[] = []) => ({
    bind: (...values: SQLInputValue[]) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    run: () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  const blobs = new Map<string, ArrayBuffer>();
  const partialEnv = {
    OUTFITTING_SYNC_TOKEN: { get: async () => "token" },
    DB: {
      prepare: (sql: string) => statement(sql),
      // D1 batches run as one transaction.
      batch: async (statements: ReturnType<typeof statement>[]) => {
        db.exec("BEGIN");
        try {
          const results = statements.map((entry) => entry.run());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    LOCKFILES: {
      put: async (key: string, value: ArrayBuffer) => void blobs.set(key, value),
      get: async (key: string) => blobs.get(key) ?? null,
    },
  };
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the stand-ins implement only the binding methods the Worker calls.
  return { env: partialEnv as unknown as Env, blobs };
}

const hashOf = (body: string) => createHash("sha256").update(body).digest("hex");
const url = "http://worker.test/lockfiles/machine/nix";
const auth = { Authorization: "Bearer token" };

function client() {
  const { env, blobs } = storage();
  return {
    blobs,
    push: (body: string, ifMatch?: string) => {
      const headers = new Headers(auth);
      if (ifMatch !== undefined) {
        headers.set("If-Match", ifMatch);
      }
      return app.request(url, { method: "PUT", body, headers }, env);
    },
    pull: (path = url) => app.request(path, { headers: auth }, env),
    history: async () => {
      const response = await app.request(`${url}/history`, { headers: auth }, env);
      const entries: Array<{ hash: string }> = await response.json();
      return entries.map((entry) => entry.hash);
    },
    remove: (hash: string) =>
      app.request(`${url}/${hash}`, { method: "DELETE", headers: auth }, env),
  };
}

describe("PUT /lockfiles/:machine/:kind", () => {
  test.each([
    hashOf("first\n"),
    `"${hashOf("first\n").toUpperCase()}"`,
    `"${hashOf("first\n")}", "${hashOf("second\n")}"`,
    "*",
  ])("rejects If-Match %s without storing anything", async (ifMatch) => {
    const api = client();
    const response = await api.push("first\n", ifMatch);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "If-Match must contain one quoted lowercase SHA-256 hash.",
    });
    expect((await api.pull()).status).toBe(404);
  });

  test("stores the bytes and serves them back with their hash as ETag", async () => {
    const api = client();
    const body = "lock contents ✓\n";
    const response = await api.push(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hash: hashOf(body),
      size: new TextEncoder().encode(body).byteLength,
    });

    const pulled = await api.pull();
    expect(pulled.status).toBe(200);
    expect(pulled.headers.get("ETag")).toBe(`"${hashOf(body)}"`);
    expect(await pulled.text()).toBe(body);
  });

  test("advances from the pulled version and reports the current hash when stale", async () => {
    const api = client();
    await api.push("first\n");
    expect((await api.push("second\n", `"${hashOf("first\n")}"`)).status).toBe(200);

    const stale = await api.push("third\n", `"${hashOf("first\n")}"`);
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual({
      error: "Remote lockfile changed since it was pulled.",
      current_hash: hashOf("second\n"),
    });
    expect(await (await api.pull()).text()).toBe("second\n");
    expect(await api.history()).toEqual([hashOf("second\n"), hashOf("first\n")]);
    expect((await api.remove(hashOf("third\n"))).status).toBe(404);
  });

  test("concurrent pushes from the same pulled version: exactly one wins", async () => {
    const api = client();
    await api.push("base\n");
    const parent = `"${hashOf("base\n")}"`;
    const bodies = ["mine\n", "theirs\n"];
    const responses = await Promise.all(bodies.map((body) => api.push(body, parent)));
    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 412]);
    const winner = bodies[responses.findIndex((response) => response.status === 200)]!;
    const loser = responses.find((response) => response.status === 412)!;
    expect(await loser.json()).toMatchObject({ current_hash: hashOf(winner) });
    expect(await (await api.pull()).text()).toBe(winner);
    expect(await api.history()).toEqual([hashOf(winner), hashOf("base\n")]);
  });
});

describe("GET /lockfiles/:machine/:kind", () => {
  test("returns 404 for an unknown lockfile", async () => {
    const response = await client().pull("http://worker.test/lockfiles/machine/absent");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Lockfile not found" });
  });

  test("returns 500 when the current version's blob is missing", async () => {
    const api = client();
    await api.push("first\n");
    api.blobs.clear();
    const response = await api.pull();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Lockfile blob is unavailable" });
  });
});

describe("DELETE /lockfiles/:machine/:kind/:hash", () => {
  test("rejects a malformed hash", async () => {
    const response = await client().remove("not-a-hash");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid SHA-256 hash" });
  });

  test("returns 404 for an unknown version", async () => {
    const response = await client().remove(hashOf("never pushed\n"));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Lockfile version not found" });
  });

  test("refuses the current version and removes an older one", async () => {
    const api = client();
    await api.push("first\n");
    await api.push("second\n", `"${hashOf("first\n")}"`);

    const current = await api.remove(hashOf("second\n"));
    expect(current.status).toBe(409);
    expect(await current.json()).toEqual({ error: "Cannot delete the current lockfile version" });

    const older = await api.remove(hashOf("first\n"));
    expect(older.status).toBe(204);
    expect(await api.history()).toEqual([hashOf("second\n")]);
    expect((await api.remove(hashOf("first\n"))).status).toBe(404);
    expect(await (await api.pull()).text()).toBe("second\n");
  });
});

describe("authentication", () => {
  const { env } = storage();

  test.each([
    ["a missing bearer token", {}],
    ["a wrong bearer token", { Authorization: "Bearer wrong-token" }],
  ])("rejects %s", async (_name, headers) => {
    const response = await app.request(url, { headers }, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  test("accepts the configured bearer token", async () => {
    const response = await app.request("http://worker.test/not-found", { headers: auth }, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});

test("0002 backfills each head from the latest existing lockfile", () => {
  const db = new DatabaseSync(":memory:");
  const [first, ...rest] = readdirSync(migrations)
    .filter((file) => file.endsWith(".sql"))
    .toSorted();
  db.exec(readFileSync(new URL(first!, migrations), "utf8"));
  const insert = db.prepare(
    "INSERT INTO lockfiles (machine, kind, hash, size, created_at) VALUES (?, ?, ?, 1, ?)",
  );
  // Newest by timestamp was inserted first; equal timestamps fall back to the later id.
  insert.run("m", "nix", "newer", "2026-02-01T00:00:00.000Z");
  insert.run("m", "nix", "older", "2026-01-01T00:00:00.000Z");
  insert.run("m", "winget", "first", "2026-01-01T00:00:00.000Z");
  insert.run("m", "winget", "second", "2026-01-01T00:00:00.000Z");
  for (const name of rest) {
    db.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  expect(db.prepare("SELECT kind, hash FROM lockfile_heads ORDER BY kind").all()).toEqual([
    { kind: "nix", hash: "newer" },
    { kind: "winget", hash: "second" },
  ]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM lockfile_promotions").get()).toEqual({
    count: 4,
  });
});
