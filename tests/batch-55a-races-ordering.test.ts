/**
 * Batch 55A — races and ordering (Finding 3).
 *
 * - Test I: concurrent first publication for the same repo+SHA+check
 *   creates exactly one Check Run (POST x1, then PATCH).
 * - Test J: newer result wins (older then newer → final is newer).
 * - Test K: stale result cannot overwrite (newer then older → older
 *   rejected before network, final stays newer).
 * - Test L: different SHAs are independent (concurrent A+B → two runs).
 * - Test M: same result repeated is deterministic (POST x1, PATCH x1).
 *
 * Freshness uses VerifyAgent's own createdAt + contentHash; GitHub Check
 * Run IDs are never freshness markers. Deterministic controlled double,
 * no live GitHub.
 */

import { describe, expect, it } from "vitest";
import { brandId } from "../packages/domain/src/index.js";
import type {
  RepositorySnapshot,
  VerificationResult,
  VerificationStatus,
} from "../packages/domain/src/index.js";
import {
  StaleVerificationResultError,
  VERIFY_AGENT_CHECK_NAME,
  createGitHubCheckPublisher,
  type GitHubCheckPublisher,
} from "../packages/adapters-source/src/github-checks.js";

const OWNER = "octocat";
const REPO = "hello-world";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const INSTALLATION_TOKEN = "batch55a-test-installation-token";
const APP_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";

function snapshot(sha: string): RepositorySnapshot {
  return {
    id: brandId<"RepositorySnapshotId">(`${OWNER}--${REPO}--${sha}`),
    projectId: brandId<"ProjectId">(`${OWNER}--${REPO}`),
    source: { provider: "github", reference: sha },
    sourceState: { type: "commit", value: sha },
    commitSha: sha,
    retrievedAt: "2026-09-28T00:00:00.000Z",
  };
}

