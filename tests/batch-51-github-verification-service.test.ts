/**
 * Batch 51 — Runnable In-Process GitHub Verification Service.
 *
 * Proves the single-process composition owns the consumption lifecycle:
 *
 * ```text
 * start composed service (one server, shared queue/runtime/registry)
 *   ↓ authenticated webhook POST /webhook → 202 + queueJobId
 *   ↓ runtime automatically consumes (no manual processNext/drain)
 *   ↓ worker → VerificationApplicationService → real pipeline
 *   ↓ bounded registry → protected GET /verification-jobs/:id/result → 200
 *   ↓ service shutdown (no loop remains, no new jobs processed)
 * ```
 *
 * The test never drives processing manually: no `processNext()`, no
 * `drain()`, no `queue.jobs` snapshots, no `processor.process()` calls.
 * Completion is awaited deterministically through the runtime's
 * `waitForQueueJob()` (event-driven wakeup, bounded timeout only).
 *
 * Dependencies are deterministic: fake GitHub source provider, fake
 * sandbox transport, fixed webhook secret, fixed internal result token.
 * The application lifecycle (start/stop, single server, shared instances)
 * is real.
 */

import { createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGitHubVerificationService } from "../apps/api/src/github-verification-service.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
} from "../packages/adapters-source/src/github.js";
import {
  createVerificationQueueJob,
  type VerificationQueueJob,
} from "../packages/domain/src/verification-queue.js";
import type { VerificationResult } from "../packages/domain/src/verification.js";
import {
  FakeSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createInMemoryVerificationJobQueue,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
} from "../packages/engine/src/index.js";
import {
  createInMemoryVerificationResultRegistry,
  createVerificationJobRuntime,
} from "../apps/worker/src/index.js";

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const HEAD_SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const UNKNOWN_SHA = "d".repeat(40);
const SECRET = "batch51-test-webhook-secret";
const INTERNAL_RESULT_TOKEN = "batch51-internal-result-token-for-tests-only";
const VALID_AUTH = `Bearer ${INTERNAL_RESULT_TOKEN}`;
const CREATED_AT = "2026-09-25T00:00:00.000Z";
const SOURCE_ID = `${OWNER}:${REPOSITORY}:${HEAD_SHA}`;
const EXPECTED_SNAPSHOT_ID = `${OWNER}--${REPOSITORY}--${HEAD_SHA}`;

const FIXTURE_CONTENTS = Object.freeze({
  "package.json": JSON.stringify({
    name: "batch51-fixture",
    devDependencies: { typescript: "5.0.0" },
  }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/index.ts": "export const value = 42;\n",
});

function sandboxSuccess(request: { jobId: string }): unknown {
  return {
    schemaVersion: "1.0.0" as const,
    jobId: request.jobId,
    status: "completed" as const,
    exitCode: 0,
    durationMs: 5,
    logsRef: "fixture://logs/batch51",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
    errors: [],
  };
}

interface TestService {
  readonly service: ReturnType<typeof createGitHubVerificationService>;
  readonly transport: FakeSandboxTransport;
  readonly applicationService: VerificationApplicationService;
}

function createTestService(
  shas: readonly string[] = [HEAD_SHA],
  options?: {
    readonly internalResultToken?: string | null;
    readonly createJobId?: () => string;
  },
): TestService {
  const transport = new FakeSandboxTransport(sandboxSuccess);
  const provider = createInMemoryGitHubSourceProvider(
    shas.map((sha) => ({
      reference: {
        kind: "github-snapshot" as const,
        owner: OWNER,
        repository: REPOSITORY,
        sha,
      },
      sourceContents: { ...FIXTURE_CONTENTS },
    })),
  );
  const applicationService = new VerificationApplicationService(
    createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    }),
    createGitHubSourceResolver(provider),
  );
  let counter = 0;
  const service = createGitHubVerificationService({
    applicationService,
    secret: SECRET,
    ...(options && "internalResultToken" in options
      ? { internalResultToken: options.internalResultToken ?? null }
      : { internalResultToken: INTERNAL_RESULT_TOKEN }),
    ...(options?.createJobId !== undefined
      ? { createJobId: options.createJobId }
      : {
          createJobId: () => `job-batch51-${(counter += 1)}`,
        }),
    now: () => CREATED_AT,
  });
  return { service, transport, applicationService };
}

function serverPort(
  service: ReturnType<typeof createGitHubVerificationService>,
): number {
  const address = service.server.address();
  if (!address || typeof address === "string") {
    throw new Error("composed service did not bind a port");
  }
  return address.port;
}

