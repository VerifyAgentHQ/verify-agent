/**
 * Batch 55 — Check Run publication composition E2E.
 *
 * ```text
 * real signed GitHub webhook (POST /webhook → 202 + queueJobId)
 *   ↓ shared queue → application-owned automatic runtime
 *   ↓ VerificationApplicationService (fake sandbox here: simulated)
 *   ↓ VerificationResult
 *   ↓ runtime onSettled hook (the existing completed-result point)
 *   ↓ GitHubCheckPublisher (App installation auth, controlled double)
 *   ↓ Check Run POST for the exact HEAD SHA
 * ```
 *
 * The always-run chain proves composition through the real webhook,
 * runtime, and publisher with a controlled Checks API double. Live GitHub
 * write access is gated separately below: it requires a GitHub App with
 * `checks:write` on a CONTROLLED test repository (never production), plus
 * the real-sandbox gate when real execution is requested. When unavailable
 * the live test skips explicitly — no token-mode fallback, no fake success.
 */

import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGitHubVerificationService } from "../apps/api/src/github-verification-service.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
  createSnapshotStorePublisher,
  createGitHubApiSourceProvider,
  createGitHubApiInstallationResolver,
  createGitHubAppInstallationTokenClient,
  readGitHubAppConfig,
  VERIFY_AGENT_CHECK_NAME,
  createGitHubCheckPublisher,
} from "../packages/adapters-source/src/index.js";
import type { SourceContents } from "../packages/adapters-source/src/resolver.js";
import type {
  RepositorySnapshot,
  VerificationResult,
} from "../packages/domain/src/index.js";
import {
  FakeSandboxTransport,
  SubprocessSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
} from "../packages/engine/src/index.js";

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const HEAD_SHA = "e".repeat(40);
const BASE_SHA = "b".repeat(40);
const SECRET = "batch55-test-webhook-secret";
const INTERNAL_RESULT_TOKEN = "batch55-internal-result-token-for-tests-only";
const CREATED_AT = "2026-09-28T00:00:00.000Z";
const INSTALLATION_TOKEN = "batch55-test-installation-token";

const RUST_CONTENTS = Object.freeze({
  "Cargo.toml": '[package]\nname = "batch55"\nversion = "0.1.0"\n',
  "src/lib.rs": "pub fn value() -> u32 { 42 }\n",
});

function sandboxSuccess(request: { jobId: string }): unknown {
  return {
    schemaVersion: "1.0.0" as const,
    jobId: request.jobId,
    status: "completed" as const,
    exitCode: 0,
    durationMs: 5,
    logsRef: "fixture://logs/batch55",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
    errors: [],
  };
}

interface RecordedCheckCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** Batch 55D — numeric ID of the configured VerifyAgent App in this file. */
const OWN_APP_ID = 123456;

