import { brandId } from "@verify-agent/domain";
import type { RepositorySnapshot } from "@verify-agent/domain";
import { normalizePath } from "@verify-agent/domain";
import { InvalidSourceReferenceError } from "./resolver.js";
import type {
  ResolvedSource,
  SourceContents,
  SourceResolver,
} from "./resolver.js";

export type GitHubSnapshotReference = {
  readonly kind: "github-snapshot";
  readonly owner: string;
  readonly repository: string;
  readonly sha: string;
};

export interface GitHubSourceProvider {
  resolveSnapshot(reference: GitHubSnapshotReference): Promise<ResolvedSource>;
}

const OWNER_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/;
const REPOSITORY_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,99})$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

function isValidOwner(owner: string): boolean {
  return OWNER_RE.test(owner);
}

function isValidRepository(repository: string): boolean {
  return REPOSITORY_RE.test(repository);
}

function isValidSha(sha: string): boolean {
  return SHA_RE.test(sha);
}

export function validateGitHubSnapshotReference(
  reference: GitHubSnapshotReference,
): void {
  if (reference.kind !== "github-snapshot") {
    throw new InvalidSourceReferenceError(
      "GitHub reference kind must be github-snapshot",
    );
  }
  if (!isValidOwner(reference.owner)) {
    throw new InvalidSourceReferenceError(
      `invalid GitHub owner: ${reference.owner}`,
    );
  }
  if (!isValidRepository(reference.repository)) {
    throw new InvalidSourceReferenceError(
      `invalid GitHub repository: ${reference.repository}`,
    );
  }
  if (!isValidSha(reference.sha)) {
    throw new InvalidSourceReferenceError(
      `invalid GitHub sha: ${reference.sha}`,
    );
  }
}

export function encodeGitHubSnapshotReference(
  reference: GitHubSnapshotReference,
): string {
  validateGitHubSnapshotReference(reference);
  return `${reference.owner}:${reference.repository}:${reference.sha.toLowerCase()}`;
}

export function decodeGitHubSnapshotReference(
  id: string,
): GitHubSnapshotReference {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new InvalidSourceReferenceError("invalid GitHub snapshot id");
  }
  if (id.includes("/") || id.includes("\\") || id.includes("@")) {
    throw new InvalidSourceReferenceError(
      "GitHub snapshot id must not contain path separators or @",
    );
  }
  const parts = id.split(":");
  if (parts.length !== 3) {
    throw new InvalidSourceReferenceError(
      "GitHub snapshot id must be owner:repository:sha",
    );
  }
  const [owner, repository, sha] = parts as [string, string, string];
  const reference: GitHubSnapshotReference = {
    kind: "github-snapshot",
    owner,
    repository,
    sha: sha.toLowerCase(),
  };
  validateGitHubSnapshotReference(reference);
  return reference;
}

function freezeSourceContents(contents: SourceContents): SourceContents {
  const copy: Record<string, string> = {};
  for (const [path, value] of Object.entries(contents)) {
    if (typeof value !== "string") {
      throw new InvalidSourceReferenceError(
        `source content for ${path} must be text`,
      );
    }
    const normalized = normalizePath(path);
    if (normalized !== path && normalizePath(path) !== path) {
      throw new InvalidSourceReferenceError(`invalid path: ${path}`);
    }
    if (path.startsWith("/") || path.includes("..") || path.includes("\\")) {
      throw new InvalidSourceReferenceError(`invalid path: ${path}`);
    }
    copy[normalized] = value;
  }
  return Object.freeze({ ...copy });
}

function freezeSnapshot(snapshot: RepositorySnapshot): RepositorySnapshot {
  return Object.freeze({
    ...snapshot,
    source: Object.freeze({ ...snapshot.source }),
    sourceState: Object.freeze({ ...snapshot.sourceState }),
  });
}

function cloneSourceContents(contents: SourceContents): SourceContents {
  return Object.freeze({ ...contents });
}

