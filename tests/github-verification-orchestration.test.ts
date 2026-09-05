import { createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGitHubVerificationOrchestrator } from "../apps/github-bot/src/verification-orchestrator.js";
import {
  createGitHubWebhookHttpHandler,
  createInMemoryGitHubWebhookReplayGuard,
} from "../apps/github-bot/src/webhook.js";
import { createInMemoryVerificationJobQueue } from "../packages/engine/src/in-memory-job-queue.js";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const SECRET = "batch38-test-secret";
const OWNER = "octocat";
const REPOSITORY = "hello-world";
const DELIVERY = "delivery-batch38";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

function event(action: string) {
  return {
    action,
    repository: { owner: OWNER, name: REPOSITORY },
    pullRequest: {
      number: 7,
      base: { sha: BASE },
      head: { sha: SHA },
    },
  } as const;
}

function createQueueWithIds() {
  const queue = createInMemoryVerificationJobQueue();
  let counter = 0;
  const orchestrator = createGitHubVerificationOrchestrator(queue, {
    createJobId: () => `job-${(counter += 1)}`,
    now: () => CREATED_AT,
  });
  return { queue, orchestrator };
}

describe("GitHub verification orchestration", () => {
  it.each(["opened", "synchronize", "reopened"])(
    "enqueues exactly one job for supported action %s with the immutable head SHA",
    async (action) => {
      const { queue, orchestrator } = createQueueWithIds();

      const output = await orchestrator.handle(event(action), {
        deliveryId: DELIVERY,
      });

      expect(output.kind).toBe("enqueued");
      expect(queue.size()).toBe(1);
      const job = queue.jobs[0];
      expect(job.source).toEqual({
        kind: "snapshot",
        id: `${OWNER}:${REPOSITORY}:${SHA}`,
      });
      expect(job.source.id).not.toContain(BASE);
      expect(job.deliveryId).toBe(DELIVERY);
      expect(job.createdAt).toBe(CREATED_AT);
      expect(job.trigger).toMatchObject({
        kind: "pull-request",
        action,
        pullRequestNumber: 7,
      });
      if (output.kind === "enqueued") {
        expect(output.job).toEqual(job);
      }
    },
  );

  it.each(["closed", "edited", "labeled"])(
    "ignores unsupported action %s without enqueueing",
    async (action) => {
      const { queue, orchestrator } = createQueueWithIds();

      const output = await orchestrator.handle(event(action), {
        deliveryId: DELIVERY,
      });

      expect(output).toEqual({
        kind: "ignored",
        reason: `unsupported action: ${action}`,
      });
      expect(queue.size()).toBe(0);
    },
  );

  it("does not call verification synchronously; it only enqueues", async () => {
    const enqueue = vi.fn(async () => {});
    const orchestrator = createGitHubVerificationOrchestrator(
      { enqueue },
      {
        createJobId: () => "job-1",
        now: () => CREATED_AT,
      },
    );

    const output = await orchestrator.handle(event("opened"), {
      deliveryId: DELIVERY,
    });

    expect(output.kind).toBe("enqueued");
    expect(enqueue).toHaveBeenCalledTimes(1);
    const enqueued = enqueue.mock.calls[0][0];
    expect(enqueued.source).toEqual({
      kind: "snapshot",
      id: `${OWNER}:${REPOSITORY}:${SHA}`,
    });
  });

  it("requires a structured trusted event rather than raw webhook data", async () => {
    const { queue, orchestrator } = createQueueWithIds();

    await expect(
      orchestrator.handle({ rawBody: "{}" } as never, {
        deliveryId: DELIVERY,
      }),
    ).rejects.toThrow();
    expect(queue.size()).toBe(0);
  });

  it("requires a deliveryId and enqueues nothing without it", async () => {
    const { queue, orchestrator } = createQueueWithIds();

    await expect(
      orchestrator.handle(event("opened"), { deliveryId: "   " }),
    ).rejects.toThrow();
    expect(queue.size()).toBe(0);
  });
});

function signedPayload(action: string): string {
  return JSON.stringify({
    action,
    repository: { owner: { login: OWNER }, name: REPOSITORY },
    pull_request: {
      number: 7,
      base: { sha: BASE },
      head: { sha: SHA },
    },
  });
}

function requestJson(
  port: number,
  payload: string,
  signature: string,
  delivery = "delivery-batch38-http",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        port,
        method: "POST",
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
          "x-github-event": "pull_request",
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
    request.on("error", reject);
    request.end(payload);
  });
}

describe("GitHub webhook to verification queue", () => {
  it("authenticates then enqueues exactly one job", async () => {
    const payload = signedPayload("opened");
    const signature = `sha256=${createHmac("sha256", SECRET)
      .update(payload)
      .digest("hex")}`;
    const queue = createInMemoryVerificationJobQueue();
    const orchestrator = createGitHubVerificationOrchestrator(queue, {
      createJobId: () => "job-http-1",
      now: () => CREATED_AT,
    });
    const server = createServer(
      createGitHubWebhookHttpHandler({
        secret: SECRET,
        replayGuard: createInMemoryGitHubWebhookReplayGuard(),
        orchestrator,
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };

    const response = await requestJson(address.port, payload, signature);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(response.status).toBe(202);
    expect(queue.size()).toBe(1);
    expect(queue.jobs[0].source).toEqual({
      kind: "snapshot",
      id: `${OWNER}:${REPOSITORY}:${SHA}`,
    });
  });

  it("rejects an invalid signature before enqueueing", async () => {
    const queue = createInMemoryVerificationJobQueue();
    const server = createServer(
      createGitHubWebhookHttpHandler({
        secret: SECRET,
        orchestrator: createGitHubVerificationOrchestrator(queue),
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const response = await requestJson(
      address.port,
      signedPayload("opened"),
      `sha256=${"0".repeat(64)}`,
    );
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(response.status).toBe(401);
    expect(queue.size()).toBe(0);
  });
});
