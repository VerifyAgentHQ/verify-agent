/**
 * Batch 54 — SnapshotStorePublisher unit proof.
 *
 * The publisher decorates the existing `SourceResolver` abstraction:
 * exact acquired bytes are published under the exact commit SHA so the
 * external verify-sandbox materializes precisely the verified revision.
 *
 * These tests run on every platform with temporary directories only. They
 * never touch the real snapshot store, never spawn processes, and never
 * install dependencies.
 */

import { readFileSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { brandId } from "../packages/domain/src/index.js";
import type {
  RepositorySnapshot,
  SnapshotSourceReference,
  SourceResolver,
} from "../packages/domain/src/index.js";
import {
  SnapshotStorePublicationError,
  createSnapshotStorePublisher,
  deriveSnapshotStoreIdentity,
  readSnapshotStoreRoot,
} from "../packages/adapters-source/src/snapshot-store-publisher.js";
import { readGitHubToken } from "../packages/adapters-source/src/github.js";
import { readSandboxProcessEnvironment } from "../apps/api/src/index.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const publisherSource = readFileSync(
  join(
    repoRoot,
    "..",
    "packages",
    "adapters-source",
    "src",
    "snapshot-store-publisher.ts",
  ),
  "utf8",
);

const SHA_A = "a".repeat(40);
const OWNER = "octocat";
const REPOSITORY = "hello-world";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-agent-batch54-"));
  tempRoots.push(root);
  return root;
}

function githubSnapshot(sha: string, commitSha?: string): RepositorySnapshot {
  return {
    id: brandId<"RepositorySnapshotId">(`${OWNER}--${REPOSITORY}--${sha}`),
    projectId: brandId<"ProjectId">(`${OWNER}--${REPOSITORY}`),
    source: { provider: "github", reference: sha },
    sourceState: { type: "commit", value: sha },
    ...(commitSha === undefined ? {} : { commitSha }),
    retrievedAt: "2026-09-27T00:00:00.000Z",
  };
}

function githubSource(sha: string): SnapshotSourceReference {
  return { kind: "snapshot", id: `${OWNER}:${REPOSITORY}:${sha}` };
}

function stubResolver(
  snapshot: RepositorySnapshot,
  contents: Record<string, string>,
  seen: { count: number } = { count: 0 },
): SourceResolver {
  return {
    async resolveSnapshot() {
      seen.count += 1;
      return { snapshot, sourceContents: { ...contents } };
    },
  };
}

const FIXTURE_CONTENTS = Object.freeze({
  "package.json": JSON.stringify({ name: "batch54", private: true }),
  "src/index.ts": "export const value = 42;\n",
});

async function publishedFiles(root: string, sha: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await walk(join(directory, entry.name), relativePath);
      else found.push(relativePath);
    }
  }
  await walk(join(root, sha), "");
  return found.sort();
}

describe("Batch 54 — snapshot-store identity binding", () => {
  it("derives the lowercase commit SHA for GitHub references", () => {
    expect(
      deriveSnapshotStoreIdentity(
        githubSnapshot(SHA_A, SHA_A),
        githubSource(SHA_A),
      ),
    ).toBe(SHA_A);
    expect(
      deriveSnapshotStoreIdentity(
        githubSnapshot(SHA_A.toUpperCase(), SHA_A.toUpperCase()),
        githubSource(SHA_A),
      ),
    ).toBe(SHA_A);
  });

  it("rejects a resolved commit that differs from the requested HEAD", () => {
    const other = "b".repeat(40);
    expect(() =>
      deriveSnapshotStoreIdentity(
        githubSnapshot(other, other),
        githubSource(SHA_A),
      ),
    ).toThrow(/does not match the requested commit/);
  });

  it("rejects a commitSha that disagrees with the snapshot identity", () => {
    expect(() =>
      deriveSnapshotStoreIdentity(
        githubSnapshot(SHA_A, "b".repeat(40)),
        githubSource(SHA_A),
      ),
    ).toThrow(/commitSha/);
  });

  it("rejects non-SHA or unsafe sandbox identities", () => {
    for (const unsafe of [
      "main",
      "v1.0.0",
      "a".repeat(39),
      "g".repeat(40),
      "../escape",
      "a/b",
      ".",
      "..",
      "",
    ]) {
      expect(() =>
        deriveSnapshotStoreIdentity(
          {
            ...githubSnapshot(SHA_A),
            sourceState: { type: "commit", value: unsafe },
          },
          githubSource(SHA_A),
        ),
      ).toThrow();
    }
  });

  it("passes through sandbox-safe identities for non-GitHub sources", () => {
    const snapshot: RepositorySnapshot = {
      ...githubSnapshot(SHA_A),
      sourceState: { type: "snapshot", value: "snapshot-1" },
    };
    expect(
      deriveSnapshotStoreIdentity(snapshot, {
        kind: "snapshot",
        id: "fixture-snapshot-1",
      }),
    ).toBe("snapshot-1");
  });

  it("requires an absolute store root at construction", () => {
    const inner = stubResolver(githubSnapshot(SHA_A), { ...FIXTURE_CONTENTS });
    expect(() =>
      createSnapshotStorePublisher(inner, {
        snapshotStoreRoot: "relative/root",
      }),
    ).toThrow(/absolute/);
    expect(() =>
      createSnapshotStorePublisher(inner, { snapshotStoreRoot: "" }),
    ).toThrow();
    expect(() =>
      createSnapshotStorePublisher({} as never, {
        snapshotStoreRoot: join(tmpdir(), "x"),
      }),
    ).toThrow(/inner SourceResolver/);
  });
});

