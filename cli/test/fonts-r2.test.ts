import { createHash } from "node:crypto";

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, test, vi } from "vitest";

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

vi.mock("@/fonts/keychain", () => ({ r2Credentials: credentialsMock }));

afterEach(() => sendMock.mockReset());

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

      const store = await createR2ObjectStore();
      await store.putArchive(archive, checksum, expectedEtag);

      expect(sendMock).toHaveBeenCalledTimes(2);
      const archivePut = sendMock.mock.calls[0]?.[0] as PutObjectCommand;
      const sidecarPut = sendMock.mock.calls[1]?.[0] as PutObjectCommand;
      expect(archivePut.input).toMatchObject({
        Key: FONT_ARCHIVE_KEY,
        ContentType: "application/gzip",
        Metadata: { sha256: sha256(archive) },
        ...condition,
      });
      expect(archivePut.input.Body).toBe(archive);
      expect(sidecarPut.input).toMatchObject({
        Key: FONT_CHECKSUM_KEY,
        ContentType: "text/plain; charset=utf-8",
        Body: checksum,
      });
    },
  );
});
