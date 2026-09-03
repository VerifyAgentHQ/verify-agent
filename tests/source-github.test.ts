import { describe, expect, it } from "vitest";
import {
  createGitHubRepositorySnapshot,
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
  createSingleGitHubFixtureProvider,
  decodeGitHubSnapshotReference,
  encodeGitHubSnapshotReference,
  validateGitHubSnapshotReference,
} from "../packages/adapters-source/src/github.js";
import { InvalidSourceReferenceError } from "../packages/adapters-source/src/resolver.js";
import { createVerificationApi } from "../apps/api/src/index.js";
import { request as httpRequest } from "node:http";

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const SHA_UPPER = SHA.toUpperCase();

const VALID_REFERENCE = {
  kind: "github-snapshot" as const,
  owner: OWNER,
  repository: REPOSITORY,
  sha: SHA,
};

const FIXTURE_CONTENTS = {
  "package.json": JSON.stringify({ name: "fixture" }, null, 2),
  "tsconfig.json": JSON.stringify(
    { compilerOptions: { target: "ES2022" } },
    null,
    2,
  ),
  "src/index.ts": "export const value = 42;\n",
};

describe("GitHub source provider contract", () => {
  it("returns deterministic snapshot and source contents for a known reference", async () => {
    const provider = createSingleGitHubFixtureProvider({
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA,
      sourceContents: FIXTURE_CONTENTS,
    });
    const result = await provider.resolveSnapshot(VALID_REFERENCE);

    expect(result.snapshot.source.provider).toBe("github");
    expect(result.snapshot.source.reference).toBe(SHA);
    expect(result.snapshot.sourceState).toEqual({ type: "commit", value: SHA });
    expect(result.snapshot.commitSha).toBe(SHA);
    expect(result.snapshot.projectId).toBe(`${OWNER}--${REPOSITORY}`);
    expect(result.snapshot.id).toBe(`${OWNER}--${REPOSITORY}--${SHA}`);
    expect(result.sourceContents).toEqual(FIXTURE_CONTENTS);
    expect(result.snapshot.retrievedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("normalizes SHA casing deterministically", async () => {
    const provider = createSingleGitHubFixtureProvider({
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA,
      sourceContents: FIXTURE_CONTENTS,
    });
    const lower = await provider.resolveSnapshot(VALID_REFERENCE);
    const upper = await provider.resolveSnapshot({
      kind: "github-snapshot",
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA_UPPER,
    });
    expect(upper.snapshot.source.reference).toBe(SHA);
    expect(upper.snapshot.commitSha).toBe(SHA);
    expect(upper.sourceContents).toEqual(lower.sourceContents);
    expect(upper.snapshot.id).toBe(lower.snapshot.id);
  });

  it("produces deterministic data for the same reference on repeated resolves", async () => {
    const provider = createSingleGitHubFixtureProvider({
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA,
      sourceContents: FIXTURE_CONTENTS,
    });
    const first = await provider.resolveSnapshot(VALID_REFERENCE);
    const second = await provider.resolveSnapshot(VALID_REFERENCE);

    expect(first.snapshot).toEqual(second.snapshot);
    expect(first.sourceContents).toEqual(second.sourceContents);
    expect(first.snapshot).not.toBe(second.snapshot);
    expect(first.sourceContents).not.toBe(second.sourceContents);
  });

  it("rejects unknown repository/sha with InvalidSourceReferenceError", async () => {
    const provider = createSingleGitHubFixtureProvider({
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA,
      sourceContents: FIXTURE_CONTENTS,
    });
    await expect(
      provider.resolveSnapshot({
        kind: "github-snapshot",
        owner: "unknown",
        repository: "repo",
        sha: SHA,
      }),
    ).rejects.toBeInstanceOf(InvalidSourceReferenceError);

    await expect(
      provider.resolveSnapshot({
        kind: "github-snapshot",
        owner: OWNER,
        repository: REPOSITORY,
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).rejects.toBeInstanceOf(InvalidSourceReferenceError);
  });

  it("validates GitHub reference shape and rejects branches, URLs, and paths", () => {
    expect(() =>
      validateGitHubSnapshotReference({
        kind: "github-snapshot",
        owner: "owner/with-slash",
        repository: REPOSITORY,
        sha: SHA,
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      validateGitHubSnapshotReference({
        kind: "github-snapshot",
        owner: OWNER,
        repository: REPOSITORY,
        sha: "main",
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      validateGitHubSnapshotReference({
        kind: "github-snapshot",
        owner: OWNER,
        repository: REPOSITORY,
        sha: "https://github.com/octocat/hello-world",
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      validateGitHubSnapshotReference({
        kind: "github-snapshot",
        owner: "/etc/passwd",
        repository: REPOSITORY,
        sha: SHA,
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      validateGitHubSnapshotReference({
        kind: "github-snapshot",
        owner: OWNER,
        repository: "../evil",
        sha: SHA,
      }),
    ).toThrow(InvalidSourceReferenceError);
  });

  it("rejects source contents with absolute or traversal paths at fixture creation", () => {
    expect(() =>
      createInMemoryGitHubSourceProvider([
        {
          reference: VALID_REFERENCE,
          sourceContents: { "/absolute/path.ts": "evil" },
        },
      ]),
    ).toThrow();

    expect(() =>
      createInMemoryGitHubSourceProvider([
        {
          reference: VALID_REFERENCE,
          sourceContents: { "../traversal.ts": "evil" },
        },
      ]),
    ).toThrow();

    expect(() =>
      createInMemoryGitHubSourceProvider([
        {
          reference: VALID_REFERENCE,
          sourceContents: { "a/../b.ts": "evil" },
        },
      ]),
    ).toThrow();

    expect(() =>
      createInMemoryGitHubSourceProvider([
        {
          reference: VALID_REFERENCE,
          sourceContents: { "C:\\Windows\\file.ts": "evil" },
        },
      ]),
    ).toThrow();
  });

  it("exposes only repository-relative paths and prevents mutation", async () => {
    const provider = createSingleGitHubFixtureProvider({
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA,
      sourceContents: FIXTURE_CONTENTS,
    });
    const result = await provider.resolveSnapshot(VALID_REFERENCE);

    expect(Object.keys(result.sourceContents)).toEqual(
      expect.arrayContaining(["package.json", "tsconfig.json", "src/index.ts"]),
    );
    for (const key of Object.keys(result.sourceContents)) {
      expect(key.startsWith("/")).toBe(false);
      expect(key.includes("..")).toBe(false);
      expect(key.includes("\\")).toBe(false);
    }

    const mutated = result.sourceContents as Record<string, string>;
    try {
      (mutated as Record<string, string>)["evil.ts"] = "injected";
    } catch {
      // frozen objects throw in strict mode – expected
    }

    const second = await provider.resolveSnapshot(VALID_REFERENCE);
    expect(second.sourceContents["evil.ts"]).toBeUndefined();
    expect(second.sourceContents).toEqual(FIXTURE_CONTENTS);

    expect(Object.isFrozen(result.sourceContents)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it("creates deterministic snapshot with expected domain fields", () => {
    const snapshot = createGitHubRepositorySnapshot(VALID_REFERENCE);
    expect(snapshot.source.provider).toBe("github");
    expect(snapshot.source.reference).toBe(SHA);
    expect(snapshot.sourceState).toEqual({ type: "commit", value: SHA });
    expect(snapshot.commitSha).toBe(SHA);
    expect(snapshot.retrievedAt).toBe("2024-01-01T00:00:00.000Z");
    expect(snapshot.projectId).toBe(`${OWNER}--${REPOSITORY}`);
    expect(snapshot.id).toBe(`${OWNER}--${REPOSITORY}--${SHA}`);
  });

  it("encodes and decodes snapshot id without allowing URLs or paths", () => {
    const encoded = encodeGitHubSnapshotReference(VALID_REFERENCE);
    expect(encoded).toBe(`${OWNER}:${REPOSITORY}:${SHA}`);
    expect(decodeGitHubSnapshotReference(encoded)).toEqual({
      kind: "github-snapshot",
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA,
    });

    expect(() =>
      decodeGitHubSnapshotReference("https://github.com/o/r"),
    ).toThrow(InvalidSourceReferenceError);
    expect(() => decodeGitHubSnapshotReference("/tmp/evil")).toThrow(
      InvalidSourceReferenceError,
    );
    expect(() => decodeGitHubSnapshotReference("../evil:repo:sha")).toThrow(
      InvalidSourceReferenceError,
    );
    expect(() => decodeGitHubSnapshotReference("owner:repo:not-a-sha")).toThrow(
      InvalidSourceReferenceError,
    );
  });
});

describe("GitHub adapter contract", () => {
  it("satisfies provider-neutral SourceResolver without changing its semantics", async () => {
    const githubProvider = createSingleGitHubFixtureProvider({
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA,
      sourceContents: FIXTURE_CONTENTS,
    });
    const resolver = createGitHubSourceResolver(githubProvider);

    const encoded = encodeGitHubSnapshotReference(VALID_REFERENCE);
    const result = await resolver.resolveSnapshot({
      kind: "snapshot",
      id: encoded,
    });

    expect(result.snapshot.source.provider).toBe("github");
    expect(result.sourceContents).toEqual(FIXTURE_CONTENTS);

    await expect(
      resolver.resolveSnapshot({ kind: "snapshot", id: "invalid:id:zzz" }),
    ).rejects.toBeInstanceOf(InvalidSourceReferenceError);

    await expect(
      resolver.resolveSnapshot({
        kind: "snapshot",
        id: encodeGitHubSnapshotReference({
          kind: "github-snapshot",
          owner: "unknown",
          repository: "x",
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
      }),
    ).rejects.toBeInstanceOf(InvalidSourceReferenceError);
  });

  it("can be composed with createVerificationApi via DI", async () => {
    const githubProvider = createSingleGitHubFixtureProvider({
      owner: OWNER,
      repository: REPOSITORY,
      sha: SHA,
      sourceContents: FIXTURE_CONTENTS,
    });
    const resolver = createGitHubSourceResolver(githubProvider);

    let received: unknown;
    const api = createVerificationApi(
      {
        async verify(input) {
          received = input;
          return {
            status: "pass",
            coverage: {
              verified: [],
              partial: [],
              unsupported: [],
              notApplicable: [],
            },
            checkResults: [],
            findingReferences: [],
            evidenceReferences: [],
            policyDecision: "pass",
            summary: "ok",
            resultVersion: "1.0.0",
            contentHash: "hash",
            createdAt: "2024-01-01T00:00:00Z",
          };
        },
      },
      resolver,
    );

    await new Promise<void>((resolve, reject) =>
      api.server.listen(0, "127.0.0.1", () => resolve()),
    );
    const address = api.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    const encoded = encodeGitHubSnapshotReference(VALID_REFERENCE);

    const result = await new Promise<{
      status: number;
      body: Record<string, unknown>;
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          port: (address as { port: number }).port,
          method: "POST",
          path: "/verify",
          headers: { "content-type": "application/json" },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ) as Record<string, unknown>,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ source: { kind: "snapshot", id: encoded } }));
    });

    await api.close();
    expect(result.status).toBe(200);
    expect(
      (
        received as { detectionContext: { readFile: (p: string) => string } }
      ).detectionContext.readFile("package.json"),
    ).toBe(FIXTURE_CONTENTS["package.json"]);
    expect(
      (received as { snapshot: { source: { provider: string } } }).snapshot
        .source.provider,
    ).toBe("github");
  });

  it("supports multiple fixtures deterministically", async () => {
    const sha2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const provider = createInMemoryGitHubSourceProvider([
      { reference: VALID_REFERENCE, sourceContents: FIXTURE_CONTENTS },
      {
        reference: {
          kind: "github-snapshot",
          owner: OWNER,
          repository: REPOSITORY,
          sha: sha2,
        },
        sourceContents: { "package.json": "second" },
      },
    ]);
    const first = await provider.resolveSnapshot(VALID_REFERENCE);
    const second = await provider.resolveSnapshot({
      kind: "github-snapshot",
      owner: OWNER,
      repository: REPOSITORY,
      sha: sha2,
    });
    expect(first.sourceContents["package.json"]).toContain("fixture");
    expect(second.sourceContents["package.json"]).toBe("second");
    const firstAgain = await provider.resolveSnapshot(VALID_REFERENCE);
    expect(firstAgain.sourceContents).toEqual(first.sourceContents);
  });
});
