/**
 * Batch 55C — persistent GitHub Check freshness marker.
 *
 * Every created/updated Check Run carries a versioned freshness marker in
 * `external_id` (`verifyagent:v1:<createdAtMs>:<contentHash>`). The remote
 * marker — not the bounded local LRU — is the restart/eviction-safe
 * freshness authority:
 *
 * - A: new Check Runs include the expected versioned marker (no secrets).
 * - B: valid markers parse; malformed/unknown markers never parse.
 * - C: newer via instance 1, older via fresh instance 2 → stale rejection
 *      with zero update mutation.
 * - D: tiny local LRU evicts A, yet old A is still rejected via remote.
 * - E: destroyed/recreated publisher still rejects older results.
 * - F: same result across restart stays idempotent on one Check Run.
 * - G: genuinely newer result after restart updates and replaces marker.
 * - H: existing run without external_id → fail closed, no update.
 * - I: existing run with malformed external_id → fail closed, no update.
 * - J: A and B markers stay independent.
 *
 * The controlled double persists `external_id` as the external GitHub
 * state shared across publisher instances; freshness is never faked
 * inside the test process. No live GitHub.
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
  compareVerificationFreshness,
  createGitHubCheckPublisher,
  formatVerificationFreshnessMarker,
  parseVerificationFreshnessMarker,
  type GitHubCheckPublisher,
} from "../packages/adapters-source/src/github-checks.js";

const OWNER = "octocat";
const REPO = "hello-world";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const INSTALLATION_TOKEN = "batch55c-test-installation-token";
const APP_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";
const AT_NEWER = "2026-09-28T00:00:02.000Z";
const AT_OLDER = "2026-09-28T00:00:01.000Z";
const HASH_NEWER = "b".repeat(64);
const HASH_OLDER = "a".repeat(64);

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

const newerFor = (sha: string, status: VerificationStatus = "blocked") =>
  result(status, sha, { createdAt: AT_NEWER, contentHash: HASH_NEWER });
const olderFor = (sha: string, status: VerificationStatus = "pass") =>
  result(status, sha, { createdAt: AT_OLDER, contentHash: HASH_OLDER });

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

/** Batch 55D — numeric ID of the configured VerifyAgent App in this file. */
const OWN_APP_ID = 123456;

/**
 * The double's `existing` array IS the external GitHub state: it persists
 * `external_id` across publisher instances. Freshness is read from that
 * state, never from test-process memory.
 */
function createDouble(seeded: readonly SeededRun[] = []) {
  const calls: RecordedCall[] = [];
  let nextId = 501;
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
  options?: { readonly maxFreshnessEntries?: number },
): GitHubCheckPublisher {
  return createGitHubCheckPublisher({
    ...appDeps,
    fetch: double.fetch,
    ...(options?.maxFreshnessEntries === undefined
      ? {}
      : { maxFreshnessEntries: options.maxFreshnessEntries }),
  });
}

const REPO_REF = { owner: OWNER, name: REPO };

function mutations(calls: readonly RecordedCall[]): RecordedCall[] {
  return calls.filter(
    (call) => call.method === "POST" || call.method === "PATCH",
  );
}