function result(
  status: VerificationStatus,
  sha: string,
  options?: { readonly createdAt?: string; readonly contentHash?: string },
): VerificationResult {
  return {
    id: brandId<"VerificationId">(`verification-${status}-${sha.slice(0, 8)}`),
    requestId: brandId<"VerificationRequestId">("request-1"),
    jobId: brandId<"VerificationJobId">("job-1"),
    projectId: brandId<"ProjectId">(`${OWNER}--${REPO}`),
    snapshotId: brandId<"RepositorySnapshotId">(`${OWNER}--${REPO}--${sha}`),
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
    summary: `${status}: test`,
    resultVersion: "1.0.0",
    contentHash:
      options?.contentHash ?? `${status}-${sha.slice(0, 8)}`.padEnd(64, "0"),
    createdAt: options?.createdAt ?? "2026-09-28T00:00:00.000Z",
  };
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** Batch 55D — numeric ID of the configured VerifyAgent App in this file. */
const OWN_APP_ID = 123456;

function createDouble() {
  const calls: RecordedCall[] = [];
  let nextId = 101;
  const existing: {
    id: number;
    headSha: string;
    externalId?: string | undefined;
    appId?: number | undefined;
  }[] = [];
  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const fetch = (async (url: unknown, init?: Record<string, unknown>) => {
    const method = String(
      (init?.method as string | undefined) ?? "GET",
    ).toUpperCase();
    const urlText = String(url);
    calls.push({
      method,
      url: urlText,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (method === "GET" && urlText.includes("/check-runs")) {
      const shaMatch = urlText.match(/\/commits\/([0-9a-f]{40})\/check-runs/i);
      const scoped = shaMatch
        ? existing.filter(
            (run) => run.headSha === (shaMatch[1] as string).toLowerCase(),
          )
        : existing;
      return json(200, {
        total_count: scoped.length,
        check_runs: scoped.map((run) => ({
          id: run.id,
          name: VERIFY_AGENT_CHECK_NAME,
          head_sha: run.headSha,
          external_id: run.externalId ?? null,
          app: run.appId === undefined ? null : { id: run.appId },
        })),
      });
    }
    if (method === "POST" && urlText.endsWith("/check-runs")) {
      const id = nextId;
      nextId += 1;
      const body = JSON.parse(String(init?.body)) as {
        head_sha?: unknown;
        external_id?: unknown;
      };
      existing.push({
        id,
        headSha:
          typeof body.head_sha === "string" ? body.head_sha.toLowerCase() : "",
        externalId:
          typeof body.external_id === "string" ? body.external_id : undefined,
        appId: OWN_APP_ID,
      });
      return json(201, { id, name: VERIFY_AGENT_CHECK_NAME });
    }
    const patchMatch = urlText.match(/\/check-runs\/(\d+)$/);
    if (method === "PATCH" && patchMatch) {
      const id = Number(patchMatch[1]);
      const known = existing.find((run) => run.id === id);
      if (!known) {
        return json(404, { message: "Not Found" });
      }
      const body = JSON.parse(String(init?.body)) as {
        external_id?: unknown;
      };
      if (typeof body.external_id === "string") {
        known.externalId = body.external_id;
      }
      return json(200, { id, name: VERIFY_AGENT_CHECK_NAME });
    }
    return json(404, { message: "Not Found" });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, existing };
}

const appDeps = {
  appConfig: { appId: String(OWN_APP_ID), privateKey: APP_PRIVATE_KEY },
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

const REPO_REF = { owner: OWNER, name: REPO };

describe("Batch 55A — races and ordering", () => {
  it("Test I — concurrent first publication creates one run", async () => {
    const double = createDouble();
    const pub = publisherFor(double);
    const input = {
      result: result("pass", SHA_A, {
        createdAt: "2026-09-28T00:00:01.000Z",
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    };
    const [first, second] = await Promise.all([
      pub.publishVerificationResult(input),
      pub.publishVerificationResult(input),
    ]);
    const posts = double.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    // Second concurrent caller updates the same run rather than creating.
    expect(second.checkRunId).toBe(first.checkRunId);
    expect(double.existing.filter((run) => run.headSha === SHA_A)).toHaveLength(
      1,
    );
  });

  it("Test J — newer result wins", async () => {
    const double = createDouble();
    const pub = publisherFor(double);
    const older = await pub.publishVerificationResult({
      result: result("pass", SHA_A, {
        createdAt: "2026-09-28T00:00:01.000Z",
        contentHash: "a".repeat(64),
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(older.conclusion).toBe("success");
    const newer = await pub.publishVerificationResult({
      result: result("blocked", SHA_A, {
        createdAt: "2026-09-28T00:00:02.000Z",
        contentHash: "b".repeat(64),
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(newer.checkRunId).toBe(older.checkRunId);
    expect(newer.conclusion).toBe("failure");
    expect(newer.created).toBe(false);
  });

  it("Test K — stale result cannot overwrite newer", async () => {
    const double = createDouble();
    const pub = publisherFor(double);
    const newer = await pub.publishVerificationResult({
      result: result("blocked", SHA_A, {
        createdAt: "2026-09-28T00:00:02.000Z",
        contentHash: "b".repeat(64),
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    const callsBefore = double.calls.length;
    await expect(
      pub.publishVerificationResult({
        result: result("pass", SHA_A, {
          createdAt: "2026-09-28T00:00:01.000Z",
          contentHash: "a".repeat(64),
        }),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    // Refused before network: no additional GitHub calls.
    expect(double.calls.length).toBe(callsBefore);
    // Final state still represents the newer result: a repeat of the newer
    // result updates the same run with the newer conclusion.
    const repeat = await pub.publishVerificationResult({
      result: result("blocked", SHA_A, {
        createdAt: "2026-09-28T00:00:02.000Z",
        contentHash: "b".repeat(64),
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(repeat.checkRunId).toBe(newer.checkRunId);
    expect(repeat.conclusion).toBe("failure");
  });

  it("Test L — different commits are independent", async () => {
    const double = createDouble();
    const pub = publisherFor(double);
    const [forA, forB] = await Promise.all([
      pub.publishVerificationResult({
        result: result("pass", SHA_A, {
          createdAt: "2026-09-28T00:00:01.000Z",
        }),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      }),
      pub.publishVerificationResult({
        result: result("blocked", SHA_B, {
          createdAt: "2026-09-28T00:00:01.000Z",
        }),
        snapshot: snapshot(SHA_B),
        repository: REPO_REF,
      }),
    ]);
    expect(forA.headSha).toBe(SHA_A);
    expect(forB.headSha).toBe(SHA_B);
    expect(forA.checkRunId).not.toBe(forB.checkRunId);
    expect(forA.conclusion).toBe("success");
    expect(forB.conclusion).toBe("failure");
    expect(double.calls.filter((call) => call.method === "POST")).toHaveLength(
      2,
    );
  });

  it("Test M — same result repeated is deterministic", async () => {
    const double = createDouble();
    const pub = publisherFor(double);
    const input = {
      result: result("pass", SHA_A, {
        createdAt: "2026-09-28T00:00:01.000Z",
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    };
    const first = await pub.publishVerificationResult(input);
    expect(first.created).toBe(true);
    const second = await pub.publishVerificationResult(input);
    expect(second.created).toBe(false);
    expect(second.checkRunId).toBe(first.checkRunId);
    expect(double.calls.filter((call) => call.method === "POST")).toHaveLength(
      1,
    );
    expect(double.calls.filter((call) => call.method === "PATCH")).toHaveLength(
      1,
    );
  });
});
