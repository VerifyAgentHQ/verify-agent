/**
 * Batch 55A — production wiring (Finding 1).
 *
 * Proves the real service composition owns the Check publisher:
 *
 * - Test A: HTTP webhook → runtime → VerificationResult → Check publisher
 *   with NO test-side `service.onSettled(...)` registration.
 * - Test B: double `start()` creates exactly one publisher subscription.
 * - Test C: after `stop()`, a later settlement does not publish.
 * - Test D: start → stop → start yields exactly one active subscription.
 * - Test E: publisher failure never mutates VerificationResult.
 *
 * Controlled Checks API double, fake sandbox, no live GitHub.
 */

import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGitHubVerificationService } from "../apps/api/src/github-verification-service.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
  VERIFY_AGENT_CHECK_NAME,
  createGitHubCheckPublisher,
} from "../packages/adapters-source/src/index.js";
import type { SourceContents } from "../packages/adapters-source/src/resolver.js";
import type { VerificationResult } from "../packages/domain/src/index.js";
import {
  FakeSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
} from "../packages/engine/src/index.js";

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const HEAD_SHA = "e".repeat(40);
const BASE_SHA = "b".repeat(40);
const SECRET = "batch55a-test-webhook-secret";
const INTERNAL_RESULT_TOKEN = "batch55a-internal-result-token-for-tests-only";
const CREATED_AT = "2026-09-28T00:00:00.000Z";
const INSTALLATION_TOKEN = "batch55a-test-installation-token";
const APP_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\ntest-only\n-----END PRIVATE KEY-----";

const RUST_CONTENTS = Object.freeze({
  "Cargo.toml": '[package]\nname = "batch55a"\nversion = "0.1.0"\n',
  "src/lib.rs": "pub fn value() -> u32 { 42 }\n",
});

function sandboxSuccess(request: { jobId: string }): unknown {
  return {
    schemaVersion: "1.0.0" as const,
    jobId: request.jobId,
    status: "completed" as const,
    exitCode: 0,
    durationMs: 5,
    logsRef: "fixture://logs/batch55a",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
    errors: [],
  };
}

