/**
 * Batch 55A — identity binding (Finding 2).
 *
 * Proves `publishVerificationResult` rejects BEFORE any GitHub network
 * access when result/snapshot/repository/SHA do not describe the same
 * immutable source:
 *
 * - result A + snapshot A + repository A → allowed;
 * - result A + snapshot B → rejected, 0 network calls;
 * - result A + repository B → rejected, 0 network calls;
 * - result A + commit B (expectedHeadSha) → rejected, 0 network calls;
 * - snapshot commit != snapshot source reference → rejected, 0 calls;
 * - snapshot repository != supplied repository → rejected, 0 calls;
 * - snapshot missing commitSha → rejected, 0 calls;
 * - result.projectId != snapshot.projectId → rejected, 0 calls;
 * - non-github provider / non-commit state → rejected, 0 calls.
 *
 * No live GitHub, no network, no sandbox.
 */

import { describe, expect, it } from "vitest";
import { brandId } from "../packages/domain/src/index.js";
import type {
  RepositorySnapshot,
  VerificationResult,
  VerificationStatus,
} from "../packages/domain/src/index.js";
import {
  GitHubCheckPublicationError,
  StaleVerificationResultError,
  createGitHubCheckPublisher,
  type GitHubCheckPublisher,
} from "../packages/adapters-source/src/github-checks.js";

const OWNER_A = "octocat";
const REPO_A = "hello-world";
const OWNER_B = "other-owner";
const REPO_B = "other-repo";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const INSTALLATION_TOKEN = "batch55a-test-installation-token";
const APP_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";

function snapshotFor(
  owner: string,
  repo: string,
  sha: string,
): RepositorySnapshot {
  return {
    id: brandId<"RepositorySnapshotId">(`${owner}--${repo}--${sha}`),
    projectId: brandId<"ProjectId">(`${owner}--${repo}`),
    source: { provider: "github", reference: sha },
    sourceState: { type: "commit", value: sha },
    commitSha: sha,
    retrievedAt: "2026-09-28T00:00:00.000Z",
  };
}

function resultFor(
  owner: string,
  repo: string,
  sha: string,
  status: VerificationStatus = "pass",
): VerificationResult {
  return {
    id: brandId<"VerificationId">(`verification-${sha.slice(0, 8)}`),
    requestId: brandId<"VerificationRequestId">("request-1"),
    jobId: brandId<"VerificationJobId">("job-1"),
    projectId: brandId<"ProjectId">(`${owner}--${repo}`),
    snapshotId: brandId<"RepositorySnapshotId">(`${owner}--${repo}--${sha}`),
    changeSetId: brandId<"ChangeSetId">("changeset-1"),
    status,
    coverage: {
      verified: [],
      partial: [],
      unsupported: [],
      notApplicable: [],
      simulated: [],
      fixture: [],
    },
    checkResults: [],
    evidenceReferences: [],
    findingReferences: [],
    policyDecision: brandId<"PolicyDecisionId">("policy-1"),
    summary: `${status}: ok`,
    resultVersion: "1.0.0",
    contentHash: "c".repeat(64),
    createdAt: "2026-09-28T00:00:00.000Z",
  };
}

