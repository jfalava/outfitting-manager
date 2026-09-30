import { Effect, Option, Schema } from "effect";

import { toError } from "@/lockfiles/effect";
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

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

function releaseVersion(tagName: string): string {
  return tagName.replace(/^cli-/, "").replace(/^v/, "");
}

function isNewerRelease(candidate: GitHubRelease, current: GitHubRelease): boolean {
  return isNewerVersion(releaseVersion(candidate.tag_name), releaseVersion(current.tag_name));
}

function newestRelease(releases: ReadonlyArray<GitHubRelease>): GitHubRelease | undefined {
  return releases.reduce<GitHubRelease | undefined>(
    (newest, candidate) => (!newest || isNewerRelease(candidate, newest) ? candidate : newest),
    undefined,
  );
}

export const latestCliReleaseEffect = Effect.fn("upgrade.latestCliRelease")(function* (
  assetName: string,
  executableName: string,
  fetcher: Fetcher = fetch,
): Effect.fn.Return<CliRelease, ReturnType<typeof toError>> {
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
    return yield* toError(new Error(`GitHub release check failed with HTTP ${response.status}.`));
  }

  const raw: unknown = yield* Effect.tryPromise({ try: () => response.json(), catch: toError });
  const body = decodeReleaseList(raw);
  if (Option.isNone(body)) {
    return yield* toError(new Error("GitHub returned an invalid releases response."));
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
    return yield* toError(new Error("No stable outfitting-manager CLI release was found."));
  }

  const assets = selectReleaseAsset(release, assetName);
  if (!assets) {
    return yield* toError(
      new Error(`Release ${release.tag_name} does not contain ${assetName} and its checksum.`),
    );
  }

  return {
    version: releaseVersion(release.tag_name),
    assetUrl: assets.asset.browser_download_url,
    checksumUrl: assets.checksum.browser_download_url,
    executableName,
  };
});

/** Promise adapter for callers that have not migrated to Effect yet. */
export function latestCliRelease(
  assetName: string,
  executableName: string,
  fetcher: Fetcher = fetch,
): Promise<CliRelease> {
  return Effect.runPromise(latestCliReleaseEffect(assetName, executableName, fetcher));
}
