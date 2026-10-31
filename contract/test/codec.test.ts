import { describe, expect, test } from "vitest";

import { decodeResponse, encodeResponse, ErrorBody, PushResponse, Sha256 } from "../src/index";

describe("encodeResponse", () => {
  test("rejects an invalid hash at encode time", () => {
    expect(() => encodeResponse(PushResponse, { hash: "nope", size: 1 })).toThrow();
  });
});

describe("decodeResponse", () => {
  test("returns undefined for garbage instead of throwing", () => {
    expect(decodeResponse(ErrorBody, { not: "error" }, "error")).toBeUndefined();
    expect(decodeResponse(PushResponse, null, "push")).toBeUndefined();
  });

  test("rejects SHA-256 values that are not 64 lowercase hex digits", () => {
    const hash = "0123456789abcdef".repeat(4);
    expect(decodeResponse(Sha256, hash.toUpperCase(), "sha")).toBeUndefined();
    expect(decodeResponse(Sha256, "abc", "sha")).toBeUndefined();
  });
});