describe("Batch 54 — immutable publication", () => {
  it("publishes exact bytes under the commit SHA and returns the original snapshot", async () => {
    const root = await tempRoot();
    const snapshot = githubSnapshot(SHA_A, SHA_A);
    const inner = stubResolver(snapshot, { ...FIXTURE_CONTENTS });
    const publisher = createSnapshotStorePublisher(inner, {
      snapshotStoreRoot: root,
    });

    const resolved = await publisher.resolveSnapshot(githubSource(SHA_A));

    // The original snapshot object is returned unchanged.
    expect(resolved.snapshot).toBe(snapshot);
    expect(resolved.snapshot.sourceState.value).toBe(SHA_A);
    expect(await publishedFiles(root, SHA_A)).toEqual([
      "package.json",
      "src/index.ts",
    ]);
    expect(await readFile(join(root, SHA_A, "src", "index.ts"), "utf8")).toBe(
      FIXTURE_CONTENTS["src/index.ts"],
    );
  });

  it("creates a missing store root and republishes idempotently", async () => {
    const parent = await tempRoot();
    const root = join(parent, "nested", "store");
    const publisher = createSnapshotStorePublisher(
      stubResolver(githubSnapshot(SHA_A, SHA_A), { ...FIXTURE_CONTENTS }),
      { snapshotStoreRoot: root },
    );
    await publisher.resolveSnapshot(githubSource(SHA_A));
    const before = await readFile(join(root, SHA_A, "package.json"), "utf8");
    await publisher.resolveSnapshot(githubSource(SHA_A));
    expect(await readFile(join(root, SHA_A, "package.json"), "utf8")).toBe(
      before,
    );
    expect(await publishedFiles(root, SHA_A)).toEqual([
      "package.json",
      "src/index.ts",
    ]);
  });

  it("a different SHA creates a different snapshot directory", async () => {
    const root = await tempRoot();
    const shaB = "b".repeat(40);
    const publisher = createSnapshotStorePublisher(
      {
        async resolveSnapshot(source) {
          const sha = source.id.endsWith(SHA_A) ? SHA_A : shaB;
          return {
            snapshot: githubSnapshot(sha, sha),
            sourceContents: { "src/index.ts": `// ${sha}\n` },
          };
        },
      },
      { snapshotStoreRoot: root },
    );
    await publisher.resolveSnapshot(githubSource(SHA_A));
    await publisher.resolveSnapshot(githubSource(shaB));
    expect(
      await readFile(join(root, SHA_A, "src", "index.ts"), "utf8"),
    ).toContain(SHA_A);
    expect(
      await readFile(join(root, shaB, "src", "index.ts"), "utf8"),
    ).toContain(shaB);
  });

  it("refuses to overwrite an existing SHA directory with different contents", async () => {
    const root = await tempRoot();
    const first = createSnapshotStorePublisher(
      stubResolver(githubSnapshot(SHA_A, SHA_A), {
        "src/index.ts": "export const value = 1;\n",
      }),
      { snapshotStoreRoot: root },
    );
    await first.resolveSnapshot(githubSource(SHA_A));

    const second = createSnapshotStorePublisher(
      stubResolver(githubSnapshot(SHA_A, SHA_A), {
        "src/index.ts": "export const value = 2;\n",
      }),
      { snapshotStoreRoot: root },
    );
    await expect(second.resolveSnapshot(githubSource(SHA_A))).rejects.toThrow(
      SnapshotStorePublicationError,
    );
    // Original bytes are preserved byte-for-byte.
    expect(await readFile(join(root, SHA_A, "src", "index.ts"), "utf8")).toBe(
      "export const value = 1;\n",
    );
  });

  it("rejects unsafe content paths and publishes nothing", async () => {
    const root = await tempRoot();
    for (const unsafe of [
      "/absolute.ts",
      "../escape.ts",
      "a/../../escape.ts",
      "back\\slash.ts",
      "double//slash.ts",
      "trailing/",
      "",
    ]) {
      const publisher = createSnapshotStorePublisher(
        stubResolver(githubSnapshot(SHA_A, SHA_A), {
          [unsafe]: "evil",
        }),
        { snapshotStoreRoot: root },
      );
      await expect(
        publisher.resolveSnapshot(githubSource(SHA_A)),
      ).rejects.toThrow();
    }
    await expect(stat(join(root, SHA_A))).rejects.toThrow();
  });

  it("enforces file-count and byte budgets without partial publication", async () => {
    const root = await tempRoot();
    const tooMany: Record<string, string> = {};
    for (let index = 0; index < 4; index += 1) {
      tooMany[`file-${index}.txt`] = "x";
    }
    const counted = createSnapshotStorePublisher(
      stubResolver(githubSnapshot(SHA_A, SHA_A), tooMany),
      { snapshotStoreRoot: root, maxFiles: 3 },
    );
    await expect(counted.resolveSnapshot(githubSource(SHA_A))).rejects.toThrow(
      /file limit/,
    );
    const oversized = createSnapshotStorePublisher(
      stubResolver(githubSnapshot(SHA_A, SHA_A), {
        "big.txt": "x".repeat(16),
      }),
      { snapshotStoreRoot: root, maxTotalBytes: 15 },
    );
    await expect(
      oversized.resolveSnapshot(githubSource(SHA_A)),
    ).rejects.toThrow(/bytes exceeded/);
    await expect(stat(join(root, SHA_A))).rejects.toThrow();
  });

  it("treats a pre-existing symlinked tree as incompatible, never trusted", async () => {
    const root = await tempRoot();
    const destination = join(root, SHA_A);
    await fsMkdirs(destination);
    let symlinkSupported = true;
    try {
      await symlink(join("nowhere"), join(destination, "link"));
    } catch {
      symlinkSupported = false;
    }
    if (!symlinkSupported) return;
    const publisher = createSnapshotStorePublisher(
      stubResolver(githubSnapshot(SHA_A, SHA_A), { ...FIXTURE_CONTENTS }),
      { snapshotStoreRoot: root },
    );
    await expect(
      publisher.resolveSnapshot(githubSource(SHA_A)),
    ).rejects.toThrow(SnapshotStorePublicationError);
  });

  it("propagates inner resolution failures without publishing", async () => {
    const root = await tempRoot();
    const failing: SourceResolver = {
      async resolveSnapshot() {
        throw new Error("upstream unavailable");
      },
    };
    const publisher = createSnapshotStorePublisher(failing, {
      snapshotStoreRoot: root,
    });
    await expect(
      publisher.resolveSnapshot(githubSource(SHA_A)),
    ).rejects.toThrow("upstream unavailable");
    await expect(stat(join(root, SHA_A))).rejects.toThrow();
  });
});

