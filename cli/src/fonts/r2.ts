import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Effect } from "effect";

import { loadConfig } from "@/config/load";
import { tryPromise } from "@/effect";
import { CliFailure } from "@/errors";
import { emptyFontArchive, sha256Hex, unpackFontArchive, type FontArchive } from "@/fonts/archive";
import { FONT_ARCHIVE_KEY, FONT_CHECKSUM_KEY } from "@/fonts/constants";
import { r2Credentials, type R2Credentials } from "@/fonts/keychain";
import { envValue } from "@/secrets";

export interface FontObjectStore {
  readonly bucket: string;
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

export const createR2ObjectStore = Effect.fnUntraced(function* () {
  const config = yield* tryPromise(() => loadConfig());
  const bucket = envValue("OUTFITTING_PRIVATE_FONTS_BUCKET") ?? config.fonts?.bucket;
  if (bucket === undefined) {
    return yield* new CliFailure({
      message:
        "Configure [fonts].bucket in config.toml or OUTFITTING_PRIVATE_FONTS_BUCKET before accessing the font archive.",
    });
  }
  const credentials = yield* r2Credentials;
  return objectStore(bucket, credentials);
});

function objectStore(bucket: string, credentials: R2Credentials): FontObjectStore {
  const client = new S3Client({
    region: "auto",
    endpoint: credentials.endpoint,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    },
  });
  return {
    bucket,
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
          Metadata: { sha256: sha256Hex(archive) },
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