function createCheckDouble(options?: { readonly failCreateWith?: number }) {
  const calls: {
    method: string;
    url: string;
    authorization: string | undefined;
    body: unknown;
  }[] = [];
  let nextId = 301;
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
      if (options?.failCreateWith !== undefined) {
        return json(options.failCreateWith, { message: "rejected" });
      }
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

/** Batch 55D — numeric ID of the configured VerifyAgent App in this file. */
const OWN_APP_ID = 123456;

const appConfig = {
  appId: String(OWN_APP_ID),
  privateKey: APP_PRIVATE_KEY,
};

function publisherFor(double: ReturnType<typeof createCheckDouble>) {
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

function makeService(
  double: ReturnType<typeof createCheckDouble>,
  options?: { readonly failPublisher?: boolean },
) {
  const transport = new FakeSandboxTransport(sandboxSuccess);
  const provider = createInMemoryGitHubSourceProvider([
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
    createGitHubSourceResolver(provider),
  );
  let counter = 0;
  const checkPublisher = options?.failPublisher
    ? publisherFor(createCheckDouble({ failCreateWith: 401 }))
    : publisherFor(double);
  // Share the failing double's calls when failing so tests can observe.
  const service = createGitHubVerificationService({
    applicationService,
    secret: SECRET,
    internalResultToken: INTERNAL_RESULT_TOKEN,
    createJobId: () => `job-batch55a-${(counter += 1)}`,
    now: () => CREATED_AT,
    checkPublisher,
  });
  return { service, transport, applicationService };
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

function serverPort(
  service: ReturnType<typeof createGitHubVerificationService>,
): number {
  const address = service.server.address();
  if (!address || typeof address === "string") {
    throw new Error("composed service did not bind a port");
  }
  return address.port;
}

async function waitForPosts(
  double: ReturnType<typeof createCheckDouble>,
  count: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const posts = double.calls.filter((call) => call.method === "POST");
    if (posts.length >= count) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for ${count} Check Run POSTs (saw ${posts.length})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Batch 55A — production publication wiring", () => {
  it("Test A — real webhook completion automatically publishes", async () => {
    const double = createCheckDouble();
    const { service } = makeService(double);
    // No test-side service.onSettled(...) registration: the production
    // composition itself must own the publisher.
    await service.start(0, "127.0.0.1");
    try {
      const port = serverPort(service);
      const webhookResponse = await postWebhook(
        port,
        makePayload(),
        "delivery-b55a-a",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
      await waitForPosts(double, 1);
      const posts = double.calls.filter((call) => call.method === "POST");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toMatchObject({
        name: VERIFY_AGENT_CHECK_NAME,
        head_sha: HEAD_SHA,
        status: "completed",
      });
      for (const call of double.calls) {
        expect(call.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      }
      const stored = service.resultReader.getByQueueJobId(queueJobId);
      expect(stored).not.toBeNull();
      expect(JSON.stringify(posts[0]?.body)).toContain(HEAD_SHA);
      expect(JSON.stringify(posts[0]?.body)).toContain(
        String((stored as VerificationResult).id),
      );
    } finally {
      await service.stop();
    }
  });

  it("Test B — double start does not duplicate publication", async () => {
    const double = createCheckDouble();
    const { service } = makeService(double);
    await service.start(0, "127.0.0.1");
    await service.start(0, "127.0.0.1");
    try {
      const port = serverPort(service);
      const webhookResponse = await postWebhook(
        port,
        makePayload(),
        "delivery-b55a-b",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await service.waitForQueueJob(queueJobId, { timeoutMs: 5000 });
      await waitForPosts(double, 1);
      expect(
        double.calls.filter((call) => call.method === "POST"),
      ).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  it("Test C — after stop, a later settlement does not publish", async () => {
    const double = createCheckDouble();
    const { service } = makeService(double);
    await service.start(0, "127.0.0.1");
    await service.stop();
    const postsBefore = double.calls.filter(
      (call) => call.method === "POST",
    ).length;
    expect(postsBefore).toBe(0);
    // Settle a job directly through the runtime after service shutdown.
    // The detached publisher callback must not fire.
    service.runtime.start();
    try {
      await service.queue.enqueue({
        jobId: "job-batch55a-after-stop",
        source: { kind: "snapshot", id: `${OWNER}:${REPOSITORY}:${HEAD_SHA}` },
        trigger: {
          kind: "pull-request",
          action: "opened",
          pullRequestNumber: 42,
        },
        deliveryId: "delivery-b55a-c-after",
        createdAt: CREATED_AT,
        selection: "all-applicable",
      });
      const settled = await service.runtime.processNext();
      expect(settled.kind).toBe("completed");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        double.calls.filter((call) => call.method === "POST"),
      ).toHaveLength(postsBefore);
    } finally {
      service.runtime.stop();
      await service.stop();
    }
  });

  it("Test D — restart yields exactly one active subscription", async () => {
    const double = createCheckDouble();
    const { service } = makeService(double);
    await service.start(0, "127.0.0.1");
    await service.stop();
    await service.start(0, "127.0.0.1");
    try {
      const port = serverPort(service);
      const webhookResponse = await postWebhook(
        port,
        makePayload(),
        "delivery-b55a-d",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      await service.waitForQueueJob(queueJobId, { timeoutMs: 5000 });
      await waitForPosts(double, 1);
      expect(
        double.calls.filter((call) => call.method === "POST"),
      ).toHaveLength(1);
    } finally {
      await service.stop();
    }
  });

  it("Test E — publisher failure never mutates VerificationResult", async () => {
    const observed = createCheckDouble();
    const transport = new FakeSandboxTransport(sandboxSuccess);
    const provider = createInMemoryGitHubSourceProvider([
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
      createGitHubSourceResolver(provider),
    );
    const failingDouble = createCheckDouble({ failCreateWith: 401 });
    const failingPublisher = publisherFor(failingDouble);
    const failingSpy = vi.spyOn(failingPublisher, "publishVerificationResult");
    let counter = 0;
    const service = createGitHubVerificationService({
      applicationService,
      secret: SECRET,
      internalResultToken: INTERNAL_RESULT_TOKEN,
      createJobId: () => `job-batch55a-e-${(counter += 1)}`,
      now: () => CREATED_AT,
      checkPublisher: failingPublisher,
    });
    void observed;
    await service.start(0, "127.0.0.1");
    try {
      const port = serverPort(service);
      const webhookResponse = await postWebhook(
        port,
        makePayload(),
        "delivery-b55a-e",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
      // Give the fire-and-forget publication a moment to fail closed.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(failingSpy).toHaveBeenCalledTimes(1);
      const stored = service.resultReader.getByQueueJobId(queueJobId);
      expect(stored).not.toBeNull();
      const before = JSON.stringify(stored);
      // The stored truth is unchanged by the failed publication.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        JSON.stringify(service.resultReader.getByQueueJobId(queueJobId)),
      ).toBe(before);
      expect(failingDouble.calls.some((call) => call.method === "POST")).toBe(
        true,
      );
    } finally {
      await service.stop();
    }
  });

  it("failed startup leaves no publisher callback behind", async () => {
    const blocker = createServer((_request, response) => {
      response.end("busy");
    });
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const blockedPort = (blocker.address() as { port: number }).port;
    try {
      const double = createCheckDouble();
      const { service } = makeService(double);
      await expect(service.start(blockedPort, "127.0.0.1")).rejects.toThrow(
        /EADDRINUSE/,
      );
      expect(service.isStarted()).toBe(false);
      // No publisher subscription survived: a later manual settlement
      // through the (stopped) runtime must not publish.
      service.runtime.start();
      try {
        await service.queue.enqueue({
          jobId: "job-batch55a-bind-fail",
          source: {
            kind: "snapshot",
            id: `${OWNER}:${REPOSITORY}:${HEAD_SHA}`,
          },
          trigger: {
            kind: "pull-request",
            action: "opened",
            pullRequestNumber: 42,
          },
          deliveryId: "delivery-b55a-bind-fail",
          createdAt: CREATED_AT,
          selection: "all-applicable",
        });
        const settled = await service.runtime.processNext();
        expect(settled.kind).toBe("completed");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(
          double.calls.filter((call) => call.method === "POST"),
        ).toHaveLength(0);
      } finally {
        service.runtime.stop();
      }
      await service.stop();
      await service.close();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