async function fsMkdirs(path: string): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
}

describe("Batch 54 — configuration helpers", () => {
  it("readSnapshotStoreRoot returns the trimmed root or undefined", () => {
    expect(readSnapshotStoreRoot({})).toBeUndefined();
    expect(
      readSnapshotStoreRoot({ VERIFY_SANDBOX_SNAPSHOT_ROOT: "   " }),
    ).toBeUndefined();
    expect(
      readSnapshotStoreRoot({
        VERIFY_SANDBOX_SNAPSHOT_ROOT: "  /srv/snapshots  ",
      }),
    ).toBe("/srv/snapshots");
  });

  it("readGitHubToken returns the trimmed token or undefined", () => {
    expect(readGitHubToken({})).toBeUndefined();
    expect(readGitHubToken({ GITHUB_TOKEN: "   " })).toBeUndefined();
    expect(readGitHubToken({ GITHUB_TOKEN: "  ghs_test  " })).toBe("ghs_test");
  });

  it("readSandboxProcessEnvironment forwards only the established keys", () => {
    expect(
      readSandboxProcessEnvironment({
        VERIFY_SANDBOX_SNAPSHOT_ROOT: "/srv/snapshots",
        VERIFY_SANDBOX_DOCKER_EXECUTABLE: "/usr/bin/docker",
        VERIFY_SANDBOX_DOCKER_HOST: "npipe:////./pipe/docker_engine",
        VERIFY_SANDBOX_SYSTEM_ROOT: "C:\\Windows",
        VERIFY_SANDBOX_TEMP_ROOT: "/tmp/verify",
        GITHUB_TOKEN: "must-never-reach-sandbox",
        GITHUB_WEBHOOK_SECRET: "must-never-reach-sandbox",
        VERIFY_INTERNAL_RESULT_TOKEN: "must-never-reach-sandbox",
        PATH: "/usr/bin",
      }),
    ).toEqual({
      VERIFY_SANDBOX_SNAPSHOT_ROOT: "/srv/snapshots",
      VERIFY_SANDBOX_DOCKER_EXECUTABLE: "/usr/bin/docker",
      VERIFY_SANDBOX_DOCKER_HOST: "npipe:////./pipe/docker_engine",
      VERIFY_SANDBOX_SYSTEM_ROOT: "C:\\Windows",
      VERIFY_SANDBOX_TEMP_ROOT: "/tmp/verify",
    });
    expect(readSandboxProcessEnvironment({})).toEqual({});
  });

  it("the publisher performs no host installation, git, or process spawning", () => {
    for (const forbidden of [
      "child_process",
      "spawn(",
      "exec(",
      "execFile",
      "pnpm install",
      "npm install",
      "cargo fetch",
      "git clone",
      "git fetch",
      "git checkout",
      "fetch(",
      "https://",
      "http://",
    ]) {
      expect(publisherSource).not.toContain(forbidden);
    }
    expect(publisherSource).toContain("SourceResolver");
  });
});