function createDouble() {
  const calls: { method: string; url: string }[] = [];
  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const fetch = (async (url: unknown, init?: Record<string, unknown>) => {
    const method = String(
      (init?.method as string | undefined) ?? "GET",
    ).toUpperCase();
    calls.push({ method, url: String(url) });
    if (method === "GET") {
      return json(200, { total_count: 0, check_runs: [] });
    }
    return json(201, { id: 101, name: "VerifyAgent / verification" });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const appDeps = {
  appConfig: { appId: "123456", privateKey: APP_PRIVATE_KEY },
  installationResolver: {
    async resolveInstallationId() {
      return 4242;
    },
  },
  installationTokenClient: {
    async createInstallationToken() {
      return {
        token: INSTALLATION_TOKEN,
        expiresAt: "2030-01-01T00:00:00.000Z",
      };
    },
  },
};

function publisherFor(
  double: ReturnType<typeof createDouble>,
): GitHubCheckPublisher {
  return createGitHubCheckPublisher({ ...appDeps, fetch: double.fetch });
}

describe("Batch 55A — identity binding", () => {
  it("result A + snapshot A + repository A → allowed", async () => {
    const double = createDouble();
    const publication = await publisherFor(double).publishVerificationResult({
      result: resultFor(OWNER_A, REPO_A, SHA_A),
      snapshot: snapshotFor(OWNER_A, REPO_A, SHA_A),
      repository: { owner: OWNER_A, name: REPO_A },
      expectedHeadSha: SHA_A,
    });
    expect(publication.headSha).toBe(SHA_A);
    expect(double.calls.length).toBeGreaterThan(0);
  });

  it("result A + snapshot B → rejected before network", async () => {
    const double = createDouble();
    await expect(
      publisherFor(double).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: snapshotFor(OWNER_A, REPO_A, SHA_B),
        repository: { owner: OWNER_A, name: REPO_A },
      }),
    ).rejects.toBeInstanceOf(GitHubCheckPublicationError);
    expect(double.calls).toHaveLength(0);
  });

  it("result A + repository B → rejected before network", async () => {
    const double = createDouble();
    await expect(
      publisherFor(double).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: snapshotFor(OWNER_A, REPO_A, SHA_A),
        repository: { owner: OWNER_B, name: REPO_B },
      }),
    ).rejects.toBeInstanceOf(GitHubCheckPublicationError);
    expect(double.calls).toHaveLength(0);
  });

  it("result A + commit B (expectedHeadSha) → rejected before network", async () => {
    const double = createDouble();
    await expect(
      publisherFor(double).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: snapshotFor(OWNER_A, REPO_A, SHA_A),
        repository: { owner: OWNER_A, name: REPO_A },
        expectedHeadSha: SHA_B,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    expect(double.calls).toHaveLength(0);
  });

  it("snapshot commit != snapshot source reference → rejected", async () => {
    const double = createDouble();
    const bad: RepositorySnapshot = {
      ...snapshotFor(OWNER_A, REPO_A, SHA_A),
      source: { provider: "github", reference: SHA_B },
    };
    await expect(
      publisherFor(double).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: bad,
        repository: { owner: OWNER_A, name: REPO_A },
      }),
    ).rejects.toBeInstanceOf(GitHubCheckPublicationError);
    expect(double.calls).toHaveLength(0);
  });

  it("snapshot commitSha != sourceState → rejected", async () => {
    const double = createDouble();
    const bad: RepositorySnapshot = {
      ...snapshotFor(OWNER_A, REPO_A, SHA_A),
      commitSha: SHA_B,
    };
    await expect(
      publisherFor(double).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: bad,
        repository: { owner: OWNER_A, name: REPO_A },
      }),
    ).rejects.toBeInstanceOf(GitHubCheckPublicationError);
    expect(double.calls).toHaveLength(0);
  });

  it("snapshot repository != supplied repository → rejected", async () => {
    const double = createDouble();
    await expect(
      publisherFor(double).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: snapshotFor(OWNER_B, REPO_B, SHA_A),
        repository: { owner: OWNER_A, name: REPO_A },
      }),
    ).rejects.toBeInstanceOf(GitHubCheckPublicationError);
    expect(double.calls).toHaveLength(0);
  });

  it("snapshot missing commitSha → rejected before network", async () => {
    const double = createDouble();
    const { commitSha: _omitted, ...rest } = snapshotFor(
      OWNER_A,
      REPO_A,
      SHA_A,
    );
    void _omitted;
    await expect(
      publisherFor(double).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: rest as RepositorySnapshot,
        repository: { owner: OWNER_A, name: REPO_A },
      }),
    ).rejects.toBeInstanceOf(GitHubCheckPublicationError);
    expect(double.calls).toHaveLength(0);
  });

  it("result.projectId != snapshot.projectId → rejected", async () => {
    const double = createDouble();
    const res = {
      ...resultFor(OWNER_A, REPO_A, SHA_A),
      projectId: brandId<"ProjectId">(`${OWNER_B}--${REPO_B}`),
    };
    await expect(
      publisherFor(double).publishVerificationResult({
        result: res,
        snapshot: snapshotFor(OWNER_A, REPO_A, SHA_A),
        repository: { owner: OWNER_A, name: REPO_A },
      }),
    ).rejects.toBeInstanceOf(GitHubCheckPublicationError);
    expect(double.calls).toHaveLength(0);
  });

  it("non-github provider and non-commit state → rejected", async () => {
    const double = createDouble();
    const badProvider: RepositorySnapshot = {
      ...snapshotFor(OWNER_A, REPO_A, SHA_A),
      source: { provider: "local", reference: SHA_A },
    };
    await expect(
      publisherFor(double).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: badProvider,
        repository: { owner: OWNER_A, name: REPO_A },
      }),
    ).rejects.toBeInstanceOf(GitHubCheckPublicationError);
    expect(double.calls).toHaveLength(0);

    const double2 = createDouble();
    const badState: RepositorySnapshot = {
      ...snapshotFor(OWNER_A, REPO_A, SHA_A),
      sourceState: { type: "snapshot", value: SHA_A },
    };
    await expect(
      publisherFor(double2).publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: badState,
        repository: { owner: OWNER_A, name: REPO_A },
      }),
    ).rejects.toThrow();
    expect(double2.calls).toHaveLength(0);
  });

  it("rejections expose no secrets", async () => {
    const double = createDouble();
    const error = await publisherFor(double)
      .publishVerificationResult({
        result: resultFor(OWNER_A, REPO_A, SHA_A),
        snapshot: snapshotFor(OWNER_A, REPO_A, SHA_B),
        repository: { owner: OWNER_A, name: REPO_A },
      })
      .catch((cause: unknown) => cause as Error);
    const text = `${error.name}: ${error.message}`;
    for (const forbidden of [
      INSTALLATION_TOKEN,
      APP_PRIVATE_KEY,
      "PRIVATE KEY",
      "Bearer",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    expect(double.calls).toHaveLength(0);
  });
});
