import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { emptyFontArchive, unpackFontArchive, type FontArchive } from "@/fonts/archive";
import { FONT_ARCHIVE_KEY, FONT_CHECKSUM_KEY } from "@/fonts/constants";
import { r2Credentials } from "@/fonts/keychain";

import { loadDeployConfig } from "../../../iac/src/deploy-config";

export interface FontObjectStore {
  getArchive(): Promise<{ bytes: Uint8Array; etag: string } | undefined>;
  getChecksum(): Promise<string | undefined>;
  putArchive(archive: Uint8Array, checksum: string, expectedEtag?: string): Promise<void>;
}

async function bodyBytes(
  body: { transformToByteArray(): Promise<Uint8Array> } | undefined,
): Promise<Uint8Array> {
  if (body === undefined) {
    throw new Error("R2 object body was empty.");
  }
  return body.transformToByteArray();
}

export async function createR2ObjectStore(): Promise<FontObjectStore> {
  const credentials = await r2Credentials();
  const client = new S3Client({
    region: "auto",
    endpoint: credentials.endpoint,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
  const bucket = loadDeployConfig().privateFontsBucket;

  return {
    async getArchive() {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: FONT_ARCHIVE_KEY,
          }),
        );
        if (!response.ETag) {
          throw new Error("R2 font archive is missing an ETag; refusing an unsafe publish.");
        }
        return { bytes: await bodyBytes(response.Body), etag: response.ETag };
      } catch (cause) {
        if (cause instanceof NoSuchKey) {
          return undefined;
        }
        throw cause;
      }
    },
    async getChecksum() {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: FONT_CHECKSUM_KEY }),
        );
        return new TextDecoder().decode(await bodyBytes(response.Body));
      } catch (cause) {
        if (cause instanceof NoSuchKey) {
          return undefined;
        }
        throw cause;
      }
    },
    async putArchive(archive, checksum, expectedEtag) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: FONT_ARCHIVE_KEY,
          Body: archive,
          ContentType: "application/gzip",
          ...(expectedEtag === undefined ? { IfNoneMatch: "*" } : { IfMatch: expectedEtag }),
        }),
      );
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: FONT_CHECKSUM_KEY,
          Body: checksum,
          ContentType: "text/plain; charset=utf-8",
        }),
      );
    },
  };
}

export async function loadRemoteArchive(store: FontObjectStore): Promise<FontArchive> {
  return (await loadRemoteArchiveState(store)).archive;
}

export interface RemoteArchiveState {
  readonly bytes: Uint8Array | undefined;
  readonly etag: string | undefined;
  readonly archive: FontArchive;
}

export async function loadRemoteArchiveState(store: FontObjectStore): Promise<RemoteArchiveState> {
  const current = await store.getArchive();
  if (current === undefined) {
    return { bytes: undefined, etag: undefined, archive: emptyFontArchive() };
  }
  if (current.bytes.byteLength === 0) {
    throw new Error("R2 font archive is empty; refusing to treat it as a new archive.");
  }
  return {
    bytes: current.bytes,
    etag: current.etag,
    archive: await unpackFontArchive(current.bytes),
  };
}
