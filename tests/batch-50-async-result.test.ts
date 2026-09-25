/**
 * Batch 50 — Asynchronous Verification Result Observation.
 *
 * Proves the smallest stable in-process composition:
 *
 * ```text
 * authenticated GitHub webhook
 *   ↓ VerificationQueueJob (202 returns queueJobId lookup handle)
 *   ↓ in-process runtime (explicit start/processNext, no timers/loops)
 *   ↓ worker (existing VerificationJobProcessor boundary)
 *   ↓ VerificationResult (real pipeline through FakeSandboxTransport)
 *   ↓ result registry (bounded, process-local, non-durable)
 *   ↓ protected result reader (VerificationResultReader + internal token)
 *   ↓ GET /verification-jobs/:queueJobId/result (explicitly protected)
 * ```
 *
 * Semantics are honest:
 * - 200 = retained result currently available (authenticated only)
 * - 401 = missing/invalid internal result token (no existence oracle)
 * - 404 = no retained result currently available (not completed yet,
 *   evicted, process restarted, or unknown ID). Never claims the job
 *   never ran and never fabricates queued/processing states.
 *
 * Async result observation is process-local, bounded, non-durable,
 * explicitly protected, and not a general public production API. The
 * queue job ID is a lookup handle, never an authentication credential.
 * Normal configured API startup wires no reader/token, so the route is
 * unavailable there.
 *
 * No durable queue, database, worker daemon, retries, GitHub writes, AI,
 * frontend, second server, or sandbox redesign are involved.
 */

import { createHmac } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createVerificationApi } from "../apps/api/src/index.js";
import {
  createConfiguredGitHubWebhookHandler,
  createInMemoryGitHubWebhookReplayGuard,
} from "../apps/github-bot/src/webhook.js";
import { createGitHubVerificationOrchestrator } from "../apps/github-bot/src/verification-orchestrator.js";
import {
  createInMemoryVerificationResultRegistry,
  createVerificationJobProcessor,
  createVerificationJobRuntime,
} from "../apps/worker/src/index.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
} from "../packages/adapters-source/src/github.js";
import {
  createVerificationQueueJob,
  isValidVerificationQueueJobId,
} from "../packages/domain/src/verification-queue.js";
import {
  FakeSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createInMemoryVerificationJobQueue,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
} from "../packages/engine/src/index.js";

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const HEAD_SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SECRET = "batch50-test-secret";
const INTERNAL_RESULT_TOKEN = "batch50-internal-result-token-for-tests-only";
const VALID_AUTH = `Bearer ${INTERNAL_RESULT_TOKEN}`;
const CREATED_AT = "2026-09-25T00:00:00.000Z";
const SOURCE_ID = `${OWNER}:${REPOSITORY}:${HEAD_SHA}`;
const EXPECTED_SNAPSHOT_ID = `${OWNER}--${REPOSITORY}--${HEAD_SHA}`;

