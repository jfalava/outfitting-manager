import { afterEach, describe, expect, test, vi } from "vitest";

import { normalizeCommandAlias } from "@/arguments";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("global config argument", () => {
  test("preserves command arguments when config is before or after the command", () => {
    vi.stubEnv("OUTFITTING_CONFIG", "");
    expect(normalizeCommandAlias(["--config", "machine.toml", "status"])).toEqual(["status"]);
    expect(process.env.OUTFITTING_CONFIG).toBe("machine.toml");

    vi.stubEnv("OUTFITTING_CONFIG", "");
    expect(normalizeCommandAlias(["status", "--config=other.toml"])).toEqual(["status"]);
    expect(process.env.OUTFITTING_CONFIG).toBe("other.toml");
  });

  test("rejects missing, empty, and repeated config options", () => {
    expect(() => normalizeCommandAlias(["--config"])).toThrow("--config requires a path.");
    expect(() => normalizeCommandAlias(["--config", "--help"])).toThrow(
      "--config requires a path.",
    );
    expect(() => normalizeCommandAlias(["--config="])).toThrow(
      "--config requires one path and may be passed only once.",
    );
    expect(() => normalizeCommandAlias(["--config", "one.toml", "--config=two.toml"])).toThrow(
      "--config requires one path and may be passed only once.",
    );
  });
});
