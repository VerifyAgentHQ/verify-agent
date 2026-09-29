/**
 * Batch 55D — GitHub Check Run ownership validation.
 *
 * The publisher trusts or updates an existing Check Run ONLY when that run
 * belongs to the configured VerifyAgent GitHub App (`app.id` match):
 *
 * - A: a foreign-App run (even with a valid-looking marker) cannot control
 *      freshness — it is ignored and VerifyAgent mints its own run.
 * - B: a foreign run with an artificially newer marker cannot cause stale
 *      rejection of the VerifyAgent result.
 * - C: PATCH never targets a foreign run ID.
 * - D: a VerifyAgent-owned run keeps full Batch 55C freshness behavior
 *      (older rejected, same idempotent, newer updated).
 * - E: with foreign (larger ID) + owned (smaller ID) runs present, the
 *      owned run is selected — max ID applies only within owned runs.
 * - F: invalid App configuration fails closed at construction, before any
 *      network access.
 *
 * The double faithfully stamps `app.id` (creating App on POST, per-run
 * `app.id` on list) so ownership is genuinely distinguished. No live
 * GitHub.
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
  VERIFY_AGENT_CHECK_NAME,
  createGitHubCheckPublisher,
  type GitHubCheckPublisher,
} from "../packages/adapters-source/src/github-checks.js";

const OWNER = "octocat";
const REPO = "hello-world";
const SHA_A = "a".repeat(40);
const OWN_APP_ID = 123456;
const FOREIGN_APP_ID = 999999;
const INSTALLATION_TOKEN = "batch55d-test-installation-token";
const APP_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";
const AT_NEWER = "2026-09-28T00:00:02.000Z";
const AT_OLDER = "2026-09-28T00:00:01.000Z";
const HASH_NEWER = "b".repeat(64);
const HASH_OLDER = "a".repeat(64);
const MARKER_NEWER = `verifyagent:v1:${Date.parse(AT_NEWER)}:${HASH_NEWER}`;
const MARKER_OLDER = `verifyagent:v1:${Date.parse(AT_OLDER)}:${HASH_OLDER}`;

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

const newerFor = (sha: string) =>
  result("blocked", sha, { createdAt: AT_NEWER, contentHash: HASH_NEWER });
const olderFor = (sha: string) =>
  result("pass", sha, { createdAt: AT_OLDER, contentHash: HASH_OLDER });

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

interface SeededRun {
  readonly id: number;
  readonly headSha: string;
  readonly externalId?: string | undefined;
  readonly appId?: number | undefined;
}

function createDouble(seeded: readonly SeededRun[] = []) {
  const calls: RecordedCall[] = [];
  let nextId = 701;
  const existing: {
    id: number;
    headSha: string;
    externalId?: string;
    appId?: number;
  }[] = seeded.map((run) => ({
    id: run.id,
    headSha: run.headSha,
    externalId: run.externalId,
    appId: run.appId,
  }));
  for (const run of seeded) {
    if (run.id >= nextId) nextId = run.id + 1;
  }
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
      if (!known) return json(404, { message: "Not Found" });
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

function patchTargets(calls: readonly RecordedCall[]): number[] {
  return calls
    .filter((call) => call.method === "PATCH")
    .map((call) => Number(call.url.match(/\/check-runs\/(\d+)$/)?.[1]));
}

describe("Batch 55D — Check Run ownership validation", () => {
  it("A — foreign-App run cannot control freshness; VerifyAgent mints its own run", async () => {
    // Foreign run carries a valid but stale marker for the same SHA/name.
    const double = createDouble([
      {
        id: 701,
        headSha: SHA_A,
        externalId: MARKER_OLDER,
        appId: FOREIGN_APP_ID,
      },
    ]);
    const publication = await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    // The foreign run was ignored: a new VerifyAgent-owned run created.
    expect(publication.created).toBe(true);
    expect(publication.checkRunId).not.toBe(701);
    expect(patchTargets(double.calls)).toHaveLength(0);
    const created = double.existing.find(
      (run) => run.id === publication.checkRunId,
    );
    expect(created?.appId).toBe(OWN_APP_ID);
    expect(created?.externalId).toBe(MARKER_NEWER);
    // The foreign run is byte-for-byte untouched.
    expect(double.existing.find((run) => run.id === 701)).toMatchObject({
      externalId: MARKER_OLDER,
      appId: FOREIGN_APP_ID,
    });
  });

  it("B — foreign-App newer marker cannot cause stale rejection", async () => {
    // Foreign run claims a far-future marker; VerifyAgent's own newer
    // result must NOT be rejected because of it.
    const double = createDouble([
      {
        id: 702,
        headSha: SHA_A,
        externalId: `verifyagent:v1:${Date.parse("2030-01-01T00:00:00.000Z")}:${"f".repeat(64)}`,
        appId: FOREIGN_APP_ID,
      },
    ]);
    const publication = await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(publication.created).toBe(true);
    expect(publication.checkRunId).not.toBe(702);
  });

  it("C — PATCH never targets a foreign run ID", async () => {
    const double = createDouble([
      {
        id: 703,
        headSha: SHA_A,
        externalId: MARKER_OLDER,
        appId: FOREIGN_APP_ID,
      },
    ]);
    await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    // Second publication updates the owned run; the foreign ID is never
    // PATCHed even though it shares repository/SHA/name.
    await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(patchTargets(double.calls)).not.toContain(703);
    const foreign = double.existing.find((run) => run.id === 703);
    expect(foreign?.externalId).toBe(MARKER_OLDER);
  });

  it("D — VerifyAgent-owned run keeps full freshness behavior", async () => {
    const double = createDouble([
      {
        id: 704,
        headSha: SHA_A,
        externalId: MARKER_NEWER,
        appId: OWN_APP_ID,
      },
    ]);
    const pub = publisherFor(double);
    // Older → rejected.
    await expect(
      pub.publishVerificationResult({
        result: olderFor(SHA_A),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    // Same → idempotent update of the owned run.
    const same = await pub.publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(same.created).toBe(false);
    expect(same.checkRunId).toBe(704);
    // Newer → updated with the replaced marker.
    const AT_TOP = "2026-09-29T00:00:00.000Z";
    const HASH_TOP = "c".repeat(64);
    const newer = await pub.publishVerificationResult({
      result: result("blocked", SHA_A, {
        createdAt: AT_TOP,
        contentHash: HASH_TOP,
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(newer.checkRunId).toBe(704);
    expect(double.existing.find((run) => run.id === 704)?.externalId).toBe(
      `verifyagent:v1:${Date.parse(AT_TOP)}:${HASH_TOP}`,
    );
  });

  it("E — owned run wins over foreign run with a larger ID", async () => {
    const double = createDouble([
      {
        id: 705,
        headSha: SHA_A,
        externalId: MARKER_NEWER,
        appId: OWN_APP_ID,
      },
      {
        id: 799,
        headSha: SHA_A,
        externalId: MARKER_OLDER,
        appId: FOREIGN_APP_ID,
      },
    ]);
    // Same-marker repeat must PATCH the owned smaller-ID run, never the
    // foreign larger-ID run that max-ID-without-ownership would pick.
    const same = await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(same.checkRunId).toBe(705);
    expect(patchTargets(double.calls)).toEqual([705]);
  });

  it("F — invalid App configuration fails closed before any network", async () => {
    const double = createDouble();
    for (const badAppId of ["", "   ", "not-numeric", "12.5", "-7"]) {
      const callsBefore = double.calls.length;
      expect(() =>
        createGitHubCheckPublisher({
          ...appDeps,
          appConfig: { ...appDeps.appConfig, appId: badAppId },
          fetch: double.fetch,
        }),
      ).toThrow(GitHubCheckPublicationError);
      expect(double.calls.length).toBe(callsBefore);
    }
    // Missing config likewise fails closed with no network use.
    expect(() => createGitHubCheckPublisher({} as never)).toThrow(
      GitHubCheckPublicationError,
    );
  });

  it("run without App info is treated as foreign (ignored, never trusted)", async () => {
    const double = createDouble([{ id: 706, headSha: SHA_A }]);
    const publication = await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(publication.created).toBe(true);
    expect(publication.checkRunId).not.toBe(706);
    expect(patchTargets(double.calls)).toHaveLength(0);
  });
});
