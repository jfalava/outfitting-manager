import { Effect, Option, Schema } from "effect";

import { toError } from "@/effect";
import { CliFailure } from "@/errors";
import { isNewerVersion } from "@/upgrade/version";

const RELEASES_URL = "https://api.github.com/repos/jfalava/outfitting-manager/releases?per_page=30";

const GitHubAssetSchema = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
});

const GitHubReleaseSchema = Schema.Struct({
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  tag_name: Schema.String,
  assets: Schema.Array(GitHubAssetSchema),
});

type GitHubRelease = Schema.Schema.Type<typeof GitHubReleaseSchema>;
type GitHubAsset = Schema.Schema.Type<typeof GitHubAssetSchema>;
interface SelectedReleaseAsset {
  asset: GitHubAsset;
  checksum: GitHubAsset;
}

const ReleaseListSchema = Schema.Array(Schema.Unknown);
const decodeReleaseList = Schema.decodeUnknownOption(ReleaseListSchema);
const decodeGitHubRelease = Schema.decodeUnknownOption(GitHubReleaseSchema);

export interface CliRelease {
  version: string;
  assetUrl: string;
  checksumUrl: string;
  executableName: string;
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function selectReleaseAsset(
  release: GitHubRelease,
  assetName: string,
): SelectedReleaseAsset | undefined {
  const archive = release.assets.find((asset) => asset.name === assetName);
  if (!archive) {
    return undefined;
  }
  const checksum = release.assets.find((asset) => asset.name === `${archive.name}.sha256`);
  return checksum ? { asset: archive, checksum } : undefined;
}

const CLI_TAG_PREFIX = "cli-v";

function newestRelease(releases: ReadonlyArray<GitHubRelease>): GitHubRelease | undefined {
  return releases.reduce<GitHubRelease | undefined>(
    (newest, candidate) =>
      !newest || isNewerVersion(candidate.tag_name, newest.tag_name) ? candidate : newest,
    undefined,
  );
}

export const latestCliReleaseEffect = Effect.fn("upgrade.latestCliRelease")(function* (
  assetName: string,
  executableName: string,
  fetcher: Fetcher = fetch,
): Effect.fn.Return<CliRelease, CliFailure> {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetcher(RELEASES_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "outfitting-manager",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      }),
    catch: toError,
  });
  if (!response.ok) {
    return yield* new CliFailure({
      message: `GitHub release check failed with HTTP ${response.status}.`,
    });
  }

  const raw: unknown = yield* Effect.tryPromise({ try: () => response.json(), catch: toError });
  const body = decodeReleaseList(raw);
  if (Option.isNone(body)) {
    return yield* new CliFailure({ message: "GitHub returned an invalid releases response." });
  }

  const releases = body.value.flatMap((candidate) => {
    const decoded = decodeGitHubRelease(candidate);
    if (Option.isNone(decoded)) {
      return [];
    }
    return [decoded.value];
  });
  const stableReleases = releases.filter(
    (candidate) =>
      !candidate.draft && !candidate.prerelease && /^cli-v\d+\.\d+\.\d+$/.test(candidate.tag_name),
  );
  const release = newestRelease(stableReleases);
  if (!release) {
    return yield* new CliFailure({
      message: "No stable outfitting-manager CLI release was found.",
    });
  }

  const assets = selectReleaseAsset(release, assetName);
  if (!assets) {
    return yield* new CliFailure({
      message: `Release ${release.tag_name} does not contain ${assetName} and its checksum.`,
    });
  }

  return {
    version: release.tag_name.slice(CLI_TAG_PREFIX.length),
    assetUrl: assets.asset.browser_download_url,
    checksumUrl: assets.checksum.browser_download_url,
    executableName,
  };
});