function cloneSnapshot(snapshot: RepositorySnapshot): RepositorySnapshot {
  return Object.freeze({
    ...snapshot,
    source: Object.freeze({ ...snapshot.source }),
    sourceState: Object.freeze({ ...snapshot.sourceState }),
  });
}

export function createGitHubRepositorySnapshot(
  reference: GitHubSnapshotReference,
  options?: { readonly retrievedAt?: string },
): RepositorySnapshot {
  validateGitHubSnapshotReference(reference);
  const sha = reference.sha.toLowerCase();
  const owner = reference.owner;
  const repository = reference.repository;
  const projectId = brandId<"ProjectId">(`${owner}--${repository}`);
  const snapshotId = brandId<"RepositorySnapshotId">(
    `${owner}--${repository}--${sha}`,
  );
  const retrievedAt = options?.retrievedAt ?? "2024-01-01T00:00:00.000Z";
  const snapshot: RepositorySnapshot = {
    id: snapshotId,
    projectId,
    source: {
      provider: "github",
      reference: sha,
    },
    sourceState: {
      type: "commit",
      value: sha,
    },
    commitSha: sha,
    retrievedAt,
  };
  return freezeSnapshot(snapshot);
}

export const DEFAULT_GITHUB_FIXTURE_CONTENTS: SourceContents = Object.freeze({
  "package.json": JSON.stringify(
    { name: "fixture", private: true, version: "0.0.0" },
    null,
    2,
  ),
  "tsconfig.json": JSON.stringify(
    { compilerOptions: { target: "ES2022", module: "NodeNext" } },
    null,
    2,
  ),
  "src/index.ts": "export const value = 42;\n",
});

export interface GitHubFixture {
  readonly reference: GitHubSnapshotReference;
  readonly snapshot?: RepositorySnapshot;
  readonly sourceContents: SourceContents;
}

function normalizeFixture(fixture: GitHubFixture): {
  reference: GitHubSnapshotReference;
  snapshot: RepositorySnapshot;
  contents: SourceContents;
} {
  validateGitHubSnapshotReference(fixture.reference);
  const contents = freezeSourceContents(fixture.sourceContents);
  const snapshot = fixture.snapshot
    ? freezeSnapshot(fixture.snapshot)
    : createGitHubRepositorySnapshot(fixture.reference);
  return {
    reference: {
      kind: "github-snapshot",
      owner: fixture.reference.owner,
      repository: fixture.reference.repository,
      sha: fixture.reference.sha.toLowerCase(),
    },
    snapshot,
    contents,
  };
}

export function createInMemoryGitHubSourceProvider(
  fixtures: readonly GitHubFixture[],
): GitHubSourceProvider {
  const map = new Map<
    string,
    { snapshot: RepositorySnapshot; contents: SourceContents }
  >();
  for (const fixture of fixtures) {
    const normalized = normalizeFixture(fixture);
    const key = encodeGitHubSnapshotReference(normalized.reference);
    if (map.has(key)) {
      throw new Error(`duplicate GitHub fixture for ${key}`);
    }
    map.set(key, {
      snapshot: normalized.snapshot,
      contents: normalized.contents,
    });
  }

  return {
    async resolveSnapshot(
      reference: GitHubSnapshotReference,
    ): Promise<ResolvedSource> {
      validateGitHubSnapshotReference(reference);
      const key = encodeGitHubSnapshotReference(reference);
      const entry = map.get(key);
      if (!entry) {
        throw new InvalidSourceReferenceError(
          `unknown GitHub reference: ${key}`,
        );
      }
      return {
        snapshot: cloneSnapshot(entry.snapshot),
        sourceContents: cloneSourceContents(entry.contents),
      };
    },
  };
}

