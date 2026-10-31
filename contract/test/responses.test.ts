import { describe, expect, test } from "vitest";

import { decodeResponse, HistoryResponse, KindsResponse, StalePushBody } from "../src/index";

const hash = "b".repeat(64);

describe("lockfiles response schemas", () => {
  test("rejects history entries missing created_at", () => {
    expect(decodeResponse(HistoryResponse, [{ hash, size: 1 }], "history")).toBeUndefined();
  });

  test("rejects kinds that are not strings", () => {
    expect(decodeResponse(KindsResponse, [{ kind: "bun" }], "kinds")).toBeUndefined();
  });

  test("stale push bodies carry a SHA-256 or null current_hash", () => {
    const body = { error: "Remote lockfile changed since it was pulled.", current_hash: null };
    expect(decodeResponse(StalePushBody, body, "stale")).toEqual(body);
    expect(
      decodeResponse(StalePushBody, { error: "stale", current_hash: "short" }, "stale"),
    ).toBeUndefined();
    expect(decodeResponse(StalePushBody, { error: "stale" }, "stale")).toBeUndefined();
  });
});
