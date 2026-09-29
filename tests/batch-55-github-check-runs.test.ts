/**
 * Batch 55 — GitHub Check Run publication unit proof.
 *
 * Proves the VerificationResult → Check Run boundary against a controlled
 * GitHub Checks API double (App installation authentication only):
 *
 * - A: exact SHA binding (result for A publishes a Check Run for A);
 * - B: SHA mutation can never retarget A to B (refused before any network);
 * - C/D: passing → success, blocked/error → failure;
 * - E: partial coverage stays visibly partial, never a pass claim;
 * - F: output leaks no secrets, contents, or host paths;
 * - G: App installation authentication; token-mode fallback absent;
 * - H: GitHub API failure never mutates the result, never leaks tokens;
 * - I: deterministic create/update idempotency without a database.
 *
 * No live GitHub access, no network, no sandbox.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brandId } from "../packages/domain/src/index.js";
import type {
  CheckResult,
  RepositorySnapshot,
  VerificationResult,
  VerificationStatus,
} from "../packages/domain/src/index.js";
import {
  GitHubCheckPublicationError,
  StaleVerificationResultError,
  VERIFY_AGENT_CHECK_NAME,
  createGitHubCheckPublisher,
  mapVerificationStatusToCheckConclusion,
  renderVerificationCheckOutput,
  type GitHubCheckPublisher,
} from "../packages/adapters-source/src/github-checks.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const checksSource = readFileSync(
  join(
    repoRoot,
    "..",
    "packages",
    "adapters-source",
    "src",
    "github-checks.ts",
  ),
  "utf8",
);

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const INSTALLATION_TOKEN = "batch55-test-installation-token";
const PERSONAL_TOKEN = "batch55-test-personal-token";

const WEBHOOK_SECRET = "batch55-test-webhook-secret";
const APP_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";
const SOURCE_TEXT = "export const secret_value = 1;\n";
const HOST_PATH = "/tmp/verify-agent-internal";

function snapshot(sha: string): RepositorySnapshot {
  return {
    id: brandId<"RepositorySnapshotId">(`${OWNER}--${REPOSITORY}--${sha}`),
    projectId: brandId<"ProjectId">(`${OWNER}--${REPOSITORY}`),
    source: { provider: "github", reference: sha },
    sourceState: { type: "commit", value: sha },
    commitSha: sha,
    retrievedAt: "2026-09-28T00:00:00.000Z",
  };
}

function coverage(overrides: Partial<VerificationResult["coverage"]> = {}) {
  return {
    verified: [],
    partial: [],
    unsupported: [],
    notApplicable: [],
    simulated: [],
    fixture: [],
    ...overrides,
  };
}

function result(
  status: VerificationStatus,
  sha: string,
  coverageOverrides: Partial<VerificationResult["coverage"]> = {},
): VerificationResult {
  return {
    id: brandId<"VerificationId">(`verification-${status}-${sha.slice(0, 8)}`),
    requestId: brandId<"VerificationRequestId">("request-1"),
    jobId: brandId<"VerificationJobId">("job-1"),
    projectId: brandId<"ProjectId">(`${OWNER}--${REPOSITORY}`),
    snapshotId: brandId<"RepositorySnapshotId">(
      `${OWNER}--${REPOSITORY}--${sha}`,
    ),
    changeSetId: brandId<"ChangeSetId">("changeset-1"),
    status,
    coverage: coverage(coverageOverrides),
    checkResults: [],
    evidenceReferences: [],
    findingReferences: [],
    policyDecision: brandId<"PolicyDecisionId">("policy-1"),
    summary: `${status}: 2/3 checks passed.`,
    resultVersion: "1.0.0",
    contentHash: "c".repeat(64),
    createdAt: "2026-09-28T00:00:00.000Z",
  };
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** Batch 55D — numeric ID of the configured VerifyAgent App in this file. */
const OWN_APP_ID = 123456;

interface CheckDouble {
  readonly fetch: typeof globalThis.fetch;
  readonly calls: RecordedCall[];
  readonly createdIds: number[];
  existingRuns: {
    readonly id: number;
    readonly name: string;
    readonly headSha: string;
    externalId?: string | undefined;
    appId?: number | undefined;
  }[];
  failUpdateOnce: boolean;
  failCreateWith: number | undefined;
}