const FIXTURE_CONTENTS = Object.freeze({
  "package.json": JSON.stringify({
    name: "batch50-fixture",
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
    logsRef: "fixture://logs/batch50",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
    errors: [],
  };
}

interface Batch50Composition {
  readonly queue: ReturnType<typeof createInMemoryVerificationJobQueue>;
  readonly transport: FakeSandboxTransport;
  readonly applicationService: VerificationApplicationService;
  readonly registry: ReturnType<
    typeof createInMemoryVerificationResultRegistry
  >;
  readonly runtime: ReturnType<typeof createVerificationJobRuntime>;
  readonly webhookHandler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void;
  readonly api: ReturnType<typeof createVerificationApi>;
}

function createBatch50Composition(options?: {
  readonly maxResults?: number;
  readonly shas?: readonly string[];
  readonly createJobId?: () => string;
  readonly internalResultToken?: string | null;
}): Batch50Composition {
  const shas = options?.shas ?? [HEAD_SHA];
  const queue = createInMemoryVerificationJobQueue();
  const replayGuard = createInMemoryGitHubWebhookReplayGuard();
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
  const pipeline = createVerificationPipeline({
    detector: createProjectDetectionService(),
    executor: createCheckExecutor(
      createSandboxExecutorFromTransport(transport),
    ),
  });
  const applicationService = new VerificationApplicationService(
    pipeline,
    createGitHubSourceResolver(provider),
  );
  const processor = createVerificationJobProcessor(applicationService);
  const registry = createInMemoryVerificationResultRegistry(
    options?.maxResults === undefined ? {} : { maxResults: options.maxResults },
  );
  const runtime = createVerificationJobRuntime({
    queue,
    processor,
    registry,
  });
  let counter = 0;
  const orchestrator = createGitHubVerificationOrchestrator(queue, {
    createJobId:
      options?.createJobId ?? (() => `job-batch50-${(counter += 1)}`),
    now: () => CREATED_AT,
  });
  const webhookHandler = createConfiguredGitHubWebhookHandler({
    secret: SECRET,
    replayGuard,
    orchestrator,
  });
  // The API depends only on the provider-neutral reader port, never on
  // registry internals: the bounded registry satisfies the port
  // structurally (undefined/null both mean "no retained result").
  // The result route is explicitly protected: it requires BOTH the reader
  // and the internal result token. `internalResultToken: null` simulates
  // misconfiguration (fail-closed → route unavailable).
  const configuredToken =
    options && "internalResultToken" in options
      ? options.internalResultToken
      : INTERNAL_RESULT_TOKEN;
  const api =
    configuredToken === null
      ? createVerificationApi(applicationService, registry)
      : createVerificationApi(applicationService, registry, {
          internalResultToken: configuredToken,
        });
  return {
    queue,
    transport,
    applicationService,
    registry,
    runtime,
    webhookHandler,
    api,
  };
}

function makePullRequestPayload(action = "opened", sha = HEAD_SHA): string {
  return JSON.stringify({
    action,
    repository: {
      owner: { login: OWNER },
      name: REPOSITORY,
    },
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
  // `undefined` → valid internal token (existing observation tests).
  // `null` → no Authorization header (missing-auth tests).
  // string → explicit Authorization header value (invalid-auth tests).
  auth: string | null | undefined = VALID_AUTH,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...extraHeaders };
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

async function withBatch50Servers(
  composition: Batch50Composition,
  fn: (ports: { webhookPort: number; apiPort: number }) => Promise<void>,
): Promise<void> {
  const webhookServer = createServer(composition.webhookHandler as never);
  await new Promise<void>((resolve) =>
    webhookServer.listen(0, "127.0.0.1", resolve),
  );
  const webhookAddress = webhookServer.address() as { port: number };
  await new Promise<void>((resolve) =>
    composition.api.server.listen(0, "127.0.0.1", () => resolve()),
  );
  const apiAddress = composition.api.server.address() as { port: number };
  try {
    await fn({ webhookPort: webhookAddress.port, apiPort: apiAddress.port });
  } finally {
    await new Promise<void>((resolve) => webhookServer.close(() => resolve()));
    await composition.api.close();
  }
}

async function withApiServer(
  api: ReturnType<typeof createVerificationApi>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  await new Promise<void>((resolve) =>
    api.server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = api.server.address() as { port: number };
  try {
    await fn(address.port);
  } finally {
    await api.close();
  }
}

describe("Batch 50 — Asynchronous Verification Result Observation", () => {
  it("Test 1 — webhook returns queue job ID", async () => {
    const composition = createBatch50Composition();
    await withBatch50Servers(composition, async ({ webhookPort }) => {
      const payload = makePullRequestPayload("opened");
      const response = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t1",
      );
      expect(response.status).toBe(202);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body.status).toBe("accepted");
      expect(typeof body.queueJobId).toBe("string");
      expect((body.queueJobId as string).length).toBeGreaterThan(0);
      // The returned handle is the actual queue job identity, not a
      // fabricated result or verification identity.
      expect(composition.queue.size()).toBe(1);
      expect(body.queueJobId).toBe(composition.queue.jobs[0].jobId);
      expect(JSON.stringify(body)).not.toContain(SECRET);
    });
  });

  it("Test 2 — unknown result", async () => {
    const composition = createBatch50Composition();
    await withBatch50Servers(composition, async ({ apiPort }) => {
      // HTTP caller uses only the lookup handle; no queue/registry access.
      const response = await httpGet(
        apiPort,
        "/verification-jobs/job-does-not-exist-123/result",
      );
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: { code: "not_found", message: "no retained result" },
      });
      expect(response.body).not.toContain("stack");
      expect(response.body).not.toContain("registry");
    });
  });

  it("Test 3 — completed result retrieval", async () => {
    const composition = createBatch50Composition();
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t3",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;

      // Before explicit runtime consumption: honestly 404.
      const before = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(before.status).toBe(404);

      // Explicit consumption owned by the runtime (no timers/loops).
      // The HTTP caller never touches queue.jobs, registry internals,
      // or the worker processor; it only reuses the webhook handle.
      const outcome = await composition.runtime.processNext();
      expect(outcome.kind).toBe("completed");

      const after = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(after.status).toBe(200);
      const body = JSON.parse(after.body) as Record<string, unknown>;
      expect(body.queueJobId).toBe(queueJobId);
    });
  });

  it("Test 4 — correct identity", async () => {
    const composition = createBatch50Composition();
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t4",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await composition.runtime.processNext();
      const response = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as {
        queueJobId: string;
        verificationId: string;
        jobId: string;
      };
      // Three identity domains stay distinct; the queue handle only
      // correlates, never conflates.
      expect(typeof body.queueJobId).toBe("string");
      expect(typeof body.verificationId).toBe("string");
      expect(typeof body.jobId).toBe("string");
      expect(body.queueJobId).toBe(queueJobId);
      expect(body.jobId).not.toBe(body.queueJobId);
      expect(body.verificationId).not.toBe(body.queueJobId);
    });
  });

  it("Test 5 — provenance preserved", async () => {
    const composition = createBatch50Composition();
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t5",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await composition.runtime.processNext();
      const response = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body.snapshotId).toBe(EXPECTED_SNAPSHOT_ID);
      expect(String(body.snapshotId)).toContain(HEAD_SHA);
      expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(body.resultVersion).toBe("1.0.0");
      expect(typeof body.status).toBe("string");
      expect(typeof body.policyDecision).toBe("string");
      expect(body.coverage).toBeDefined();
      expect((body.coverage as Record<string, unknown>).verified).toBeDefined();
      expect(Array.isArray(body.findings)).toBe(true);
      expect(Array.isArray(body.evidenceReferences)).toBe(true);
      expect(Array.isArray(body.checkResults)).toBe(true);
      expect(typeof body.summary).toBe("string");
      expect(typeof body.createdAt).toBe("string");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain("ghs_");
    });
  });

  it("Test 6 — eviction", async () => {
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const shaC = "c".repeat(40);
    const composition = createBatch50Composition({
      maxResults: 2,
      shas: [shaA, shaB, shaC],
    });
    composition.runtime.start();
    for (const [index, sha] of [shaA, shaB, shaC].entries()) {
      await composition.queue.enqueue(
        createVerificationQueueJob({
          jobId: `job-b50-evict-${index}`,
          source: { kind: "snapshot", id: `${OWNER}:${REPOSITORY}:${sha}` },
          trigger: {
            kind: "pull-request",
            action: "opened",
            pullRequestNumber: 42,
          },
          deliveryId: `delivery-b50-evict-${index}`,
          createdAt: CREATED_AT,
        }),
      );
    }
    await composition.runtime.drain();
    await withBatch50Servers(composition, async ({ apiPort }) => {
      const evicted = await httpGet(
        apiPort,
        "/verification-jobs/job-b50-evict-0/result",
      );
      // Honest semantics: no retained result (not "never ran").
      expect(evicted.status).toBe(404);
      expect(JSON.parse(evicted.body)).toEqual({
        error: { code: "not_found", message: "no retained result" },
      });
      const retainedB = await httpGet(
        apiPort,
        "/verification-jobs/job-b50-evict-1/result",
      );
      expect(retainedB.status).toBe(200);
      const retainedC = await httpGet(
        apiPort,
        "/verification-jobs/job-b50-evict-2/result",
      );
      expect(retainedC.status).toBe(200);
    });
  });

  it("Test 7 — safe errors", async () => {
    const throwingReader = {
      getByQueueJobId(_queueJobId: string): never {
        throw new Error(
          "secret-internal-failure with token ghp_xxx at /tmp/secret",
        );
      },
    };
    const api = createVerificationApi(
      {
        verifySource: async () => {
          throw new Error("unreachable");
        },
      } as never,
      throwingReader,
      { internalResultToken: INTERNAL_RESULT_TOKEN },
    );
    await withApiServer(api, async (port) => {
      const response = await httpGet(
        port,
        "/verification-jobs/job-b50-x/result",
      );
      expect(response.status).toBe(500);
      expect(JSON.parse(response.body)).toEqual({
        error: { code: "internal_error", message: "verification failed" },
      });
      expect(response.body).not.toContain("secret-internal-failure");
      expect(response.body).not.toContain("ghp_xxx");
      expect(response.body).not.toContain("/tmp/secret");
      expect(response.body).not.toContain("stack");
    });
  });

  it("Test 8 — invalid/malformed identifier", async () => {
    const composition = createBatch50Composition();
    await withBatch50Servers(composition, async ({ apiPort }) => {
      const malformed = await httpGet(apiPort, "/verification-jobs/!!!/result");
      expect(malformed.status).toBe(400);
      expect(JSON.parse(malformed.body)).toEqual({
        error: { code: "invalid_request", message: "invalid queue job id" },
      });
      const traversal = await httpGet(
        apiPort,
        "/verification-jobs/%2E%2E/result",
      );
      expect(traversal.status).toBe(400);
      const wrongMethod = await httpGet(
        apiPort,
        "/verification-jobs/job-b50-x/result",
        "POST",
      );
      expect(wrongMethod.status).toBe(405);
      expect(JSON.parse(wrongMethod.body)).toEqual({
        error: { code: "method_not_allowed", message: "method not allowed" },
      });
    });
  });

  it("Test 9 — asynchronous separation", async () => {
    const composition = createBatch50Composition();
    const spy = vi.spyOn(composition.applicationService, "verifySource");
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t9",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      // Webhook returns before runtime consumption.
      expect(spy).not.toHaveBeenCalled();
      // GET never executes verification.
      const before = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(before.status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
      await composition.runtime.processNext();
      expect(spy).toHaveBeenCalledTimes(1);
      const after = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(after.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("Test 10 — existing synchronous API regression", async () => {
    const composition = createBatch50Composition();
    await withBatch50Servers(composition, async ({ apiPort }) => {
      const response = await httpPostVerify(apiPort, {
        source: { kind: "snapshot", id: SOURCE_ID },
      });
      expect(response.status).toBe(200);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body.source).toEqual({ kind: "snapshot", id: SOURCE_ID });
      expect(typeof body.status).toBe("string");
      expect(body.coverage).toBeDefined();
      expect(Array.isArray(body.findings)).toBe(true);
      expect(typeof body.policyDecision).toBe("string");
      expect(typeof body.summary).toBe("string");
      expect(typeof body.contentHash).toBe("string");
      const invalid = await httpPostVerify(apiPort, {});
      expect(invalid.status).toBe(400);
      const health = await httpGet(apiPort, "/health");
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ status: "ok" });
    });
  });

  it("Test 11 — unsupported/replayed webhook", async () => {
    const composition = createBatch50Composition();
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const closedPayload = makePullRequestPayload("closed");
      const closed = await postWebhook(
        webhookPort,
        closedPayload,
        signPayload(closedPayload),
        "delivery-b50-t11-closed",
      );
      expect(closed.status).toBe(202);
      const closedBody = JSON.parse(closed.body) as Record<string, unknown>;
      expect(closedBody.status).toBe("ignored");
      expect(closedBody.queueJobId).toBeUndefined();
      expect(composition.queue.size()).toBe(0);

      const openedPayload = makePullRequestPayload("opened");
      const first = await postWebhook(
        webhookPort,
        openedPayload,
        signPayload(openedPayload),
        "delivery-b50-t11-replay",
      );
      expect(first.status).toBe(202);
      expect(composition.queue.size()).toBe(1);
      const second = await postWebhook(
        webhookPort,
        openedPayload,
        signPayload(openedPayload),
        "delivery-b50-t11-replay",
      );
      expect(second.status).toBe(409);
      expect(composition.queue.size()).toBe(1);

      // No duplicate job: exactly one result after explicit drain, and
      // the replayed delivery never yields a second handle.
      const outcomes = await composition.runtime.drain();
      expect(outcomes).toHaveLength(1);
      const queueJobId = (JSON.parse(first.body) as { queueJobId: string })
        .queueJobId;
      const fetched = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
      );
      expect(fetched.status).toBe(200);
    });
  });

  it("Test 12 (A) — missing authentication is 401 without existence oracle", async () => {
    const composition = createBatch50Composition();
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t12",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await composition.runtime.processNext();

      const retainedWithoutAuth = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
        "GET",
        null,
      );
      expect(retainedWithoutAuth.status).toBe(401);
      expect(JSON.parse(retainedWithoutAuth.body)).toEqual({
        error: { code: "unauthorized", message: "unauthorized" },
      });

      const unknownWithoutAuth = await httpGet(
        apiPort,
        "/verification-jobs/job-does-not-exist-999/result",
        "GET",
        null,
      );
      expect(unknownWithoutAuth.status).toBe(401);
      // Same generic body: no oracle distinguishing retained vs unknown.
      expect(unknownWithoutAuth.body).toBe(retainedWithoutAuth.body);
      expect(unknownWithoutAuth.body).not.toContain(queueJobId);
      expect(unknownWithoutAuth.body).not.toContain(SECRET);
    });
  });

  it("Test 13 (B) — invalid authentication is 401 with no disclosure", async () => {
    const composition = createBatch50Composition();
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t13",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await composition.runtime.processNext();
      const path = `/verification-jobs/${encodeURIComponent(queueJobId)}/result`;

      for (const bad of [
        "Bearer wrong-token",
        "Bearer ",
        "Basic abc123",
        "bearer batch50-internal-result-token-for-tests-only",
        "",
      ]) {
        const response = await httpGet(apiPort, path, "GET", bad);
        expect(response.status).toBe(401);
        expect(JSON.parse(response.body)).toEqual({
          error: { code: "unauthorized", message: "unauthorized" },
        });
        expect(response.body).not.toContain(queueJobId);
      }

      // Query-string token is never accepted.
      const queryToken = await httpGet(
        apiPort,
        `${path}?token=${encodeURIComponent(INTERNAL_RESULT_TOKEN)}`,
        "GET",
        null,
      );
      expect(queryToken.status).toBe(401);

      // Queue ID as credential is never accepted.
      const queueIdAsAuth = await httpGet(
        apiPort,
        path,
        "GET",
        `Bearer ${queueJobId}`,
      );
      expect(queueIdAsAuth.status).toBe(401);
    });
  });

  it("Test 14 (C/D) — valid auth preserves 200/404 lookup semantics", async () => {
    const composition = createBatch50Composition();
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t14",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await composition.runtime.processNext();

      const retained = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
        "GET",
        VALID_AUTH,
      );
      expect(retained.status).toBe(200);
      expect(
        (JSON.parse(retained.body) as { queueJobId: string }).queueJobId,
      ).toBe(queueJobId);

      const unknown = await httpGet(
        apiPort,
        "/verification-jobs/job-unknown-b50-14/result",
        "GET",
        VALID_AUTH,
      );
      expect(unknown.status).toBe(404);
      expect(JSON.parse(unknown.body)).toEqual({
        error: { code: "not_found", message: "no retained result" },
      });
    });
  });

  it("Test 15 (E) — reader without token leaves the route unavailable", async () => {
    const composition = createBatch50Composition({
      internalResultToken: null,
    });
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t15",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await composition.runtime.processNext();

      // Even with a retained result and even with a token-looking header,
      // misconfiguration fails closed as if the route did not exist.
      for (const auth of [VALID_AUTH, null, "Bearer wrong"] as const) {
        const response = await httpGet(
          apiPort,
          `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
          "GET",
          auth,
        );
        expect(response.status).toBe(404);
        expect(JSON.parse(response.body)).toEqual({
          error: { code: "not_found", message: "route not found" },
        });
      }

      // No-reader composition is equally unavailable.
      const noReaderApi = createVerificationApi(
        composition.applicationService,
        null,
        { internalResultToken: INTERNAL_RESULT_TOKEN },
      );
      await withApiServer(noReaderApi, async (port) => {
        const response = await httpGet(
          port,
          `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
          "GET",
          VALID_AUTH,
        );
        expect(response.status).toBe(404);
        expect(JSON.parse(response.body)).toEqual({
          error: { code: "not_found", message: "route not found" },
        });
      });
    });
  });

  it("Test 16 (F) — domain-valid long queue ID is accepted end to end", async () => {
    const longJobId = `j${"a".repeat(499)}`;
    expect(longJobId.length).toBe(500);
    expect(longJobId.length).toBeGreaterThan(256);
    expect(isValidVerificationQueueJobId(longJobId)).toBe(true);
    const composition = createBatch50Composition({
      createJobId: () => longJobId,
    });
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t16-long",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      expect(queueJobId).toBe(longJobId);
      expect(queueJobId).toBe(composition.queue.jobs[0].jobId);

      const outcome = await composition.runtime.processNext();
      expect(outcome.kind).toBe("completed");

      // The API must accept every domain-valid ID: no API-only ceiling.
      const fetched = await httpGet(
        apiPort,
        `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
        "GET",
        VALID_AUTH,
      );
      expect(fetched.status).toBe(200);
      expect(
        (JSON.parse(fetched.body) as { queueJobId: string }).queueJobId,
      ).toBe(longJobId);
    });
  });

  it("Test 17 (G) — webhook queueJobId equals the actual queue job identity", async () => {
    const composition = createBatch50Composition();
    await withBatch50Servers(composition, async ({ webhookPort }) => {
      const payload = makePullRequestPayload("opened");
      const response = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t17",
      );
      expect(response.status).toBe(202);
      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body.status).toBe("accepted");
      expect(body.queueJobId).toBe(composition.queue.jobs[0].jobId);
    });
  });

  it("Test 18 (H) — authentication failure never triggers processing", async () => {
    const composition = createBatch50Composition();
    const spy = vi.spyOn(composition.applicationService, "verifySource");
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t18",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      const path = `/verification-jobs/${encodeURIComponent(queueJobId)}/result`;
      const unauth = await httpGet(apiPort, path, "GET", null);
      expect(unauth.status).toBe(401);
      const badAuth = await httpGet(apiPort, path, "GET", "Bearer wrong");
      expect(badAuth.status).toBe(401);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("Test 19 (I) — valid GET never triggers processing", async () => {
    const composition = createBatch50Composition();
    const spy = vi.spyOn(composition.applicationService, "verifySource");
    composition.runtime.start();
    await withBatch50Servers(composition, async ({ webhookPort, apiPort }) => {
      const payload = makePullRequestPayload("opened");
      const webhookResponse = await postWebhook(
        webhookPort,
        payload,
        signPayload(payload),
        "delivery-b50-t19",
      );
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      const path = `/verification-jobs/${encodeURIComponent(queueJobId)}/result`;
      const before = await httpGet(apiPort, path, "GET", VALID_AUTH);
      expect(before.status).toBe(404);
      expect(spy).not.toHaveBeenCalled();
      await composition.runtime.processNext();
      expect(spy).toHaveBeenCalledTimes(1);
      const after = await httpGet(apiPort, path, "GET", VALID_AUTH);
      expect(after.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("Test 20 (J) — safe error stays protected and unauthenticated stays 401", async () => {
    const throwingReader = {
      getByQueueJobId(_queueJobId: string): never {
        throw new Error(
          "secret-internal-failure with token ghp_yyy at /tmp/secret-j",
        );
      },
    };
    const api = createVerificationApi(
      {
        verifySource: async () => {
          throw new Error("unreachable");
        },
      } as never,
      throwingReader,
      { internalResultToken: INTERNAL_RESULT_TOKEN },
    );
    await withApiServer(api, async (port) => {
      const authed = await httpGet(
        port,
        "/verification-jobs/job-b50-j/result",
        "GET",
        VALID_AUTH,
      );
      expect(authed.status).toBe(500);
      expect(JSON.parse(authed.body)).toEqual({
        error: { code: "internal_error", message: "verification failed" },
      });
      expect(authed.body).not.toContain("secret-internal-failure");
      expect(authed.body).not.toContain("ghp_yyy");
      expect(authed.body).not.toContain("/tmp/secret-j");

      const unauthed = await httpGet(
        port,
        "/verification-jobs/job-b50-j/result",
        "GET",
        null,
      );
      expect(unauthed.status).toBe(401);
      expect(unauthed.body).not.toContain("secret-internal-failure");
    });
  });

  it("Test 21 — unauthenticated malformed ID and method still 401 (no oracle)", async () => {
    const composition = createBatch50Composition();
    await withBatch50Servers(composition, async ({ apiPort }) => {
      const malformed = await httpGet(
        apiPort,
        "/verification-jobs/!!!/result",
        "GET",
        null,
      );
      expect(malformed.status).toBe(401);
      const wrongMethod = await httpGet(
        apiPort,
        "/verification-jobs/job-b50-x/result",
        "POST",
        null,
      );
      expect(wrongMethod.status).toBe(401);
    });
  });
});
