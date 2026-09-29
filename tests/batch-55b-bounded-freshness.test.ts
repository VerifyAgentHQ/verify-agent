/**
 * Batch 55B — bounded freshness state (Blocking 2).
 *
 * The process-local `latestByKey` map is bounded (`maxFreshnessEntries`,
 * LRU eviction) while preserving stale-result semantics for retained keys:
 *
 * - A: newer then older → older rejected (retained key protection).
 * - B: same result repeated → one logical Check Run (idempotent).
 * - C: different SHAs publish independently.
 * - D: more entries than the bound evicts least-recently-published keys;
 *      retained keys still reject stale results. Batch 55C: evicted keys
 *      keep protection via the persisted remote `external_id` marker.
 * - E: many sequential publishes across many keys keep working (no
 *      serialization/freshness bookkeeping leak wedges the publisher).
 * - F: Batch 55C — freshness survives publisher restart via the remote
 *      marker (serialization itself stays process-local).
 * - Invalid bounds throw fail-closed at construction.
 *
 * Deterministic controlled double, no live GitHub.
 */

import { describe, expect, it } from "vitest";
import { brandId } from "../packages/domain/src/index.js";
import type {
  RepositorySnapshot,
  VerificationResult,
  VerificationStatus,
} from "../packages/domain/src/index.js";
import {
  DEFAULT_MAX_FRESHNESS_ENTRIES,
  GitHubCheckPublicationError,
  StaleVerificationResultError,
  VERIFY_AGENT_CHECK_NAME,
  createGitHubCheckPublisher,
  type GitHubCheckPublisher,
} from "../packages/adapters-source/src/github-checks.js";

const OWNER = "octocat";
const REPO = "hello-world";
const INSTALLATION_TOKEN = "batch55b-test-installation-token";
const APP_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);

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
  const hash =
    options?.contentHash ?? `${status}-${sha.slice(0, 8)}`.padEnd(64, "0");
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
    contentHash: hash,
    createdAt: options?.createdAt ?? "2026-09-28T00:00:00.000Z",
  };
}

/** Batch 55D — numeric ID of the configured VerifyAgent App in this file. */
const OWN_APP_ID = 123456;