function createCheckDouble(): CheckDouble {
  const calls: RecordedCall[] = [];
  const createdIds: number[] = [];
  let nextId = 101;
  const state: CheckDouble = {
    fetch: (async (url: unknown, init?: Record<string, unknown>) => {
      const method = String(
        (init?.method as string | undefined) ?? "GET",
      ).toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const urlText = String(url);
      calls.push({
        method,
        url: urlText,
        authorization: headers.Authorization,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      const json = (status: number, body: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      });
      if (method === "GET" && urlText.includes("/check-runs")) {
        const shaMatch = urlText.match(
          /\/commits\/([0-9a-f]{40})\/check-runs/i,
        );
        const scoped = shaMatch
          ? state.existingRuns.filter(
              (run) => run.headSha === (shaMatch[1] as string).toLowerCase(),
            )
          : state.existingRuns;
        return json(200, {
          total_count: scoped.length,
          check_runs: scoped.map((run) => ({
            id: run.id,
            name: run.name,
            head_sha: run.headSha,
            external_id: run.externalId ?? null,
            // Batch 55D — faithful ownership: GitHub stamps the creating
            // App's ID; runs without known ownership report app null.
            app: run.appId === undefined ? null : { id: run.appId },
          })),
        });
      }
      if (method === "POST" && urlText.endsWith("/check-runs")) {
        if (state.failCreateWith !== undefined) {
          return json(state.failCreateWith, { message: "rejected" });
        }
        const id = nextId;
        nextId += 1;
        createdIds.push(id);
        const body = (
          init?.body === undefined ? {} : JSON.parse(String(init.body))
        ) as { head_sha?: unknown; external_id?: unknown };
        state.existingRuns.push({
          id,
          name: VERIFY_AGENT_CHECK_NAME,
          headSha:
            typeof body.head_sha === "string"
              ? body.head_sha.toLowerCase()
              : "",
          externalId:
            typeof body.external_id === "string" ? body.external_id : undefined,
          appId: OWN_APP_ID,
        });
        return json(201, { id, name: VERIFY_AGENT_CHECK_NAME });
      }
      const patchMatch = urlText.match(/\/check-runs\/(\d+)$/);
      if (method === "PATCH" && patchMatch) {
        const id = Number(patchMatch[1]);
        if (state.failUpdateOnce) {
          state.failUpdateOnce = false;
          return json(404, { message: "Not Found" });
        }
        const known = state.existingRuns.find((run) => run.id === id);
        if (!known) return json(404, { message: "Not Found" });
        const body = (
          init?.body === undefined ? {} : JSON.parse(String(init.body))
        ) as { external_id?: unknown };
        if (typeof body.external_id === "string") {
          known.externalId = body.external_id;
        }
        return json(200, { id, name: VERIFY_AGENT_CHECK_NAME });
      }
      return json(404, { message: "Not Found" });
    }) as unknown as typeof globalThis.fetch,
    calls,
    createdIds,
    existingRuns: [],
    failUpdateOnce: false,
    failCreateWith: undefined,
  };
  return state;
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

function publisher(double: CheckDouble): GitHubCheckPublisher {
  return createGitHubCheckPublisher({ ...appDeps, fetch: double.fetch });
}

const REPOSITORY_REF = { owner: OWNER, name: REPOSITORY };

describe("Batch 55 — conclusion mapping", () => {
  it("maps every verification status deterministically", () => {
    expect(mapVerificationStatusToCheckConclusion("pass")).toBe("success");
    expect(mapVerificationStatusToCheckConclusion("blocked")).toBe("failure");
    expect(mapVerificationStatusToCheckConclusion("error")).toBe("failure");
    expect(mapVerificationStatusToCheckConclusion("needs_changes")).toBe(
      "neutral",
    );
    expect(mapVerificationStatusToCheckConclusion("needs_review")).toBe(
      "neutral",
    );
    expect(mapVerificationStatusToCheckConclusion("partial")).toBe("neutral");
    expect(() =>
      mapVerificationStatusToCheckConclusion("bogus" as never),
    ).toThrow(GitHubCheckPublicationError);
  });

  it("uses one stable check name without job/branch/timestamp identity", () => {
    expect(VERIFY_AGENT_CHECK_NAME).toBe("VerifyAgent / verification");
    expect(VERIFY_AGENT_CHECK_NAME).not.toMatch(/[0-9a-f]{7,}/);
  });
});

describe("Batch 55 — exact SHA binding (A) and mutation safety (B)", () => {
  it("Test A — result for A publishes a Check Run for A", async () => {
    const double = createCheckDouble();
    const publication = await publisher(double).publishVerificationResult({
      result: result("partial", SHA_A, { verified: ["rust.check"] }),
      snapshot: snapshot(SHA_A),
      repository: REPOSITORY_REF,
      pullRequestNumber: 42,
    });
    expect(publication.headSha).toBe(SHA_A);
    expect(publication.created).toBe(true);
    const created = double.calls.find((call) => call.method === "POST");
    expect(created?.url).toContain(`/repos/${OWNER}/${REPOSITORY}/check-runs`);
    expect(created?.body).toMatchObject({
      name: VERIFY_AGENT_CHECK_NAME,
      head_sha: SHA_A,
      status: "completed",
    });
    const listed = double.calls.find((call) => call.method === "GET");
    expect(listed?.url).toContain(`/commits/${SHA_A}/check-runs`);
  });

  it("Test B — result for A can never publish against head B", async () => {
    const double = createCheckDouble();
    await expect(
      publisher(double).publishVerificationResult({
        result: result("pass", SHA_A, { verified: ["rust.check"] }),
        snapshot: snapshot(SHA_A),
        repository: REPOSITORY_REF,
        expectedHeadSha: SHA_B,
      }),
    ).rejects.toBeInstanceOf(StaleVerificationResultError);
    // Refused before any network: no lookup, no creation, no token use.
    expect(double.calls).toHaveLength(0);
  });

  it("Test B — a result whose snapshot disagrees with itself is rejected", async () => {
    const double = createCheckDouble();
    const mismatched: RepositorySnapshot = {
      ...snapshot(SHA_A),
      sourceState: { type: "commit", value: SHA_B },
    };
    await expect(
      publisher(double).publishVerificationResult({
        result: result("pass", SHA_A),
        snapshot: mismatched,
        repository: REPOSITORY_REF,
        expectedHeadSha: SHA_A,
      }),
    ).rejects.toThrow();
    expect(double.calls).toHaveLength(0);
  });
});

describe("Batch 55 — conclusions for passing, failing, and partial results", () => {
  it("Test C — passing result maps to a successful check", async () => {
    const double = createCheckDouble();
    const publication = await publisher(double).publishVerificationResult({
      result: result("pass", SHA_A, {
        verified: ["rust.check", "rust.clippy", "rust.test"],
      }),
      snapshot: snapshot(SHA_A),
      repository: REPOSITORY_REF,
    });
    expect(publication.conclusion).toBe("success");
    const created = double.calls.find((call) => call.method === "POST");
    expect(created?.body).toMatchObject({ conclusion: "success" });
    expect(JSON.stringify(created?.body)).toContain("rust.check");
  });

  it("Test D — blocked and errored results map to failure", async () => {
    for (const status of ["blocked", "error"] as const) {
      const double = createCheckDouble();
      const publication = await publisher(double).publishVerificationResult({
        result: result(status, SHA_A),
        snapshot: snapshot(SHA_A),
        repository: REPOSITORY_REF,
      });
      expect(publication.conclusion).toBe("failure");
      const created = double.calls.find((call) => call.method === "POST");
      expect(created?.body).toMatchObject({ conclusion: "failure" });
    }
  });

  it("Test E — partial coverage stays visibly partial, never a pass", async () => {
    const double = createCheckDouble();
    const publication = await publisher(double).publishVerificationResult({
      result: result("partial", SHA_A, {
        verified: ["typescript.typecheck"],
        partial: ["dependency.audit", "typescript.test"],
      }),
      snapshot: snapshot(SHA_A),
      repository: REPOSITORY_REF,
    });
    expect(publication.conclusion).toBe("neutral");
    const created = double.calls.find((call) => call.method === "POST");
    const serialized = JSON.stringify(created?.body);
    expect(serialized).toContain("dependency.audit");
    expect(serialized).toContain("not a pass");
    expect(serialized).not.toContain("all repository guarantees passed");
  });

  it("per-check enrichment lines appear only when provided", () => {
    const check: CheckResult = {
      id: brandId<"CheckResultId">("check-result-1"),
      checkExecutionId: brandId<"CheckExecutionId">("execution-1"),
      checkId: brandId<"CheckId">("rust.check"),
      checkVersion: "1.0.0",
      status: "passed",
      exitCode: 0,
      durationMs: 12,
      summary: "ok",
      artifactRefs: [],
      metrics: {},
      environment: {},
      inputHash: "a".repeat(64),
      contentHash: "b".repeat(64),
      createdAt: "2026-09-28T00:00:00.000Z",
      producer: { type: "system", name: "verify-agent" },
      executionSource: "real",
    };
    const enriched = renderVerificationCheckOutput({
      result: result("partial", SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPOSITORY_REF,
      checkResults: [check],
    });
    expect(enriched.text).toContain("Check rust.check: passed");
    const plain = renderVerificationCheckOutput({
      result: result("partial", SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPOSITORY_REF,
    });
    expect(plain.text).not.toContain("Check rust.check: passed");
    expect(plain.text).toContain("Coverage verified:");
  });
});

describe("Batch 55 — protected output and authentication (F, G)", () => {
  it("Test F — output leaks no secrets, contents, or host paths", () => {
    const output = renderVerificationCheckOutput({
      result: result("blocked", SHA_A, { verified: ["rust.check"] }),
      snapshot: snapshot(SHA_A),
      repository: REPOSITORY_REF,
      pullRequestNumber: 42,
    });
    const serialized = `${output.title}\n${output.summary}\n${output.text}`;
    for (const forbidden of [
      WEBHOOK_SECRET,
      PERSONAL_TOKEN,
      INSTALLATION_TOKEN,
      APP_PRIVATE_KEY,
      SOURCE_TEXT,
      HOST_PATH,
      "node_modules",
      "docker",
      "PRIVATE KEY",
      "Bearer",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    // ...while still carrying the safe correlation facts.
    expect(serialized).toContain(SHA_A);
    expect(serialized).toContain("42");
    expect(serialized).toContain("rust.check");
  });

  it("Test G — App installation authentication; token mode absent", async () => {
    process.env.GITHUB_TOKEN = PERSONAL_TOKEN;
    try {
      const double = createCheckDouble();
      const seen: { owner?: string; repository?: string }[] = [{}];
      const appPublisher = createGitHubCheckPublisher({
        appConfig: appDeps.appConfig,
        installationResolver: {
          async resolveInstallationId(owner: string, repository: string) {
            seen[0] = { owner, repository };
            return 4242;
          },
        },
        installationTokenClient: appDeps.installationTokenClient,
        fetch: double.fetch,
      });
      await appPublisher.publishVerificationResult({
        result: result("pass", SHA_A),
        snapshot: snapshot(SHA_A),
        repository: REPOSITORY_REF,
      });
      expect(seen[0]).toEqual({ owner: OWNER, repository: REPOSITORY });
      for (const call of double.calls) {
        expect(call.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      }
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    // The adapter has no token-mode surface at all.
    expect(checksSource).not.toContain("GITHUB_TOKEN");
    expect(checksSource).toContain("installationTokenClient");
    expect(() => createGitHubCheckPublisher({} as never)).toThrow(
      GitHubCheckPublicationError,
    );
  });
});

describe("Batch 55 — failure and idempotency (H, I)", () => {
  it("Test H — GitHub API failure never mutates the result or leaks tokens", async () => {
    const double = createCheckDouble();
    double.failCreateWith = 401;
    const input = result("pass", SHA_A, { verified: ["rust.check"] });
    const before = JSON.stringify(input);
    const error = await publisher(double)
      .publishVerificationResult({
        result: input,
        snapshot: snapshot(SHA_A),
        repository: REPOSITORY_REF,
      })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(GitHubCheckPublicationError);
    expect(String((error as Error).message)).toContain("not authorized");
    expect(String((error as Error).message)).not.toContain(INSTALLATION_TOKEN);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("Test H — update falling over to create on a vanished run", async () => {
    const double = createCheckDouble();
    // Batch 55C — pre-existing runs carry a persisted freshness marker;
    // the seeded marker is older than the incoming result so the update
    // path is reached (then 404s once and falls over to create).
    // Marker-less runs fail closed instead (see Batch 55C tests).
    double.existingRuns.push({
      id: 55,
      name: VERIFY_AGENT_CHECK_NAME,
      headSha: SHA_A,
      externalId: `verifyagent:v1:${Date.parse("2026-09-27T00:00:00.000Z")}:${"0".repeat(64)}`,
      appId: OWN_APP_ID,
    });
    double.failUpdateOnce = true;
    const publication = await publisher(double).publishVerificationResult({
      result: result("pass", SHA_A),
      snapshot: snapshot(SHA_A),
      repository: REPOSITORY_REF,
    });
    expect(publication.created).toBe(true);
    expect(publication.checkRunId).not.toBe(55);
  });

  it("Test I — repeated publication updates one run deterministically", async () => {
    const double = createCheckDouble();
    const input = {
      result: result("partial", SHA_A, { verified: ["rust.check"] }),
      snapshot: snapshot(SHA_A),
      repository: REPOSITORY_REF,
    };
    const first = await publisher(double).publishVerificationResult(input);
    expect(first.created).toBe(true);
    const second = await publisher(double).publishVerificationResult(input);
    expect(second.created).toBe(false);
    expect(second.checkRunId).toBe(first.checkRunId);
    expect(double.calls.filter((call) => call.method === "POST")).toHaveLength(
      1,
    );
    expect(double.calls.filter((call) => call.method === "PATCH")).toHaveLength(
      1,
    );
    // A newer result for the same SHA updates rather than duplicating.
    const third = await publisher(double).publishVerificationResult({
      ...input,
      result: result("blocked", SHA_A, { verified: ["rust.check"] }),
    });
    expect(third.created).toBe(false);
    expect(third.checkRunId).toBe(first.checkRunId);
    expect(third.conclusion).toBe("failure");
    // A different commit always creates a separate run.
    const other = await publisher(double).publishVerificationResult({
      ...input,
      result: result("pass", SHA_B),
      snapshot: snapshot(SHA_B),
    });
    expect(other.created).toBe(true);
    expect(other.checkRunId).not.toBe(first.checkRunId);
    expect(other.headSha).toBe(SHA_B);
  });
});
