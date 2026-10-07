import { Effect, Result, Schema } from "effect";

import { toError } from "@/effect";
import { CliFailure } from "@/errors";
import { runCommand } from "@/process";
import { relativeSourcePath } from "@/source/contract";
import { isReservedSourcePath } from "@/source/reserved";

export type ManifestFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type GitHubBlobTransport = "raw" | "gh";

export interface GitHubRepository {
  host: string;
  owner: string;
  name: string;
  /** Raw-content base without a ref. Meaningful for public github.com only. */
  baseUrl: string;
  transport: GitHubBlobTransport;
}

const GITHUB_WEB_HOSTS = new Set(["github.com", "www.github.com"]);

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/g, "");
}

function repositoryFromParts(host: string, owner: string, name: string): GitHubRepository {
  const normalizedHost = host.toLowerCase();
  const repoName = name.replace(/\.git$/i, "");
  const publicGitHub = GITHUB_WEB_HOSTS.has(normalizedHost);
  return {
    host: publicGitHub ? "github.com" : normalizedHost,
    owner,
    name: repoName,
    baseUrl: publicGitHub
      ? `https://raw.githubusercontent.com/${owner}/${repoName}`
      : `https://${normalizedHost}/api/v3`,
    transport: publicGitHub ? "raw" : "gh",
  };
}

function gitHubHost(hostname: string): string | undefined {
  const raw = hostname.match(/^(?:raw|codeload)\.([^/]+)$/i);
  const host = (raw?.[1] ?? hostname).toLowerCase();
  if (
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com") ||
    host === "www.github.com"
  ) {
    return "github.com";
  }
  if (host === "github.com" || host.endsWith(".ghe.com") || host.startsWith("github.")) {
    return host;
  }
  return undefined;
}

/**
 * Classify a GitHub web or raw URL.
 * github.com starts with anonymous access and retries with `gh` on 404; Enterprise hosts use `gh`.
 * Returns undefined for non-GitHub URLs.
 */
export function classifyGitHubRepository(value: string): GitHubRepository | undefined {
  const normalized = stripTrailingSlash(value.trim());
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return undefined;
  }
  const host = gitHubHost(url.hostname);
  const [owner, name] = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (host === undefined || owner === undefined || name === undefined) {
    return undefined;
  }
  return repositoryFromParts(host, owner, name);
}

export function gitHubAuthHint(host: string): string {
  return `gh auth login --hostname ${host}`;
}

const GitHubTreeEntrySchema = Schema.Struct({
  type: Schema.String,
  path: Schema.String,
  mode: Schema.String,
  sha: Schema.String,
});

const decodeCommit = Schema.decodeUnknownSync(Schema.Struct({ sha: Schema.String }));
const decodeTree = Schema.decodeUnknownSync(
  Schema.Struct({
    truncated: Schema.Boolean,
    tree: Schema.Array(GitHubTreeEntrySchema),
  }),
);
const decodeBlob = Schema.decodeUnknownSync(
  Schema.Struct({
    encoding: Schema.Literal("base64"),
    content: Schema.String,
  }),
);

interface GitHubReadOptions {
  repository: GitHubRepository;
  ref: string;
  paths: readonly string[];
  run?: typeof runCommand;
  fetcher?: ManifestFetcher;
}

interface GitHubFileReadOptions extends Omit<GitHubReadOptions, "paths"> {
  path: string;
}

export interface GitHubSourceFile {
  /** Always repository-relative, for both file and directory requests. */
  path: string;
  body: Uint8Array;
  mode: number;
  revision: string;
}

export class GitHubHttpError extends Schema.TaggedError<GitHubHttpError>()("GitHubHttpError", {
  url: Schema.String,
  status: Schema.Finite,
  message: Schema.String,
}) {}

const ghApi = Effect.fn("github.ghApi")(function* (
  host: string,
  apiPath: string,
  run: typeof runCommand,
): Effect.fn.Return<string, CliFailure> {
  const result = yield* Effect.tryPromise({
    try: () => run("gh", ["api", "--hostname", host, apiPath], { inherit: false }),
    catch: (cause) => {
      const code =
        cause instanceof Error && "code" in cause
          ? (cause as NodeJS.ErrnoException).code
          : undefined;
      return new CliFailure({
        message:
          code === "ENOENT"
            ? `GitHub CLI is not installed. Authenticate with \`${gitHubAuthHint(host)}\`.`
            : cause instanceof Error
              ? cause.message
              : String(cause),
        cause,
      });
    },
  });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    return yield* new CliFailure({
      message: `Unable to read ${host} with gh (exit ${result.code}). Authenticate with \`${gitHubAuthHint(host)}\`${detail.length > 0 ? `: ${detail}` : "."}`,
      cause: new Error(detail),
    });
  }
  return result.stdout;
});