describe("Batch 55C — persistent freshness marker", () => {
  it("A — new Check Runs include the expected versioned marker", async () => {
    const double = createDouble();
    const publication = await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(publication.created).toBe(true);
    const posts = double.calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    const body = posts[0]?.body as { external_id?: unknown };
    const expected = `verifyagent:v1:${Date.parse(AT_NEWER)}:${HASH_NEWER}`;
    expect(body.external_id).toBe(expected);
    // The marker carries ordering only — no secrets, paths, or tokens.
    for (const forbidden of [
      INSTALLATION_TOKEN,
      APP_PRIVATE_KEY,
      "PRIVATE KEY",
      "Bearer",
      "node_modules",
    ]) {
      expect(String(body.external_id)).not.toContain(forbidden);
    }
    expect(double.existing).toHaveLength(1);
    expect(double.existing[0]?.externalId).toBe(expected);
  });

  it("B — marker parsing accepts valid markers and rejects the rest", () => {
    const ordering = {
      createdAtMs: 1720000000000,
      contentHash: "c".repeat(64),
    };
    const marker = formatVerificationFreshnessMarker(ordering);
    expect(marker).toBe(`verifyagent:v1:1720000000000:${"c".repeat(64)}`);
    expect(parseVerificationFreshnessMarker(marker)).toEqual(ordering);
    expect(compareVerificationFreshness(ordering, ordering)).toBe(0);
    expect(
      compareVerificationFreshness(
        { createdAtMs: 1, contentHash: "a".repeat(64) },
        { createdAtMs: 2, contentHash: "a".repeat(64) },
      ),
    ).toBe(-1);
    expect(
      compareVerificationFreshness(
        { createdAtMs: 2, contentHash: "b".repeat(64) },
        { createdAtMs: 2, contentHash: "a".repeat(64) },
      ),
    ).toBe(1);
    for (const bad of [
      "",
      "not-a-marker",
      "verifyagent:v1",
      "verifyagent:v1:123",
      "verifyagent:v1:123:abc:extra",
      "other:v1:123:abc",
      "verifyagent:v2:123:abc",
      "verifyagent:v1:notanumber:abc",
      "verifyagent:v1:-5:abc",
      "verifyagent:v1:123:",
      "verifyagent:v1:123:has space",
      "verifyagent:v1:123:has:colon",
      `verifyagent:v1:123:${"x".repeat(257)}`,
      "x".repeat(513),
      null,
      undefined,
      42,
      {},
    ]) {
      expect(parseVerificationFreshnessMarker(bad)).toBeNull();
    }
    expect(() =>
      formatVerificationFreshnessMarker({
        createdAtMs: 123,
        contentHash: "has:colon",
      }),
    ).toThrow(GitHubCheckPublicationError);
  });

  it("C — older result via a fresh instance is rejected with no mutation", async () => {
    const double = createDouble();
    const first = publisherFor(double);
    const created = await first.publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(created.created).toBe(true);
    const mutationsBefore = mutations(double.calls).length;
    // Fresh instance: no local memory of the newer result.
    const second = publisherFor(double);
    await expect(
      second.publishVerificationResult({
        result: olderFor(SHA_A),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    // The lookup happened, but nothing was created or updated.
    expect(mutations(double.calls).length).toBe(mutationsBefore);
    expect(double.existing).toHaveLength(1);
    expect(double.existing[0]?.id).toBe(created.checkRunId);
  });

  it("D — evicted local entries still reject via the remote marker", async () => {
    const double = createDouble();
    const pub = publisherFor(double, { maxFreshnessEntries: 2 });
    const shaC = "c".repeat(40);
    for (const [sha, at] of [
      [SHA_A, "2026-09-28T00:00:01.000Z"],
      [SHA_B, "2026-09-28T00:00:02.000Z"],
      [shaC, "2026-09-28T00:00:03.000Z"],
    ] as const) {
      await pub.publishVerificationResult({
        result: result("pass", sha, { createdAt: at }),
        snapshot: snapshot(sha),
        repository: REPO_REF,
      });
    }
    // SHA_A's local entry was evicted (bound 2), but the remote marker
    // still rejects its older result.
    const mutationsBefore = mutations(double.calls).length;
    await expect(
      pub.publishVerificationResult({
        result: result("pass", SHA_A, {
          createdAt: "2026-09-28T00:00:00.500Z",
          contentHash: "9".repeat(64),
        }),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    expect(mutations(double.calls).length).toBe(mutationsBefore);
  });

  it("E — destroyed and recreated publisher still rejects older results", async () => {
    const double = createDouble();
    let pub: GitHubCheckPublisher | undefined = publisherFor(double);
    await pub.publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    pub = undefined;
    const recreated = publisherFor(double);
    const mutationsBefore = mutations(double.calls).length;
    await expect(
      recreated.publishVerificationResult({
        result: olderFor(SHA_A),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    expect(mutations(double.calls).length).toBe(mutationsBefore);
    // The persisted newer marker is intact.
    expect(double.existing[0]?.externalId).toBe(
      `verifyagent:v1:${Date.parse(AT_NEWER)}:${HASH_NEWER}`,
    );
  });

  it("F — same result across restart stays idempotent on one run", async () => {
    const double = createDouble();
    const input = {
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    };
    const first = await publisherFor(double).publishVerificationResult(input);
    expect(first.created).toBe(true);
    const second = await publisherFor(double).publishVerificationResult(input);
    expect(second.created).toBe(false);
    expect(second.checkRunId).toBe(first.checkRunId);
    expect(double.calls.filter((call) => call.method === "POST")).toHaveLength(
      1,
    );
    expect(double.existing).toHaveLength(1);
    expect(double.existing[0]?.externalId).toBe(
      `verifyagent:v1:${Date.parse(AT_NEWER)}:${HASH_NEWER}`,
    );
  });

  it("G — genuinely newer result after restart updates and replaces the marker", async () => {
    const double = createDouble();
    await publisherFor(double).publishVerificationResult({
      result: olderFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    const updated = await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A, "blocked"),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    expect(updated.created).toBe(false);
    expect(updated.conclusion).toBe("failure");
    expect(double.existing).toHaveLength(1);
    expect(double.existing[0]?.externalId).toBe(
      `verifyagent:v1:${Date.parse(AT_NEWER)}:${HASH_NEWER}`,
    );
  });

  it("H — existing run without external_id fails closed with no update", async () => {
    // Batch 55D — the seed is VerifyAgent-owned (app.id matches) but has
    // no marker, exercising the missing-marker fail-closed path.
    const double = createDouble([
      { id: 601, headSha: SHA_A, appId: OWN_APP_ID },
    ]);
    const mutationsBefore = mutations(double.calls).length;
    const error = await publisherFor(double)
      .publishVerificationResult({
        result: newerFor(SHA_A),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GitHubCheckPublicationError);
    expect(error).not.toBeInstanceOf(StaleVerificationResultError);
    expect(mutations(double.calls).length).toBe(mutationsBefore);
    expect(double.existing).toHaveLength(1);
    expect(double.existing[0]?.externalId).toBeUndefined();
  });

  it("I — existing run with malformed external_id fails closed with no update", async () => {
    for (const badMarker of [
      "not-a-marker",
      "verifyagent:v2:1720000000000:abc",
      `verifyagent:v1:notanumber:${"a".repeat(64)}`,
    ]) {
      const double = createDouble([
        { id: 602, headSha: SHA_A, externalId: badMarker, appId: OWN_APP_ID },
      ]);
      const mutationsBefore = mutations(double.calls).length;
      const error = await publisherFor(double)
        .publishVerificationResult({
          result: newerFor(SHA_A),
          snapshot: snapshot(SHA_A),
          repository: REPO_REF,
        })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(GitHubCheckPublicationError);
      expect(mutations(double.calls).length).toBe(mutationsBefore);
      expect(double.existing[0]?.externalId).toBe(badMarker);
    }
  });

  it("J — cross-SHA markers stay independent", async () => {
    const double = createDouble();
    await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    await publisherFor(double).publishVerificationResult({
      result: olderFor(SHA_B),
      snapshot: snapshot(SHA_B),
      repository: REPO_REF,
    });
    // Stale for A never touches B: B still accepts its own newer result.
    await expect(
      publisherFor(double).publishVerificationResult({
        result: olderFor(SHA_A),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    const updatedB = await publisherFor(double).publishVerificationResult({
      result: newerFor(SHA_B, "blocked"),
      snapshot: snapshot(SHA_B),
      repository: REPO_REF,
    });
    expect(updatedB.headSha).toBe(SHA_B);
    expect(updatedB.conclusion).toBe("failure");
    expect(double.existing).toHaveLength(2);
  });
});