function createCheckDouble() {
  const calls: RecordedCheckCall[] = [];
  let nextId = 201;
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const urlText = String(url);
    calls.push({
      method,
      url: urlText,
      authorization: headers.Authorization,
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
  return { fetch, calls };
}

const appConfig = {
  appId: String(OWN_APP_ID),
  privateKey:
    "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----",
};

function checkPublisherFor(double: ReturnType<typeof createCheckDouble>) {
  return createGitHubCheckPublisher({
    appConfig,
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
    fetch: double.fetch,
  });
}

function makePayload(action = "opened", sha = HEAD_SHA): string {
  return JSON.stringify({
    action,
    repository: { owner: { login: OWNER }, name: REPOSITORY },
    pull_request: {
      number: 42,
      base: { sha: BASE_SHA },
      head: { sha },
    },
  });
}

function signPayload(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

function postWebhook(
  port: number,
  payload: string,
  delivery: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "POST",
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signPayload(payload),
          "x-github-event": "pull_request",
          "x-github-delivery": delivery,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", rejectPromise);
    outbound.end(payload);
  });
}

describe("Batch 55 — webhook-to-check-run composition", () => {
  it("settled verification publishes one Check Run for the exact HEAD SHA", async () => {
    const transport = new FakeSandboxTransport(sandboxSuccess);
    const snapshots = new Map<string, RepositorySnapshot>();
    const innerProvider = createInMemoryGitHubSourceProvider([
      {
        reference: {
          kind: "github-snapshot" as const,
          owner: OWNER,
          repository: REPOSITORY,
          sha: HEAD_SHA,
        },
        sourceContents: { ...RUST_CONTENTS } as SourceContents,
      },
    ]);
    const applicationService = new VerificationApplicationService(
      createVerificationPipeline({
        detector: createProjectDetectionService(),
        executor: createCheckExecutor(
          createSandboxExecutorFromTransport(transport),
        ),
      }),
      createGitHubSourceResolver({
        async resolveSnapshot(reference) {
          const resolved = await innerProvider.resolveSnapshot(reference);
          snapshots.set(String(resolved.snapshot.id), resolved.snapshot);
          const contents: Record<string, string> = {};
          for (const [path, text] of Object.entries(resolved.sourceContents)) {
            contents[path] = text;
          }
          return { snapshot: resolved.snapshot, sourceContents: contents };
        },
      }),
    );
    const verifySource = vi.spyOn(applicationService, "verifySource");
    let counter = 0;
    const service = createGitHubVerificationService({
      applicationService,
      secret: SECRET,
      internalResultToken: INTERNAL_RESULT_TOKEN,
      createJobId: () => `job-batch55-${(counter += 1)}`,
      now: () => CREATED_AT,
    });
    const double = createCheckDouble();
    const publisher = checkPublisherFor(double);
    const publications: { queueJobId: string; checkRunId: number }[] = [];
    // The existing completed-result lifecycle point: no new job system,
    // no runtime changes — a subscriber translates settled outcomes.
    const off = service.onSettled((outcome) => {
      if (outcome.kind !== "completed") return;
      const snapshot = snapshots.get(String(outcome.result.snapshotId));
      if (!snapshot) return;
      void publisher
        .publishVerificationResult({
          result: outcome.result,
          snapshot,
          repository: { owner: OWNER, name: REPOSITORY },
          pullRequestNumber: outcome.job.trigger.pullRequestNumber,
        })
        .then((publication) => {
          publications.push({
            queueJobId: outcome.job.jobId,
            checkRunId: publication.checkRunId,
          });
        });
    });
    await service.start(0, "127.0.0.1");
    try {
      const address = service.server.address();
      if (!address || typeof address === "string") {
        throw new Error("composed service did not bind a port");
      }
      // Webhook is the entry point: no processNext/drain/verifySource calls.
      const webhookResponse = await postWebhook(
        address.port,
        makePayload(),
        "delivery-b55-e2e",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
      expect(verifySource).toHaveBeenCalledTimes(1);
      // The asynchronous publication settles shortly after the job.
      const deadline = Date.now() + 5000;
      while (publications.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(publications).toHaveLength(1);
      expect(publications[0]?.queueJobId).toBe(queueJobId);

      // Exactly one Check Run, created (not updated) for the exact SHA.
      const posts = double.calls.filter((call) => call.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toMatchObject({
        name: VERIFY_AGENT_CHECK_NAME,
        head_sha: HEAD_SHA,
        status: "completed",
        // Simulated single-check fixture → needs_changes → neutral:
        // completed work is never mislabeled a pass.
        conclusion: "neutral",
      });
      // Installation authentication on every Checks call; nothing else.
      for (const call of double.calls) {
        expect(call.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      }
      // The stored truth is untouched by publication.
      const stored = service.resultReader.getByQueueJobId(queueJobId);
      expect(stored).not.toBeNull();
      const serialized = JSON.stringify(posts[0]?.body);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(INSTALLATION_TOKEN);
      expect(serialized).toContain(HEAD_SHA);
      expect(serialized).toContain(String((stored as VerificationResult).id));
    } finally {
      off();
      await service.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Gated live GitHub Check Run publication.
//
// Requires ALL of: the real-sandbox gate (VERIFY_SANDBOX_* + identity),
// a GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY) whose installation
// has `checks:write` on the controlled test repository GITHUB_CHECK_E2E_REPO,
// and an exact pinned SHA GITHUB_CHECK_E2E_SHA in that repository.
//
// What it proves against live GitHub: installation discovery, installation
// token acquisition, Check Run creation for the pinned SHA, and conclusion
// round-trip — with verification truth produced by the real local sandbox
// over fixture bytes bound to the pinned SHA value. The published content
// mirrors that local result; the repository must be test-only because Check
// Runs persist. When prerequisites are absent the test skips explicitly:
// no token-mode fallback, no fake success.
// ---------------------------------------------------------------------------

const sandboxEnvPresent =
  process.env.VERIFY_SANDBOX_PROCESS !== undefined &&
  [
    "VERIFY_SANDBOX_PROCESS",
    "VERIFY_SANDBOX_SNAPSHOT_ROOT",
    "VERIFY_SANDBOX_DOCKER_EXECUTABLE",
    "VERIFY_SANDBOX_DOCKER_HOST",
    "VERIFY_SANDBOX_SYSTEM_ROOT",
    "VERIFY_SANDBOX_TEMP_ROOT",
    "VERIFY_SANDBOX_IDENTITY",
  ].every((name) => Boolean(process.env[name])) &&
  process.env.VERIFY_SANDBOX_IDENTITY === "verify-sandbox-process-0.1.0";

const liveRepo = process.env.GITHUB_CHECK_E2E_REPO;
const liveSha = process.env.GITHUB_CHECK_E2E_SHA;
const liveAppId = process.env.GITHUB_APP_ID;
const livePrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

const liveRepoValid =
  typeof liveRepo === "string" &&
  /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(liveRepo);
const liveShaValid =
  typeof liveSha === "string" && /^[0-9a-f]{40}$/i.test(liveSha);
const liveAppValid =
  typeof liveAppId === "string" &&
  liveAppId.trim().length > 0 &&
  typeof livePrivateKey === "string" &&
  livePrivateKey.includes("PRIVATE KEY");

const liveAvailable =
  sandboxEnvPresent && liveRepoValid && liveShaValid && liveAppValid;

const liveSkipReason = !sandboxEnvPresent
  ? "SKIPPED — live Check Run publication requires the real verify-sandbox gate (VERIFY_SANDBOX_* + identity)"
  : !liveAppValid
    ? "SKIPPED — live Check Run publication requires GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (App with checks:write)"
    : !liveRepoValid
      ? "SKIPPED — live Check Run publication requires GITHUB_CHECK_E2E_REPO as owner/name of a controlled test repository"
      : "SKIPPED — live Check Run publication requires GITHUB_CHECK_E2E_SHA as a pinned 40-hex commit";

describe("Batch 55 — live GitHub Check Run publication", () => {
  it.skipIf(!liveAvailable)(
    liveAvailable ? "live" : (liveSkipReason as string),
    async () => {
      const [owner, name] = (liveRepo as string).split("/");
      const sha = (liveSha as string).toLowerCase();
      const contents: SourceContents = { ...RUST_CONTENTS };
      // Source truth: real GitHub-shaped acquisition is out of scope for the
      // live leg (no production repo may be touched); the fixture bytes below
      // are published under the pinned SHA and really executed, so the result
      // is genuinely bound to that SHA value end to end.
      const provider = createInMemoryGitHubSourceProvider([
        {
          reference: {
            kind: "github-snapshot" as const,
            owner: owner as string,
            repository: name as string,
            sha,
          },
          sourceContents: contents,
        },
      ]);
      const transport = new SubprocessSandboxTransport({
        executable: process.env.VERIFY_SANDBOX_PROCESS!,
        environment: {
          VERIFY_SANDBOX_SNAPSHOT_ROOT:
            process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!,
          VERIFY_SANDBOX_DOCKER_EXECUTABLE:
            process.env.VERIFY_SANDBOX_DOCKER_EXECUTABLE!,
          VERIFY_SANDBOX_DOCKER_HOST: process.env.VERIFY_SANDBOX_DOCKER_HOST!,
          VERIFY_SANDBOX_SYSTEM_ROOT: process.env.VERIFY_SANDBOX_SYSTEM_ROOT!,
          VERIFY_SANDBOX_TEMP_ROOT: process.env.VERIFY_SANDBOX_TEMP_ROOT!,
        },
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 120_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const applicationService = new VerificationApplicationService(
        createVerificationPipeline({
          detector: createProjectDetectionService(),
          executor: createCheckExecutor(
            createSandboxExecutorFromTransport(transport),
          ),
        }),
        createSnapshotStorePublisher(createGitHubSourceResolver(provider), {
          snapshotStoreRoot: process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!,
        }),
      );
      let counter = 0;
      const service = createGitHubVerificationService({
        applicationService,
        secret: SECRET,
        internalResultToken: INTERNAL_RESULT_TOKEN,
        createJobId: () => `job-batch55-live-${(counter += 1)}`,
        now: () => CREATED_AT,
      });
      const appConfiguration = readGitHubAppConfig(process.env);
      const livePublisher = createGitHubCheckPublisher({
        appConfig: appConfiguration,
        installationResolver: createGitHubApiInstallationResolver({
          appConfig: appConfiguration,
        }),
        installationTokenClient: createGitHubAppInstallationTokenClient({
          appConfig: appConfiguration,
        }),
      });
      await service.start(0, "127.0.0.1");
      try {
        const address = service.server.address();
        if (!address || typeof address === "string") {
          throw new Error("composed service did not bind a port");
        }
        const payload = JSON.stringify({
          action: "opened",
          repository: {
            owner: { login: owner },
            name,
          },
          pull_request: {
            number: 1,
            base: { sha: "d".repeat(40) },
            head: { sha },
          },
        });
        const webhookResponse = await postWebhook(
          address.port,
          payload,
          "delivery-b55-live",
        );
        expect(webhookResponse.status).toBe(202);
        const queueJobId = (
          JSON.parse(webhookResponse.body) as { queueJobId: string }
        ).queueJobId;
        const outcome = await service.waitForQueueJob(queueJobId, {
          timeoutMs: 170_000,
        });
        expect(outcome.kind).toBe("completed");
        if (outcome.kind !== "completed") return;
        const stored = service.resultReader.getByQueueJobId(queueJobId);
        expect(stored).not.toBeNull();
        // Snapshot lookup for the publisher comes from the same resolution
        // the service used; the SHA binding is enforced by the publisher.
        const snapshot = (
          await provider.resolveSnapshot({
            kind: "github-snapshot" as const,
            owner: owner as string,
            repository: name as string,
            sha,
          })
        ).snapshot;
        const publication = await livePublisher.publishVerificationResult({
          result: stored as VerificationResult,
          snapshot,
          repository: { owner: owner as string, name: name as string },
          pullRequestNumber: 1,
          expectedHeadSha: sha,
        });
        expect(publication.headSha).toBe(sha);
        expect(typeof publication.checkRunId).toBe("number");
        expect(
          (
            await livePublisher.publishVerificationResult({
              result: stored as VerificationResult,
              snapshot,
              repository: { owner: owner as string, name: name as string },
              pullRequestNumber: 1,
              expectedHeadSha: sha,
            })
          ).checkRunId,
        ).toBe(publication.checkRunId);
      } finally {
        await service.stop();
        await import("node:fs/promises").then(({ rm }) =>
          rm(`${process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT}/${sha}`, {
            recursive: true,
            force: true,
          }).catch(() => {}),
        );
      }
    },
    180_000,
  );

  it("live gate reports its prerequisites honestly", () => {
    if (liveAvailable) {
      expect(liveSkipReason).toBeDefined();
    } else {
      expect(typeof liveSkipReason).toBe("string");
      expect(liveSkipReason as string).toContain("SKIPPED");
    }
  });
});