function createDouble() {
  const calls: { method: string; url: string }[] = [];
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
    calls.push({ method, url: urlText });
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
      if (known !== undefined) {
        const body = JSON.parse(String(init?.body)) as {
          external_id?: unknown;
        };
        if (typeof body.external_id === "string") {
          known.externalId = body.external_id;
        }
      }
      return json(200, {
        id: Number(patchMatch[1]),
        name: VERIFY_AGENT_CHECK_NAME,
      });
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

describe("Batch 55B — bounded freshness state", () => {
  it("default bound is a sane positive integer", () => {
    expect(Number.isInteger(DEFAULT_MAX_FRESHNESS_ENTRIES)).toBe(true);
    expect(DEFAULT_MAX_FRESHNESS_ENTRIES).toBeGreaterThan(0);
  });

  it("invalid bounds throw fail-closed at construction", () => {
    const double = createDouble();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        createGitHubCheckPublisher({
          ...appDeps,
          fetch: double.fetch,
          maxFreshnessEntries: bad,
        }),
      ).toThrow(GitHubCheckPublicationError);
    }
    expect(double.calls).toHaveLength(0);
  });

  it("A — retained key still rejects stale results", async () => {
    const double = createDouble();
    const pub = publisherFor(double, { maxFreshnessEntries: 3 });
    await pub.publishVerificationResult({
      result: result("blocked", SHA_A, {
        createdAt: "2026-09-28T00:00:02.000Z",
        contentHash: "b".repeat(64),
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    const before = double.calls.length;
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
    expect(double.calls.length).toBe(before);
  });

  it("B — same result repeated stays idempotent under a bound", async () => {
    const double = createDouble();
    const pub = publisherFor(double, { maxFreshnessEntries: 3 });
    const input = {
      result: result("pass", SHA_A, {
        createdAt: "2026-09-28T00:00:01.000Z",
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    };
    const first = await pub.publishVerificationResult(input);
    const second = await pub.publishVerificationResult(input);
    expect(second.checkRunId).toBe(first.checkRunId);
    expect(double.calls.filter((call) => call.method === "POST")).toHaveLength(
      1,
    );
  });

  it("C — different SHAs stay independent under a bound", async () => {
    const double = createDouble();
    const pub = publisherFor(double, { maxFreshnessEntries: 3 });
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
    expect(forA.checkRunId).not.toBe(forB.checkRunId);
    expect(double.calls.filter((call) => call.method === "POST")).toHaveLength(
      2,
    );
  });

  it("D — exceeding the bound evicts least-recently-published keys", async () => {
    const double = createDouble();
    const pub = publisherFor(double, { maxFreshnessEntries: 3 });
    // Fill the bound: A, B, C.
    for (const [sha, at] of [
      [SHA_A, "2026-09-28T00:00:01.000Z"],
      [SHA_B, "2026-09-28T00:00:02.000Z"],
      [SHA_C, "2026-09-28T00:00:03.000Z"],
    ] as const) {
      await pub.publishVerificationResult({
        result: result("pass", sha, { createdAt: at }),
        snapshot: snapshot(sha),
        repository: REPO_REF,
      });
    }
    // D evicts A (least recently published).
    await pub.publishVerificationResult({
      result: result("pass", SHA_D, {
        createdAt: "2026-09-28T00:00:04.000Z",
      }),
      snapshot: snapshot(SHA_D),
      repository: REPO_REF,
    });
    // Retained key C still rejects its stale predecessor: no network.
    const before = double.calls.length;
    await expect(
      pub.publishVerificationResult({
        result: result("blocked", SHA_C, {
          createdAt: "2026-09-28T00:00:02.500Z",
          contentHash: "0".repeat(64),
        }),
        snapshot: snapshot(SHA_C),
        repository: REPO_REF,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    expect(double.calls.length).toBe(before);
    // Batch 55C — evicted key A keeps protection via the persisted
    // remote marker: its older result consults the Check Run's external_id
    // and is rejected as stale even though the local LRU forgot it.
    const beforeEvicted = double.calls.length;
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
    // Rejected after reading the remote marker: a lookup happened, but no
    // mutation (no PATCH/POST) touched the existing Check Run.
    const extra = double.calls.slice(beforeEvicted);
    expect(extra.some((call) => call.method === "GET")).toBe(true);
    expect(extra.some((call) => call.method !== "GET")).toBe(false);
  });

  it("E — many sequential keys keep working (no bookkeeping leak)", async () => {
    const double = createDouble();
    const pub = publisherFor(double, { maxFreshnessEntries: 3 });
    for (let i = 0; i < 10; i += 1) {
      const sha = `${i.toString(16).padStart(2, "0")}`.padEnd(40, "0");
      const publication = await pub.publishVerificationResult({
        result: result("pass", sha, {
          createdAt: `2026-09-28T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
        snapshot: snapshot(sha),
        repository: REPO_REF,
      });
      expect(publication.headSha).toBe(sha);
    }
    expect(double.calls.filter((call) => call.method === "POST")).toHaveLength(
      10,
    );
  });

  it("F — Batch 55C: freshness survives publisher restart via the remote marker", async () => {
    const double = createDouble();
    const first = publisherFor(double);
    await first.publishVerificationResult({
      result: result("blocked", SHA_A, {
        createdAt: "2026-09-28T00:00:02.000Z",
        contentHash: "b".repeat(64),
      }),
      snapshot: snapshot(SHA_A),
      repository: REPO_REF,
    });
    // A fresh instance has no local memory, but the persisted remote
    // marker still rejects the older result: no update mutation occurs.
    const second = publisherFor(double);
    const callsBefore = double.calls.length;
    await expect(
      second.publishVerificationResult({
        result: result("pass", SHA_A, {
          createdAt: "2026-09-28T00:00:01.000Z",
          contentHash: "a".repeat(64),
        }),
        snapshot: snapshot(SHA_A),
        repository: REPO_REF,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    const extra = double.calls.slice(callsBefore);
    expect(extra.some((call) => call.method === "GET")).toBe(true);
    expect(extra.some((call) => call.method !== "GET")).toBe(false);
  });
});