const publicResponse = Effect.fn("github.publicResponse")(function* (
  url: string,
  fetcher: ManifestFetcher = globalThis.fetch,
): Effect.fn.Return<Response, CliFailure | GitHubHttpError> {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetcher(url, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "outfitting-manager" },
        signal: AbortSignal.timeout(30_000),
      }),
    catch: toError,
  });
  if (!response.ok) {
    return yield* new GitHubHttpError({
      url,
      status: response.status,
      message: `Failed to fetch ${url}: HTTP ${response.status}.`,
    });
  }
  return response;
});

function repositoryEndpoint(repository: GitHubRepository): string {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

const repositoryJson = Effect.fn("github.repositoryJson")(function* (
  options: GitHubReadOptions,
  endpoint: string,
): Effect.fn.Return<unknown, CliFailure | GitHubHttpError> {
  if (options.repository.transport === "gh") {
    const body = yield* ghApi(options.repository.host, endpoint, options.run ?? runCommand);
    return yield* Effect.try({ try: () => JSON.parse(body), catch: toError });
  }
  const response = yield* publicResponse(`https://api.github.com${endpoint}`, options.fetcher);
  return yield* Effect.tryPromise({ try: () => response.json(), catch: toError });
});

function withinPath(path: string, root: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`);
}

type GitHubTreeEntry = Schema.Schema.Type<typeof GitHubTreeEntrySchema>;

function selectSourceEntries(
  entries: readonly GitHubTreeEntry[],
  paths: readonly string[],
): GitHubTreeEntry[] {
  const roots = paths.map((path) => relativeSourcePath(path, "BYOR path"));
  for (const root of roots) {
    if (!entries.some((entry) => entry.type !== "tree" && withinPath(entry.path, root))) {
      throw new Error(`GitHub path \`${root}\` is missing or empty.`);
    }
    if (isReservedSourcePath(root)) {
      throw new Error(
        `GitHub path \`${root}\` is reserved for machine configuration and runtime state.`,
      );
    }
  }
  const selected = entries.filter(
    (entry) =>
      entry.type !== "tree" &&
      roots.some((root) => withinPath(entry.path, root)) &&
      !isReservedSourcePath(entry.path),
  );
  for (const entry of selected) {
    relativeSourcePath(entry.path, "GitHub tree path");
    if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) {
      throw new Error(
        `Unsupported GitHub entry ${entry.path} (${entry.mode}). Use a local checkout for symlinks or submodules.`,
      );
    }
  }
  return selected;
}

const readSourceFile = Effect.fn("github.readSourceFile")(function* (
  options: GitHubReadOptions,
  entry: GitHubTreeEntry,
  commit: string,
): Effect.fn.Return<GitHubSourceFile, CliFailure | GitHubHttpError> {
  let body: Uint8Array;
  if (options.repository.transport === "gh") {
    const raw = yield* repositoryJson(
      options,
      `${repositoryEndpoint(options.repository)}/git/blobs/${encodeURIComponent(entry.sha)}`,
    );
    const blob = yield* Effect.try({ try: () => decodeBlob(raw), catch: toError });
    body = Buffer.from(blob.content, "base64");
  } else {
    const path = entry.path.split("/").map(encodeURIComponent).join("/");
    const response = yield* publicResponse(
      `${options.repository.baseUrl}/${encodeURIComponent(commit)}/${path}`,
      options.fetcher,
    );
    body = yield* Effect.tryPromise({ try: () => response.arrayBuffer(), catch: toError }).pipe(
      Effect.map((bytes) => new Uint8Array(bytes)),
    );
  }
  return {
    path: entry.path,
    body,
    mode: entry.mode === "100755" ? 0o755 : 0o644,
    revision: commit,
  };
});

