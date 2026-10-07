import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import { describe, expect, test, vi } from "vitest";

import {
  inferOutputPath,
  isGitTrackedFile,
  normalizeSha256,
  normalizeWorkerUrl,
  pullLockfile,
  pushLockfile,
  resolveKindSelection,
} from "@/sync";

const execFileAsync = promisify(execFile);

describe("sync command helpers", () => {
  test("infers common lockfile names", () => {
    expect(inferOutputPath("nix")).toBe("flake.lock");
    expect(inferOutputPath("bun")).toBe("bun.lock");
    expect(inferOutputPath("bun-global-inventory")).toBe("bun-global-inventory.json");
    expect(inferOutputPath("homebrew-inventory")).toBe("homebrew-inventory.txt");
    expect(inferOutputPath("npm")).toBe("package-lock.json");
    expect(inferOutputPath("powershell-inventory")).toBe("powershell-inventory.json");
    expect(inferOutputPath("private-fonts")).toBe("private-fonts-inventory.json");
    expect(inferOutputPath("scoop-inventory")).toBe("scoop-inventory.json");
    expect(inferOutputPath("windows")).toBe("windows.lock.json");
    expect(inferOutputPath("winget")).toBe("winget.json");
    expect(inferOutputPath("custom-kind")).toBeUndefined();
  });

  test("distinguishes repository-owned lockfiles from external lock state", async () => {
    const repository = await mkdtemp(join(tmpdir(), "outfitting-lockfiles-test-"));
    const trackedPath = join(repository, "tracked.lock");
    const untrackedPath = join(repository, "untracked.lock");
    const trackedLink = join(repository, "tracked-link.lock");

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(trackedPath, "tracked");
      await writeFile(untrackedPath, "untracked");
      await symlink(untrackedPath, trackedLink);
      await execFileAsync("git", ["-C", repository, "add", "tracked.lock", "tracked-link.lock"]);

      expect(await isGitTrackedFile(trackedPath)).toBe(true);
      expect(await isGitTrackedFile(untrackedPath)).toBe(false);
      expect(await isGitTrackedFile(trackedLink)).toBe(true);
      expect(await isGitTrackedFile(join(repository, "new", "nested", "snapshot.lock"))).toBe(
        false,
      );
      await expect(
        Effect.runPromise(
          pullLockfile({
            machine: "test-machine",
            kind: "test-kind",
            outPath: trackedPath,
          }),
        ),
      ).rejects.toThrow(`Refusing to overwrite Git-tracked file: ${trackedPath}`);
    } finally {
      await rm(repository, { force: true, recursive: true });
    }
  });

  test("normalizes Worker URLs", () => {
    expect(normalizeWorkerUrl("https://example.workers.dev/")).toBe("https://example.workers.dev");
    expect(() => normalizeWorkerUrl("not a URL")).toThrow("Worker URL must be a valid URL.");
    expect(() => normalizeWorkerUrl("file:///tmp/worker")).toThrow("Worker URL must use HTTPS");
    expect(() => normalizeWorkerUrl("http://remote.example/api")).toThrow("must use HTTPS");
    expect(() => normalizeWorkerUrl("https://user:secret@remote.example/api")).toThrow(
      "must not contain credentials",
    );
    expect(() => normalizeWorkerUrl("https://remote.example/api?token=secret")).toThrow(
      "must not contain credentials",
    );
  });

  test("push uses the supplied lockfile credential snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "outfitting-lockfiles-push-test-"));
    const path = join(directory, "flake.lock");
    const contents = '{ "version": 7 }\n';
    await writeFile(path, contents);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://lockfiles.example/api/lockfiles/test-machine/nix");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer snapshot-token");
      return new Response(
        JSON.stringify({
          hash: "a".repeat(64),
          size: new TextEncoder().encode(contents).byteLength,
        }),
        { status: 200 },
      );
    });
    const bytes = new TextEncoder().encode(contents);
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    vi.stubGlobal("Bun", {
      file: () => ({
        exists: async () => true,
        arrayBuffer: async () => body,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await Effect.runPromise(
        pushLockfile({
          machine: "test-machine",
          kind: "nix",
          path,
          credentials: {
            workerUrl: "https://lockfiles.example/api",
            token: "snapshot-token",
          },
        }),
      );
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects an injected HTTP credential snapshot before sending a bearer token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { request } = await import("@/sync/request");
      await expect(
        request(
          ["lockfiles", "machine", "nix"],
          {},
          {
            workerUrl: "http://remote.example/api",
            token: "sensitive-token",
          },
        ),
      ).rejects.toThrow("must use HTTPS");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("validates and normalizes SHA-256 preconditions", () => {
    expect(normalizeSha256("A".repeat(64))).toBe("a".repeat(64));
    expect(() => normalizeSha256("abc")).toThrow("64-character SHA-256");
  });

  test("treats omitted and all kinds as the all selection", () => {
    expect(resolveKindSelection(undefined)).toEqual({ mode: "all" });
    expect(resolveKindSelection("all")).toEqual({ mode: "all" });
    expect(resolveKindSelection(" ALL ")).toEqual({ mode: "all" });
    expect(resolveKindSelection("nix")).toEqual({ mode: "one", kind: "nix" });
    expect(resolveKindSelection(" homebrew-inventory ")).toEqual({
      mode: "one",
      kind: "homebrew-inventory",
    });
  });
});