export function createSingleGitHubFixtureProvider(options: {
  readonly owner: string;
  readonly repository: string;
  readonly sha: string;
  readonly sourceContents?: SourceContents;
  readonly snapshot?: RepositorySnapshot;
  readonly retrievedAt?: string;
}): GitHubSourceProvider {
  const reference: GitHubSnapshotReference = {
    kind: "github-snapshot",
    owner: options.owner,
    repository: options.repository,
    sha: options.sha,
  };
  const contents = options.sourceContents ?? DEFAULT_GITHUB_FIXTURE_CONTENTS;
  const snapshot =
    options.snapshot ??
    createGitHubRepositorySnapshot(reference, {
      retrievedAt: options.retrievedAt,
    });
  return createInMemoryGitHubSourceProvider([
    { reference, snapshot, sourceContents: contents },
  ]);
}

export function createGitHubSourceResolver(
  provider: GitHubSourceProvider,
): SourceResolver {
  return {
    async resolveSnapshot(source): Promise<ResolvedSource> {
      if (source.kind !== "snapshot") {
        throw new InvalidSourceReferenceError(
          `unsupported source kind: ${String((source as { kind: unknown }).kind)}`,
        );
      }
      let reference: GitHubSnapshotReference;
      try {
        reference = decodeGitHubSnapshotReference(source.id);
      } catch (error) {
        if (
          error instanceof InvalidSourceReferenceError ||
          (error instanceof Error &&
            error.name === "InvalidSourceReferenceError")
        ) {
          throw error;
        }
        throw new InvalidSourceReferenceError("invalid GitHub snapshot id", {
          cause: error,
        });
      }
      return provider.resolveSnapshot(reference);
    },
  };
}

export class GitHubAuthenticationError extends Error {
  constructor(message = "GitHub authentication failed") {
    super(message);
    this.name = "GitHubAuthenticationError";
  }
}

export class GitHubRateLimitError extends Error {
  constructor(message = "GitHub rate limit exceeded") {
    super(message);
    this.name = "GitHubRateLimitError";
  }
}

export class GitHubProviderError extends Error {
  constructor(message = "GitHub provider error") {
    super(message);
    this.name = "GitHubProviderError";
  }
}

export interface GitHubApiSourceProviderOptions {
  readonly token?: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
  readonly retrievedAt?: string;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 5_000_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

function normalizeApiBaseUrl(value?: string): string {
  const base = (value ?? DEFAULT_API_BASE_URL).trim().replace(/\/+$/, "");
  if (base.length === 0) return DEFAULT_API_BASE_URL;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new InvalidSourceReferenceError("apiBaseUrl must be http or https");
    }
    if (url.username || url.password) {
      throw new InvalidSourceReferenceError(
        "apiBaseUrl must not contain credentials",
      );
    }
    if (base.includes("..")) {
      throw new InvalidSourceReferenceError(
        "apiBaseUrl must not contain traversal",
      );
    }
  } catch (error) {
    if (
      error instanceof InvalidSourceReferenceError ||
      (error instanceof Error && error.name === "InvalidSourceReferenceError")
    ) {
      throw error;
    }
    throw new InvalidSourceReferenceError("invalid apiBaseUrl");
  }
  return base;
}

function buildGitHubHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "verify-agent",
  };
  if (token && token.trim().length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function throwForStatus(status: number, _bodyText?: string): never {
  if (status === 404) {
    throw new InvalidSourceReferenceError(
      "GitHub repository or commit not found",
    );
  }
  // 403 may represent either authentication/authorization failure or rate limiting;
  // future retry/rate-limit handling can inspect GitHub rate-limit headers.
  if (status === 401 || status === 403) {
    throw new GitHubAuthenticationError("GitHub authentication failed");
  }
  if (status === 429) {
    throw new GitHubRateLimitError("GitHub rate limit exceeded");
  }
  throw new GitHubProviderError(`GitHub request failed with status ${status}`);
}

function isBinaryBuffer(buffer: Uint8Array): boolean {
  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function createGitHubApiSourceProvider(
  options: GitHubApiSourceProviderOptions = {},
): GitHubSourceProvider {
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new GitHubProviderError("fetch not available");
  }
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const retrievedAt = options.retrievedAt;

  const token = options.token;
  if (token && token.trim().length > 0) {
    const url = new URL(apiBaseUrl);
    if (url.protocol === "http:") {
      throw new InvalidSourceReferenceError("token must not be sent over http");
    }
  }

  return {
    async resolveSnapshot(
      reference: GitHubSnapshotReference,
    ): Promise<ResolvedSource> {
      validateGitHubSnapshotReference(reference);
      const owner = reference.owner;
      const repository = reference.repository;
      const requestedSha = reference.sha.toLowerCase();
      const headers = buildGitHubHeaders(token);
      const base = apiBaseUrl;

      let commitSha: string;
      try {
        const commitUrl = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/commits/${encodeURIComponent(requestedSha)}`;
        const response = await fetchFn(commitUrl, {
          method: "GET",
          headers,
          redirect: "error",
        });
        if (!response.ok) {
          throwForStatus(response.status);
        }
        const data = (await response.json()) as { sha?: string };
        const resolvedSha =
          typeof data.sha === "string" ? data.sha.toLowerCase() : "";
        if (!SHA_RE.test(resolvedSha)) {
          throw new GitHubProviderError("invalid commit sha from GitHub");
        }
        if (resolvedSha !== requestedSha) {
          throw new InvalidSourceReferenceError(
            `requested SHA ${requestedSha} does not match resolved ${resolvedSha}`,
          );
        }
        commitSha = resolvedSha;
      } catch (error) {
        if (
          error instanceof InvalidSourceReferenceError ||
          error instanceof GitHubAuthenticationError ||
          error instanceof GitHubRateLimitError ||
          error instanceof GitHubProviderError ||
          (error instanceof Error &&
            (error.name === "InvalidSourceReferenceError" ||
              error.name === "GitHubAuthenticationError" ||
              error.name === "GitHubRateLimitError" ||
              error.name === "GitHubProviderError"))
        ) {
          throw error;
        }
        throw new GitHubProviderError("GitHub commit request failed");
      }

      let treeEntries: Array<{
        path?: string;
        mode?: string;
        type?: string;
        sha?: string;
        size?: number;
      }>;
      try {
        const treeUrl = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${encodeURIComponent(requestedSha)}?recursive=1`;
        const response = await fetchFn(treeUrl, {
          method: "GET",
          headers,
          redirect: "error",
        });
        if (!response.ok) {
          throwForStatus(response.status);
        }
        const data = (await response.json()) as {
          sha?: string;
          tree?: Array<{
            path?: string;
            mode?: string;
            type?: string;
            sha?: string;
            size?: number;
          }>;
          truncated?: boolean;
        };
        if (data.truncated) {
          throw new GitHubProviderError(
            "GitHub tree truncated - repository too large",
          );
        }
        if (!Array.isArray(data.tree)) {
          throw new GitHubProviderError("invalid GitHub tree response");
        }
        if (data.tree.length > maxFiles * 2) {
          throw new GitHubProviderError(
            `source tree too large: ${data.tree.length} > ${maxFiles * 2}`,
          );
        }
        treeEntries = data.tree;
      } catch (error) {
        if (
          error instanceof InvalidSourceReferenceError ||
          error instanceof GitHubAuthenticationError ||
          error instanceof GitHubRateLimitError ||
          error instanceof GitHubProviderError ||
          (error instanceof Error &&
            (error.name === "InvalidSourceReferenceError" ||
              error.name === "GitHubAuthenticationError" ||
              error.name === "GitHubRateLimitError" ||
              error.name === "GitHubProviderError"))
        ) {
          throw error;
        }
        throw new GitHubProviderError("GitHub tree request failed");
      }

      const blobs = treeEntries.filter(
        (entry) =>
          entry.type === "blob" &&
          typeof entry.path === "string" &&
          typeof entry.sha === "string",
      );

      if (blobs.length > maxFiles) {
        throw new GitHubProviderError(
          `source file limit exceeded: ${blobs.length} > ${maxFiles}`,
        );
      }

      const contents: Record<string, string> = {};
      let totalBytes = 0;

      const sortedBlobs = [...blobs].sort((a, b) =>
        (a.path ?? "").localeCompare(b.path ?? ""),
      );

      for (const entry of sortedBlobs) {
        const path = entry.path as string;
        const blobSha = entry.sha as string;

        if (!SHA_RE.test(blobSha)) {
          throw new GitHubProviderError(
            `invalid blob sha for ${path}: ${blobSha}`,
          );
        }

        try {
          normalizePath(path);
        } catch {
          throw new GitHubProviderError(`unsafe path in GitHub tree: ${path}`);
        }
        if (
          path.startsWith("/") ||
          path.includes("..") ||
          path.includes("\\") ||
          path.includes("//")
        ) {
          throw new GitHubProviderError(`unsafe path in GitHub tree: ${path}`);
        }

        const blobUrl = `${base}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/blobs/${encodeURIComponent(blobSha)}`;
        let blobData: {
          content?: string;
          encoding?: string;
          size?: number;
          sha?: string;
        };
        try {
          const response = await fetchFn(blobUrl, {
            method: "GET",
            headers,
            redirect: "error",
          });
          if (!response.ok) {
            throwForStatus(response.status);
          }
          blobData = (await response.json()) as {
            content?: string;
            encoding?: string;
            size?: number;
            sha?: string;
          };
        } catch (error) {
          if (
            error instanceof InvalidSourceReferenceError ||
            error instanceof GitHubAuthenticationError ||
            error instanceof GitHubRateLimitError ||
            error instanceof GitHubProviderError ||
            (error instanceof Error &&
              (error.name === "InvalidSourceReferenceError" ||
                error.name === "GitHubAuthenticationError" ||
                error.name === "GitHubRateLimitError" ||
                error.name === "GitHubProviderError"))
          ) {
            throw error;
          }
          throw new GitHubProviderError("GitHub blob request failed");
        }

        const size = typeof blobData.size === "number" ? blobData.size : 0;
        if (size > maxFileBytes) {
          throw new GitHubProviderError(
            `file too large: ${path} (${size} > ${maxFileBytes})`,
          );
        }

        const encoding = blobData.encoding ?? "base64";
        const rawContent = blobData.content ?? "";
        if (encoding !== "base64") {
          throw new GitHubProviderError(
            `unsupported blob encoding for ${path}: ${encoding}`,
          );
        }

        const cleaned = rawContent.replace(/\s/g, "");
        if (
          cleaned.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)
        ) {
          throw new GitHubProviderError(`invalid base64 for ${path}`);
        }
        let buffer: Buffer;
        try {
          buffer = Buffer.from(cleaned, "base64");
        } catch {
          throw new GitHubProviderError(`invalid base64 for ${path}`);
        }

        if (buffer.length > maxFileBytes) {
          throw new GitHubProviderError(`file too large after decode: ${path}`);
        }

        totalBytes += buffer.length;
        if (totalBytes > maxTotalBytes) {
          throw new GitHubProviderError(
            `total source bytes exceeded: ${totalBytes} > ${maxTotalBytes}`,
          );
        }

        if (isBinaryBuffer(buffer)) {
          continue;
        }

        let text: string;
        try {
          text = buffer.toString("utf8");
        } catch {
          continue;
        }

        if (text.includes("\u0000")) {
          continue;
        }

        contents[path] = text;
      }

      const frozenContents = freezeSourceContents(contents);
      const snapshot = createGitHubRepositorySnapshot(
        { kind: "github-snapshot", owner, repository, sha: commitSha },
        retrievedAt ? { retrievedAt } : undefined,
      );

      return {
        snapshot: cloneSnapshot(snapshot),
        sourceContents: cloneSourceContents(frozenContents),
      };
    },
  };
}