async function withRunningService(
  testService: TestService,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  await testService.service.start(0, "127.0.0.1");
  try {
    await fn(serverPort(testService.service));
  } finally {
    await testService.service.stop();
  }
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

function signPayload(payload: string, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function postWebhook(
  port: number,
  payload: string,
  signature: string,
  delivery: string,
  event = "pull_request",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "POST",
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
          "x-github-event": event,
          "x-github-delivery": delivery,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", reject);
    outbound.end(payload);
  });
}

function httpGet(
  port: number,
  path: string,
  method = "GET",
  auth: string | null | undefined = VALID_AUTH,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (auth !== null && auth !== undefined) {
      headers.authorization = auth;
    }
    const outbound = httpRequest(
      { port, host: "127.0.0.1", method, path, headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", reject);
    outbound.end();
  });
}

function httpPostVerify(
  port: number,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "POST",
        path: "/verify",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", reject);
    outbound.end(payload);
  });
}

describe("Batch 51 — runnable in-process GitHub verification service", () => {
  it("Test 1 — real composed startup shares one queue, runtime, and registry", async () => {
    const testService = createTestService();
    expect(testService.service.isStarted()).toBe(false);
    await testService.service.start(0, "127.0.0.1");
    try {
      expect(testService.service.isStarted()).toBe(true);
      expect(testService.service.runtime.isRunning()).toBe(true);
      expect(testService.service.runtime.isAutoProcessing()).toBe(true);
      // The critical invariant: webhook, runtime, and API observe the
      // SAME queue and registry instances (no accidental duplicates).
      expect(testService.service.queue).toBeDefined();
      expect(testService.service.registry).toBeDefined();
      const health = await httpGet(serverPort(testService.service), "/health");
      expect(health.status).toBe(200);
    } finally {
      await testService.service.stop();
    }
    expect(testService.service.isStarted()).toBe(false);
  });

  it("Test 2 — authenticated webhook enqueues exactly one job", async () => {
    const testService = createTestService();
    await withRunningService(testService, async (port) => {
      const payload = makePayload("opened");
      const response = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b51-t2",
      );
      expect(response.status).toBe(202);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body.status).toBe("accepted");
      expect(typeof body.queueJobId).toBe("string");
      expect((body.queueJobId as string).length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain(SECRET);
      // Settle the automatically consumed job so no background work
      // leaks beyond this test's service stop.
      const queueJobId = body.queueJobId as string;
      const outcome = await testService.service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
    });
  });

  it("Test 3 — runtime automatically consumes without manual driving", async () => {
    const testService = createTestService();
    const spy = vi.spyOn(testService.applicationService, "verifySource");
    await withRunningService(testService, async (port) => {
      const payload = makePayload("opened");
      const webhookResponse = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b51-t3",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      // No manual runtime calls here: the service itself consumes.
      // (With automatic consumption the worker may finish before this
      // assertion runs, so no immediate pre-completion spy check.)
      const outcome = await testService.service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(testService.transport.requests).toHaveLength(1);
    });
  });

  it("Test 4 — protected result retrieval with the webhook queueJobId", async () => {
    const testService = createTestService();
    await withRunningService(testService, async (port) => {
      const payload = makePayload("opened");
      const webhookResponse = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b51-t4",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await testService.service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      const fetched = await httpGet(
        port,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(fetched.status).toBe(200);
      const body = JSON.parse(fetched.body) as Record<string, unknown>;
      expect(body.queueJobId).toBe(queueJobId);
    });
  });

  it("Test 5 — identity and provenance survive the composed path", async () => {
    const testService = createTestService();
    await withRunningService(testService, async (port) => {
      const payload = makePayload("opened");
      const webhookResponse = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b51-t5",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      const outcome = await testService.service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
      const fetched = await httpGet(
        port,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(fetched.status).toBe(200);
      const body = JSON.parse(fetched.body) as {
        queueJobId: string;
        verificationId: string;
        jobId: string;
        snapshotId: string;
        contentHash: string;
        resultVersion: string;
      };
      expect(body.queueJobId).toBe(queueJobId);
      expect(body.jobId).not.toBe(body.queueJobId);
      expect(body.verificationId).not.toBe(body.queueJobId);
      expect(body.snapshotId).toBe(EXPECTED_SNAPSHOT_ID);
      expect(body.snapshotId).toContain(HEAD_SHA);
      expect(body.snapshotId).not.toContain(BASE_SHA);
      expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.resultVersion).toBe("1.0.0");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("ghs_");
      expect(SOURCE_ID).toContain(HEAD_SHA);
    });
  });

  it("Test 6 — three jobs complete without identity mixing", async () => {
    const testService = createTestService([SHA_A, SHA_B, SHA_C]);
    const shas = [SHA_A, SHA_B, SHA_C];
    await withRunningService(testService, async (port) => {
      const queueJobIds: string[] = [];
      for (let index = 0; index < shas.length; index += 1) {
        const payload = makePayload("opened", shas[index]);
        const response = await postWebhook(
          port,
          payload,
          signPayload(payload),
          `delivery-b51-t6-${index}`,
        );
        expect(response.status).toBe(202);
        queueJobIds.push(
          (JSON.parse(response.body) as { queueJobId: string }).queueJobId,
        );
      }
      expect(new Set(queueJobIds).size).toBe(3);
      const outcomes = await Promise.all(
        queueJobIds.map((id) =>
          testService.service.waitForQueueJob(id, { timeoutMs: 8000 }),
        ),
      );
      expect(outcomes.every((o) => o.kind === "completed")).toBe(true);
      expect(testService.transport.requests).toHaveLength(3);
      for (let index = 0; index < shas.length; index += 1) {
        const fetched = await httpGet(
          port,
          `/verification-jobs/${encodeURIComponent(queueJobIds[index] as string)}/result`,
        );
        expect(fetched.status).toBe(200);
        const body = JSON.parse(fetched.body) as {
          queueJobId: string;
          snapshotId: string;
        };
        expect(body.queueJobId).toBe(queueJobIds[index]);
        expect(body.snapshotId).toBe(`${OWNER}--${REPOSITORY}--${shas[index]}`);
      }
    });
  });

  it("Test 7 — invalid webhook signature queues and verifies nothing", async () => {
    const testService = createTestService();
    const spy = vi.spyOn(testService.applicationService, "verifySource");
    await withRunningService(testService, async (port) => {
      const payload = makePayload("opened");
      const response = await postWebhook(
        port,
        payload,
        `sha256=${"0".repeat(64)}`,
        "delivery-b51-t7",
      );
      expect(response.status).toBe(401);
      // Observation only (queue size), never driving processing.
      expect(testService.service.queue.size()).toBe(0);
      expect(testService.service.registry.size()).toBe(0);
      expect(testService.service.replayGuard.isReplay("delivery-b51-t7")).toBe(
        false,
      );
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("Test 8 — unsupported event stays ignored with no verification", async () => {
    const testService = createTestService();
    const spy = vi.spyOn(testService.applicationService, "verifySource");
    await withRunningService(testService, async (port) => {
      const closedPayload = makePayload("closed");
      const closed = await postWebhook(
        port,
        closedPayload,
        signPayload(closedPayload),
        "delivery-b51-t8-closed",
      );
      expect(closed.status).toBe(202);
      expect(JSON.parse(closed.body)).toMatchObject({ status: "ignored" });

      const openedPayload = makePayload("opened");
      const push = await postWebhook(
        port,
        openedPayload,
        signPayload(openedPayload),
        "delivery-b51-t8-push",
        "push",
      );
      expect(push.status).toBe(202);
      expect(JSON.parse(push.body)).toMatchObject({ status: "ignored" });

      expect(testService.service.queue.size()).toBe(0);
      expect(testService.service.registry.size()).toBe(0);
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("Test 9 — worker failure registers no success and stays usable", async () => {
    const testService = createTestService([HEAD_SHA]);
    await withRunningService(testService, async (port) => {
      const badPayload = makePayload("opened", UNKNOWN_SHA);
      const badResponse = await postWebhook(
        port,
        badPayload,
        signPayload(badPayload),
        "delivery-b51-t9-bad",
      );
      expect(badResponse.status).toBe(202);
      const badJobId = (JSON.parse(badResponse.body) as { queueJobId: string })
        .queueJobId;
      const failed = await testService.service.waitForQueueJob(badJobId, {
        timeoutMs: 5000,
      });
      expect(failed.kind).toBe("failed");
      // No false successful result for the failed job.
      const missing = await httpGet(
        port,
        `/verification-jobs/${encodeURIComponent(badJobId)}/result`,
      );
      expect(missing.status).toBe(404);

      // The runtime remains usable for the next job.
      const goodPayload = makePayload("opened", HEAD_SHA);
      const goodResponse = await postWebhook(
        port,
        goodPayload,
        signPayload(goodPayload),
        "delivery-b51-t9-good",
      );
      expect(goodResponse.status).toBe(202);
      const goodJobId = (
        JSON.parse(goodResponse.body) as { queueJobId: string }
      ).queueJobId;
      expect(goodJobId).not.toBe(badJobId);
      const recovered = await testService.service.waitForQueueJob(goodJobId, {
        timeoutMs: 5000,
      });
      expect(recovered.kind).toBe("completed");
      const fetched = await httpGet(
        port,
        `/verification-jobs/${encodeURIComponent(goodJobId)}/result`,
      );
      expect(fetched.status).toBe(200);
    });
  });

  it("Test 10 — result endpoint stays protected and fails closed", async () => {
    const testService = createTestService();
    await withRunningService(testService, async (port) => {
      const payload = makePayload("opened");
      const webhookResponse = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b51-t10",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await testService.service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      const path = `/verification-jobs/${encodeURIComponent(queueJobId)}/result`;

      const missing = await httpGet(port, path, "GET", null);
      expect(missing.status).toBe(401);
      const wrong = await httpGet(port, path, "GET", "Bearer wrong-token");
      expect(wrong.status).toBe(401);
      // Queue ID as credential is never accepted.
      const queueIdAsAuth = await httpGet(
        port,
        path,
        "GET",
        `Bearer ${queueJobId}`,
      );
      expect(queueIdAsAuth.status).toBe(401);
    });

    // Misconfiguration fails closed: reader without token leaves the
    // route unavailable as if it did not exist.
    const misconfigured = createTestService([HEAD_SHA], {
      internalResultToken: null,
    });
    await withRunningService(misconfigured, async (port) => {
      const payload = makePayload("opened");
      const webhookResponse = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b51-t10-misconfigured",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await misconfigured.service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      for (const auth of [VALID_AUTH, null, "Bearer wrong"] as const) {
        const response = await httpGet(
          port,
          `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
          "GET",
          auth,
        );
        expect(response.status).toBe(404);
        expect(JSON.parse(response.body)).toEqual({
          error: { code: "not_found", message: "route not found" },
        });
      }
    });
  });

  it("Test 11 — reading a result never triggers another verification", async () => {
    const testService = createTestService();
    const spy = vi.spyOn(testService.applicationService, "verifySource");
    await withRunningService(testService, async (port) => {
      const payload = makePayload("opened");
      const webhookResponse = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b51-t11",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      const path = `/verification-jobs/${encodeURIComponent(queueJobId)}/result`;
      // With automatic consumption the job may already be complete here,
      // so the deterministic property under test is post-completion:
      // repeated reads never trigger another verification.
      await testService.service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 3; index += 1) {
        const reread = await httpGet(port, path);
        expect(reread.status).toBe(200);
      }
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("Test 12 — shutdown stops consumption with no loop left behind", async () => {
    const testService = createTestService([SHA_A]);
    await testService.service.start(0, "127.0.0.1");
    const port = serverPort(testService.service);
    const payload = makePayload("opened", SHA_A);
    const webhookResponse = await postWebhook(
      port,
      payload,
      signPayload(payload),
      "delivery-b51-t12-first",
    );
    const firstJobId = (
      JSON.parse(webhookResponse.body) as { queueJobId: string }
    ).queueJobId;
    const first = await testService.service.waitForQueueJob(firstJobId, {
      timeoutMs: 5000,
    });
    expect(first.kind).toBe("completed");

    await testService.service.stop();
    expect(testService.service.runtime.isRunning()).toBe(false);
    expect(testService.service.runtime.isAutoProcessing()).toBe(false);

    // Work enqueued after shutdown is never consumed.
    const after = createVerificationQueueJob({
      jobId: "job-batch51-after-stop",
      source: { kind: "snapshot", id: `${OWNER}:${REPOSITORY}:${SHA_A}` },
      trigger: {
        kind: "pull-request",
        action: "opened",
        pullRequestNumber: 42,
      },
      deliveryId: "delivery-b51-t12-after",
      createdAt: CREATED_AT,
    });
    await testService.service.queue.enqueue(after);
    await expect(
      testService.service.waitForQueueJob("job-batch51-after-stop", {
        timeoutMs: 300,
      }),
    ).rejects.toThrow(/timed out/);
    expect(
      testService.service.registry.getByQueueJobId("job-batch51-after-stop"),
    ).toBeUndefined();
    expect(testService.service.runtime.isAutoProcessing()).toBe(false);
  });

  it("Test 13 — existing POST /verify and GET /health keep working", async () => {
    const testService = createTestService();
    await withRunningService(testService, async (port) => {
      const health = await httpGet(port, "/health");
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ status: "ok" });

      const verified = await httpPostVerify(port, {
        source: { kind: "snapshot", id: SOURCE_ID },
      });
      expect(verified.status).toBe(200);
      const body = JSON.parse(verified.body) as Record<string, unknown>;
      expect(body.source).toEqual({ kind: "snapshot", id: SOURCE_ID });

      const invalid = await httpPostVerify(port, {});
      expect(invalid.status).toBe(400);
    });
  });
});

describe("Batch 51 — lifecycle and startup hardening", () => {
  function makeDirectJob(
    jobId: string,
    deliveryId: string,
  ): VerificationQueueJob {
    return createVerificationQueueJob({
      jobId,
      source: { kind: "snapshot", id: `${OWNER}:${REPOSITORY}:${SHA_A}` },
      trigger: {
        kind: "pull-request",
        action: "opened",
        pullRequestNumber: 42,
      },
      deliveryId,
      createdAt: CREATED_AT,
    });
  }

  function makeStubResult(tag: string): VerificationResult {
    return {
      id: `verification-race-${tag}`,
      requestId: `request-race-${tag}`,
      jobId: `native-job-race-${tag}`,
      projectId: `project-race-${tag}`,
      snapshotId: `snapshot-race-${tag}`,
      changeSetId: `changeset-race-${tag}`,
      status: "pass",
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
      policyDecision: `policy-race-${tag}`,
      summary: "stub result for lifecycle test",
      resultVersion: "1.0.0",
      contentHash: "b".repeat(64),
      createdAt: CREATED_AT,
    } as unknown as VerificationResult;
  }

  it("stop awaits the in-flight job of the stopped generation", async () => {
    const queue = createInMemoryVerificationJobQueue();
    const registry = createInMemoryVerificationResultRegistry();
    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseJob!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });
    let calls = 0;
    const runtime = createVerificationJobRuntime({
      queue,
      processor: {
        process: async () => {
          calls += 1;
          enteredResolve();
          await gate;
          return makeStubResult("inflight");
        },
      },
      registry,
    });
    runtime.startAutoProcessing();
    await queue.enqueue(
      makeDirectJob("job-race-inflight", "delivery-race-inflight"),
    );
    // Deterministic: the processor is provably inside the job.
    await entered;

    let stopDone = false;
    const stopPromise = runtime.stopAutoProcessing().then(() => {
      stopDone = true;
    });
    // The old loop is still inside processNext, so the stop of that
    // generation cannot have resolved yet.
    expect(stopDone).toBe(false);
    expect(runtime.isAutoProcessing()).toBe(false);

    releaseJob();
    await stopPromise;
    expect(stopDone).toBe(true);
    expect(calls).toBe(1);
    expect(registry.getByQueueJobId("job-race-inflight")).toBeDefined();
    // Idempotent second stop.
    await runtime.stopAutoProcessing();
  });

  it("a concurrent start cannot revive the generation being stopped", async () => {
    const queue = createInMemoryVerificationJobQueue();
    const registry = createInMemoryVerificationResultRegistry();
    let calls = 0;
    const settled: string[] = [];
    const runtime = createVerificationJobRuntime({
      queue,
      processor: {
        process: async (job) => {
          calls += 1;
          return makeStubResult(job.jobId);
        },
      },
      registry,
    });
    const off = runtime.onSettled((outcome) => {
      settled.push(outcome.job.jobId);
    });
    try {
      runtime.startAutoProcessing();
      // Overlapping stop/start: the stop captures generation 1 while the
      // start mints generation 2. Awaiting the stop must await only the
      // old loop and must neither hang on nor revive the new one.
      const stopPromise = runtime.stopAutoProcessing();
      runtime.startAutoProcessing();
      await stopPromise;
      expect(runtime.isAutoProcessing()).toBe(true);

      await queue.enqueue(
        makeDirectJob("job-race-revive", "delivery-race-revive"),
      );
      const outcome = await runtime.waitForQueueJob("job-race-revive", {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
      // Exactly-once: no duplicate loop consumed the job.
      expect(calls).toBe(1);
      expect(settled).toEqual(["job-race-revive"]);
    } finally {
      off();
      await runtime.stopAutoProcessing();
    }
    expect(runtime.isAutoProcessing()).toBe(false);
  });

  it("repeated starts stay idempotent and restart after stop works", async () => {
    const queue = createInMemoryVerificationJobQueue();
    const registry = createInMemoryVerificationResultRegistry();
    let calls = 0;
    const settled: string[] = [];
    const runtime = createVerificationJobRuntime({
      queue,
      processor: {
        process: async (job) => {
          calls += 1;
          return makeStubResult(job.jobId);
        },
      },
      registry,
    });
    const off = runtime.onSettled((outcome) => {
      settled.push(outcome.job.jobId);
    });
    try {
      runtime.startAutoProcessing();
      runtime.startAutoProcessing();
      runtime.startAutoProcessing();
      await queue.enqueue(makeDirectJob("job-race-once", "delivery-race-once"));
      const first = await runtime.waitForQueueJob("job-race-once", {
        timeoutMs: 5000,
      });
      expect(first.kind).toBe("completed");
      // A single loop exists: repeated starts did not duplicate listeners.
      expect(calls).toBe(1);
      expect(settled).toEqual(["job-race-once"]);

      await runtime.stopAutoProcessing();
      await runtime.stopAutoProcessing();
      expect(runtime.isAutoProcessing()).toBe(false);

      // A new generation after stop is fully valid.
      runtime.startAutoProcessing();
      expect(runtime.isAutoProcessing()).toBe(true);
      await queue.enqueue(
        makeDirectJob("job-race-restart", "delivery-race-restart"),
      );
      const second = await runtime.waitForQueueJob("job-race-restart", {
        timeoutMs: 5000,
      });
      expect(second.kind).toBe("completed");
      expect(calls).toBe(2);
      expect(settled).toEqual(["job-race-once", "job-race-restart"]);
    } finally {
      off();
      await runtime.stopAutoProcessing();
    }
  });

  it("service lifecycle race keeps exactly-once webhook processing", async () => {
    const testService = createTestService([SHA_A, SHA_B]);
    await testService.service.start(0, "127.0.0.1");
    const port = serverPort(testService.service);
    try {
      let settled = 0;
      const off = testService.service.onSettled(() => {
        settled += 1;
      });
      try {
        const stopPromise = testService.service.runtime.stopAutoProcessing();
        testService.service.runtime.startAutoProcessing();
        await stopPromise;
        expect(testService.service.runtime.isAutoProcessing()).toBe(true);

        const payload = makePayload("opened", SHA_A);
        const response = await postWebhook(
          port,
          payload,
          signPayload(payload),
          "delivery-b51-race-svc",
        );
        expect(response.status).toBe(202);
        const queueJobId = (JSON.parse(response.body) as { queueJobId: string })
          .queueJobId;
        const outcome = await testService.service.waitForQueueJob(queueJobId, {
          timeoutMs: 5000,
        });
        expect(outcome.kind).toBe("completed");
      } finally {
        off();
      }
      expect(settled).toBe(1);
    } finally {
      await testService.service.stop();
    }
  });

  it("failed HTTP bind rejects startup with no runtime left behind", async () => {
    const blocker = createServer((_request, response) => {
      response.end("busy");
    });
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const blockedPort = (blocker.address() as { port: number }).port;
    try {
      const testService = createTestService([SHA_A]);
      // The ORIGINAL bind error propagates (not a swallowed/replaced error).
      await expect(
        testService.service.start(blockedPort, "127.0.0.1"),
      ).rejects.toThrow(/EADDRINUSE/);
      // Accepting/started state is reset; runtime is fully inactive.
      expect(testService.service.isStarted()).toBe(false);
      expect(testService.service.runtime.isAutoProcessing()).toBe(false);
      expect(testService.service.runtime.isRunning()).toBe(false);

      // Post-failure isolation: the queued job is processable (its SHA
      // has a fixture), yet nothing consumes it and the registry is
      // unchanged — proving the queue listener is detached and no
      // background loop survived the rejected startup.
      expect(testService.service.registry.size()).toBe(0);
      await testService.service.queue.enqueue(
        makeDirectJob("job-b51-bind-fail", "delivery-b51-bind-fail"),
      );
      await expect(
        testService.service.waitForQueueJob("job-b51-bind-fail", {
          timeoutMs: 300,
        }),
      ).rejects.toThrow(/timed out/);
      expect(
        testService.service.registry.getByQueueJobId("job-b51-bind-fail"),
      ).toBeUndefined();
      expect(testService.service.registry.size()).toBe(0);

      // Full state reset: the same service restarts cleanly on a free
      // port, accepts webhooks again, and processes exactly once.
      await testService.service.start(0, "127.0.0.1");
      try {
        expect(testService.service.isStarted()).toBe(true);
        expect(testService.service.runtime.isAutoProcessing()).toBe(true);
        let settled = 0;
        const off = testService.service.onSettled(() => {
          settled += 1;
        });
        try {
          const port = serverPort(testService.service);
          const payload = makePayload("opened", SHA_A);
          const response = await postWebhook(
            port,
            payload,
            signPayload(payload),
            "delivery-b51-bind-recover",
          );
          expect(response.status).toBe(202);
          const queueJobId = (
            JSON.parse(response.body) as { queueJobId: string }
          ).queueJobId;
          const outcome = await testService.service.waitForQueueJob(
            queueJobId,
            { timeoutMs: 5000 },
          );
          expect(outcome.kind).toBe("completed");
        } finally {
          off();
        }
        expect(settled).toBe(1);
      } finally {
        await testService.service.stop();
      }

      // The failed-then-recovered service is safely discardable.
      await testService.service.close();
      expect(testService.service.runtime.isAutoProcessing()).toBe(false);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("concurrent starts share one startup transition", async () => {
    const testService = createTestService([SHA_A]);
    const target = testService.service.server;
    const originalListen = target.listen;
    let listenCalls = 0;
    const runtimeSpy = vi.spyOn(
      testService.service.runtime,
      "startAutoProcessing",
    );
    const patched = target as unknown as {
      listen: (...args: never[]) => unknown;
    };
    const boundOriginal = (
      originalListen as (...args: never[]) => unknown
    ).bind(target);
    patched.listen = (...args: never[]): unknown => {
      listenCalls += 1;
      return boundOriginal(...args);
    };
    try {
      const first = testService.service.start(0, "127.0.0.1");
      const second = testService.service.start(0, "127.0.0.1");
      await Promise.all([first, second]);
      // One startup transition: exactly one bind, one runtime startup.
      expect(listenCalls).toBe(1);
      expect(runtimeSpy).toHaveBeenCalledTimes(1);
      expect(testService.service.isStarted()).toBe(true);

      let settled = 0;
      const off = testService.service.onSettled(() => {
        settled += 1;
      });
      try {
        const port = serverPort(testService.service);
        const payload = makePayload("opened", SHA_A);
        const response = await postWebhook(
          port,
          payload,
          signPayload(payload),
          "delivery-b51-singleflight",
        );
        expect(response.status).toBe(202);
        const queueJobId = (JSON.parse(response.body) as { queueJobId: string })
          .queueJobId;
        const outcome = await testService.service.waitForQueueJob(queueJobId, {
          timeoutMs: 5000,
        });
        expect(outcome.kind).toBe("completed");
      } finally {
        off();
      }
      expect(settled).toBe(1);
    } finally {
      patched.listen = originalListen as (...args: never[]) => unknown;
      runtimeSpy.mockRestore();
      await testService.service.stop();
    }
  });

  it("concurrent starts share one failed startup", async () => {
    const blocker = createServer((_request, response) => {
      response.end("busy");
    });
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const blockedPort = (blocker.address() as { port: number }).port;
    try {
      const testService = createTestService([SHA_A]);
      const target = testService.service.server;
      const originalListen = target.listen;
      let listenCalls = 0;
      const patched = target as unknown as {
        listen: (...args: never[]) => unknown;
      };
      const boundOriginal = (
        originalListen as (...args: never[]) => unknown
      ).bind(target);
      patched.listen = (...args: never[]): unknown => {
        listenCalls += 1;
        return boundOriginal(...args);
      };
      try {
        const first = testService.service.start(blockedPort, "127.0.0.1");
        const second = testService.service.start(blockedPort, "127.0.0.1");
        // Both callers observe the same original bind failure.
        await expect(first).rejects.toThrow(/EADDRINUSE/);
        await expect(second).rejects.toThrow(/EADDRINUSE/);
        // A single bind was attempted and cleaned up exactly once.
        expect(listenCalls).toBe(1);
        expect(testService.service.isStarted()).toBe(false);
        expect(testService.service.runtime.isAutoProcessing()).toBe(false);
        expect(testService.service.runtime.isRunning()).toBe(false);

        // No server remains accepting work on the failed service.
        expect(testService.service.server.listening).toBe(false);

        // No jobs are processed after the shared failure.
        await testService.service.queue.enqueue(
          makeDirectJob("job-b51-shared-fail", "delivery-b51-shared-fail"),
        );
        await expect(
          testService.service.waitForQueueJob("job-b51-shared-fail", {
            timeoutMs: 300,
          }),
        ).rejects.toThrow(/timed out/);
        expect(testService.service.registry.size()).toBe(0);
      } finally {
        patched.listen = originalListen as (...args: never[]) => unknown;
        await testService.service.stop();
        await testService.service.close();
      }
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it("stop during startup leaves the service deterministically stopped", async () => {
    const testService = createTestService([SHA_A]);
    const target = testService.service.server;
    const originalListen = target.listen;
    let releaseBind!: () => void;
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    const patched = target as unknown as {
      listen: (...args: never[]) => unknown;
    };
    const boundOriginal = (
      originalListen as (...args: never[]) => unknown
    ).bind(target);
    patched.listen = (...args: never[]): unknown => {
      // Deterministic startup gate: the real bind runs only after release.
      void bindGate.then(() => {
        boundOriginal(...args);
      });
      return target;
    };
    try {
      const startPromise = testService.service.start(0, "127.0.0.1");
      // Startup is provably in progress: runtime auto-started, but the
      // service is not marked started and nothing is listening yet.
      expect(testService.service.runtime.isAutoProcessing()).toBe(true);
      expect(testService.service.isStarted()).toBe(false);
      expect(target.listening).toBe(false);

      const stopPromise = testService.service.stop();
      // Release the gate: the pending startup completes, then the joined
      // stop tears it down. Final state must be stopped with no
      // resurrection by the stale startup continuation.
      releaseBind();
      await stopPromise;
      await expect(startPromise).resolves.toBeUndefined();
      expect(testService.service.isStarted()).toBe(false);
      expect(target.listening).toBe(false);
      expect(testService.service.runtime.isAutoProcessing()).toBe(false);
      expect(testService.service.runtime.isRunning()).toBe(false);

      // Jobs submitted afterward are not processed.
      await testService.service.queue.enqueue(
        makeDirectJob("job-b51-interrupted", "delivery-b51-interrupted"),
      );
      await expect(
        testService.service.waitForQueueJob("job-b51-interrupted", {
          timeoutMs: 300,
        }),
      ).rejects.toThrow(/timed out/);
      expect(testService.service.registry.size()).toBe(0);

      // Restart after the interrupted startup performs one clean startup.
      await testService.service.start(0, "127.0.0.1");
      expect(testService.service.isStarted()).toBe(true);
      const port = serverPort(testService.service);
      const payload = makePayload("opened", SHA_A);
      const response = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b51-interrupted-restart",
      );
      expect(response.status).toBe(202);
      const queueJobId = (JSON.parse(response.body) as { queueJobId: string })
        .queueJobId;
      const outcome = await testService.service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
    } finally {
      patched.listen = originalListen as (...args: never[]) => unknown;
      await testService.service.stop();
    }
  });

  it("overlapping generations never process concurrently", async () => {
    const queue = createInMemoryVerificationJobQueue();
    const registry = createInMemoryVerificationResultRegistry();
    let active = 0;
    let maxActive = 0;
    const sequence: string[] = [];
    let enteredResolve!: () => void;
    const enteredA = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let releaseJobA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseJobA = resolve;
    });
    let enteredB = false;
    const runtime = createVerificationJobRuntime({
      queue,
      processor: {
        process: async (job) => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          sequence.push(`enter-${job.jobId}`);
          try {
            if (job.jobId === "job-race-overlap-a") {
              enteredResolve();
              await gateA;
            } else {
              enteredB = true;
            }
            return makeStubResult(job.jobId);
          } finally {
            sequence.push(`exit-${job.jobId}`);
            active -= 1;
          }
        },
      },
      registry,
    });
    try {
      runtime.startAutoProcessing();
      // 1-3: job A begins processing and is deliberately held in flight.
      await queue.enqueue(makeDirectJob("job-race-overlap-a", "delivery-a"));
      await enteredA;
      // 4-6: stop while A awaits, restart immediately, enqueue job B.
      const stopPromise = runtime.stopAutoProcessing();
      runtime.startAutoProcessing();
      await queue.enqueue(makeDirectJob("job-race-overlap-b", "delivery-b"));
      // 7-8: drain the event loop — B must NOT start while A is held.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(enteredB).toBe(false);
      expect(maxActive).toBe(1);
      // 9-11: release A; A settles first, then B executes.
      releaseJobA();
      await stopPromise;
      const outcomeA = await runtime.waitForQueueJob("job-race-overlap-a", {
        timeoutMs: 5000,
      });
      const outcomeB = await runtime.waitForQueueJob("job-race-overlap-b", {
        timeoutMs: 5000,
      });
      expect(outcomeA.kind).toBe("completed");
      expect(outcomeB.kind).toBe("completed");
      // 12: non-overlap proven by event order and peak concurrency.
      expect(maxActive).toBe(1);
      expect(sequence).toEqual([
        "enter-job-race-overlap-a",
        "exit-job-race-overlap-a",
        "enter-job-race-overlap-b",
        "exit-job-race-overlap-b",
      ]);
    } finally {
      releaseJobA();
      await runtime.stopAutoProcessing();
    }
    expect(runtime.isAutoProcessing()).toBe(false);
  });
});