const readGitHubTree = Effect.fn("github.readGitHubTree")(function* (
  options: GitHubReadOptions,
): Effect.fn.Return<
  {
    commit: string;
    entries: readonly GitHubTreeEntry[];
    repository: GitHubRepository;
  },
  CliFailure | GitHubHttpError
> {
  let repository = options.repository;
  const endpoint = repositoryEndpoint(repository);
  const commitPath = `${endpoint}/commits/${encodeURIComponent(options.ref)}`;
  let commitResponse: unknown;
  const firstCommit = yield* Effect.result(repositoryJson(options, commitPath));
  if (Result.isSuccess(firstCommit)) {
    commitResponse = firstCommit.success;
  } else {
    const cause = firstCommit.failure;
    if (
      repository.transport !== "raw" ||
      !Schema.is(GitHubHttpError)(cause) ||
      cause.status !== 404
    ) {
      return yield* cause;
    }

    repository = { ...repository, transport: "gh" };
    const authenticated = yield* Effect.result(
      repositoryJson({ ...options, repository }, commitPath),
    );
    if (Result.isFailure(authenticated)) {
      const detail = authenticated.failure.message;
      return yield* new CliFailure({
        message: `GitHub returned HTTP 404 for ${repository.owner}/${repository.name}@${options.ref} without authentication, and the authenticated lookup failed. Check that the repository and ref exist, and authenticate with \`${gitHubAuthHint(repository.host)}\`: ${detail}`,
        cause: authenticated.failure,
      });
    }
    commitResponse = authenticated.success;
  }

  const commit = yield* Effect.try({ try: () => decodeCommit(commitResponse), catch: toError });
  const treeResponse = yield* repositoryJson(
    { ...options, repository },
    `${endpoint}/git/trees/${encodeURIComponent(commit.sha)}?recursive=1`,
  );
  const tree = yield* Effect.try({
    try: () => decodeTree(treeResponse),
    catch: toError,
  });
  if (tree.truncated) {
    return yield* new CliFailure({
      message:
        "GitHub returned a truncated repository tree. Use a local checkout rather than publishing an incomplete source.",
    });
  }
  return { commit: commit.sha, entries: tree.tree, repository };
});

/** Read one repository file for setup metadata without adding it to the managed source snapshot. */
export const readGitHubFileEffect = Effect.fn("github.readGitHubFile")(function* (
  options: GitHubFileReadOptions,
): Effect.fn.Return<GitHubSourceFile, CliFailure | GitHubHttpError> {
  const path = yield* Effect.try({
    try: () => relativeSourcePath(options.path, "GitHub path"),
    catch: toError,
  });
  const { commit, entries, repository } = yield* readGitHubTree({ ...options, paths: [path] });
  const entry = entries.find((candidate) => candidate.path === path && candidate.type === "blob");
  if (entry === undefined) {
    return yield* new CliFailure({ message: `GitHub file \`${path}\` is missing.` });
  }
  if (!["100644", "100755"].includes(entry.mode)) {
    return yield* new CliFailure({
      message: `Unsupported GitHub entry ${entry.path} (${entry.mode}). Use a local checkout for symlinks or submodules.`,
    });
  }
  return yield* readSourceFile({ ...options, repository, paths: [path] }, entry, commit);
});

/** Fetch the selected files/directories once, from one immutable repository revision. */
export const readGitHubBlobsEffect = Effect.fn("github.readGitHubBlobs")(function* (
  options: GitHubReadOptions,
): Effect.fn.Return<GitHubSourceFile[], CliFailure | GitHubHttpError> {
  const { commit, entries, repository } = yield* readGitHubTree(options);
  const selected = yield* Effect.try({
    try: () => selectSourceEntries(entries, options.paths),
    catch: toError,
  });
  const files: GitHubSourceFile[] = [];
  for (const entry of selected) {
    files.push(yield* readSourceFile({ ...options, repository }, entry, commit));
  }
  return files;
});

/** Promise adapter for callers that have not migrated to Effect yet. */
export function readGitHubFile(options: GitHubFileReadOptions): Promise<GitHubSourceFile> {
  return Effect.runPromise(readGitHubFileEffect(options));
}

/** Promise adapter for callers that have not migrated to Effect yet. */
export function readGitHubBlobs(options: GitHubReadOptions): Promise<GitHubSourceFile[]> {
  return Effect.runPromise(readGitHubBlobsEffect(options));
}
