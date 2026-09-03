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
