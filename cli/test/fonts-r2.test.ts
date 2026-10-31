import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { fontsCommand } from "@/commands/fonts";
import { checksumSidecar } from "@/fonts/archive";
import { FONT_ARCHIVE_KEY, FONT_CHECKSUM_KEY } from "@/fonts/constants";
import { createR2ObjectStore } from "@/fonts/r2";

const { sendMock, credentialsMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  credentialsMock: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const sdk = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...sdk,
    S3Client: class {
      send = sendMock;
    },
  };
});

vi.mock("@/fonts/keychain", () => ({
  r2Credentials: Effect.suspend(() => Effect.promise(() => credentialsMock())),
}));

let root: string;
let configPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "outfitting-font-bucket-"));
  configPath = join(root, "config.toml");
  await writeFile(configPath, 'schema = 2\n[fonts]\nbucket = "team-font-library"\n');
  vi.stubEnv("OUTFITTING_CONFIG", configPath);
  vi.stubEnv("OUTFITTING_PRIVATE_FONTS_BUCKET", undefined);
  vi.stubEnv("OUTFITTING_DEPLOY_CONFIG", join(root, "missing-deployment.json"));
  vi.stubEnv("OUTFITTING_SYNC_URL", "https://inventory.example.com/api/");
  credentialsMock.mockResolvedValue({
    endpoint: "https://account.r2.cloudflarestorage.com",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
  });
});

afterEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("R2 font archive writes", () => {
  test.each([
    ["replacement", '"previous-etag"', { IfMatch: '"previous-etag"' }],
    ["initial publication", undefined, { IfNoneMatch: "*" }],
  ])(
    "stores the archive and digest together for %s",
    async (_scenario, expectedEtag, condition) => {
      const archive = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02, 0x03]);
      const checksum = checksumSidecar(archive);
      credentialsMock.mockResolvedValue({
        endpoint: "https://account.r2.cloudflarestorage.com",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-secret-key",
      });
      sendMock.mockResolvedValue({});

      const store = await Effect.runPromise(createR2ObjectStore());
      await store.putArchive(archive, checksum, expectedEtag);

      expect(sendMock).toHaveBeenCalledTimes(2);
      const archivePut = sendMock.mock.calls[0]?.[0] as PutObjectCommand;
      const sidecarPut = sendMock.mock.calls[1]?.[0] as PutObjectCommand;
      expect(archivePut.input).toMatchObject({
        Bucket: "team-font-library",
        Key: FONT_ARCHIVE_KEY,
        ContentType: "application/gzip",
        Metadata: { sha256: sha256(archive) },
        ...condition,
      });
      expect(archivePut.input.Body).toBe(archive);
      expect(sidecarPut.input).toMatchObject({
        Bucket: "team-font-library",
        Key: FONT_CHECKSUM_KEY,
        ContentType: "text/plain; charset=utf-8",
        Body: checksum,
      });
    },
  );

  test("environment overrides runtime TOML without consulting deployment config", async () => {
    vi.stubEnv("OUTFITTING_PRIVATE_FONTS_BUCKET", " alternate-font-library ");
    sendMock.mockResolvedValue({ Body: { transformToByteArray: async () => new Uint8Array() } });
    const store = await Effect.runPromise(createR2ObjectStore());
    await store.getChecksum();
    expect(store.bucket).toBe("alternate-font-library");
    expect(sendMock.mock.calls[0]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect(sendMock.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "alternate-font-library",
      Key: FONT_CHECKSUM_KEY,
    });
  });

  test("requires an explicit runtime bucket before credential or object access", async () => {
    await writeFile(configPath, "schema = 2\n");
    await expect(Effect.runPromise(createR2ObjectStore())).rejects.toThrow(
      "Configure [fonts].bucket",
    );
    expect(credentialsMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  test.each(["publish", "remove", "repopulate", "list"])(
    "%s identifies the runtime target even when the archive cannot be read",
    async (command) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      sendMock.mockRejectedValue(new Error("Fixture archive is unavailable"));
      // The remote read fails before these incoming bytes are parsed as a font.
      await writeFile(join(root, "example.otf"), new Uint8Array([0x4f, 0x54, 0x54, 0x4f]));
      const args =
        command === "list"
          ? [command, "--repopulate"]
          : command === "publish"
            ? [command, root, "--dry-run"]
            : command === "remove"
              ? [command, "Example Sans", "--dry-run"]
              : [command, "--dry-run"];
      await expect(
        Effect.runPromise(
          Command.runWith(fontsCommand, { version: "1.0.0" })(args).pipe(
            Effect.provide(BunServices.layer),
          ),
        ),
      ).rejects.toThrow("Fixture archive is unavailable");
      const output = log.mock.calls.flat().join("\n");
      expect(output).toContain("Font bucket:");
      expect(output).toContain("team-font-library");
      expect(output).toContain("Inventory API:");
      expect(output).toContain("https://inventory.example.com/api");
      expect(output).not.toContain("test-secret-key");
    },
  );
});
