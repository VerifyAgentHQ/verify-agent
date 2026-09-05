import { createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { createGitHubVerificationOrchestrator } from "../apps/github-bot/src/verification-orchestrator.js";
import {
  GitHubWebhookConfigurationError,
  createConfiguredGitHubWebhookHandler,
  createGitHubWebhookHttpHandler,
  createInMemoryGitHubWebhookReplayGuard,
} from "../apps/github-bot/src/webhook.js";
import { createInMemoryVerificationJobQueue } from "../packages/engine/src/in-memory-job-queue.js";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const SECRET = "batch38-production-test-secret";
const OWNER = "octocat";
const REPOSITORY = "hello-world";
const CREATED_AT = "2026-02-01T00:00:00.000Z";

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

function signatureFor(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

function createOrchestrator() {
  const queue = createInMemoryVerificationJobQueue();
  let counter = 0;
  const orchestrator = createGitHubVerificationOrchestrator(queue, {
    createJobId: () => `job-prod-${(counter += 1)}`,
    now: () => CREATED_AT,
  });
  return { queue, orchestrator };
}

function postWebhook(
  port: number,
  payload: string,
  signature: string,
  delivery = `delivery-${Math.random().toString(36).slice(2)}`,
  event = "pull_request",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        port,
        method: "POST",
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
          "x-github-event": event,
          "x-github-delivery": delivery,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function withServer(
  handler: (req: never, res: never) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    await fn(address.port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("production GitHub webhook composition", () => {
  it("fails immediately when the orchestrator is omitted", () => {
    expect(() =>
      createConfiguredGitHubWebhookHandler({
        secret: SECRET,
      } as unknown as never),
    ).toThrow(GitHubWebhookConfigurationError);

    expect(() =>
      createConfiguredGitHubWebhookHandler({
        secret: SECRET,
        orchestrator: undefined,
      } as unknown as never),
    ).toThrow(GitHubWebhookConfigurationError);

    expect(() =>
      createConfiguredGitHubWebhookHandler({
        secret: SECRET,
        orchestrator: null,
      } as unknown as never),
    ).toThrow(GitHubWebhookConfigurationError);
  });

  it("fails immediately for a non-orchestrator value without starting a handler", () => {
    expect(() =>
      createConfiguredGitHubWebhookHandler({
        secret: SECRET,
        orchestrator: {},
      } as unknown as never),
    ).toThrow(GitHubWebhookConfigurationError);
  });

  it("fails immediately when the secret is missing without leaking secrets", () => {
    const { orchestrator } = createOrchestrator();
    try {
      createConfiguredGitHubWebhookHandler({
        secret: "",
        orchestrator,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubWebhookConfigurationError);
      expect(String(error)).not.toContain(SECRET);
      expect((error as Error).message).not.toContain(SECRET);
    }
  });

  it("does not leak the secret in orchestrator-omission errors", () => {
    try {
      createConfiguredGitHubWebhookHandler({
        secret: SECRET,
      } as unknown as never);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubWebhookConfigurationError);
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("enqueues exactly one job for an authenticated supported PR and returns 202", async () => {
    const payload = signedPayload("opened");
    const delivery = "delivery-prod-1";
    const { queue, orchestrator } = createOrchestrator();
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(
        port,
        payload,
        signatureFor(payload),
        delivery,
      );
      expect(response.status).toBe(202);
      expect(queue.size()).toBe(1);
      const job = queue.jobs[0];
      expect(job.source).toEqual({
        kind: "snapshot",
        id: `${OWNER}:${REPOSITORY}:${SHA}`,
      });
      expect(job.deliveryId).toBe(delivery);
      expect(JSON.parse(response.body)).toMatchObject({
        status: "accepted",
        deliveryId: delivery,
      });
    });
  });

  it("does not enqueue for invalid signatures", async () => {
    const { queue, orchestrator } = createOrchestrator();
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(
        port,
        signedPayload("opened"),
        `sha256=${"0".repeat(64)}`,
      );
      expect(response.status).toBe(401);
      expect(queue.size()).toBe(0);
    });
  });

  it("does not enqueue for unsupported actions and preserves ignored behavior", async () => {
    const payload = signedPayload("closed");
    const { queue, orchestrator } = createOrchestrator();
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(port, payload, signatureFor(payload));
      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toMatchObject({ status: "ignored" });
      expect(queue.size()).toBe(0);
    });
  });

  it("does not enqueue replayed deliveries", async () => {
    const payload = signedPayload("opened");
    const { queue, orchestrator } = createOrchestrator();
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const first = await postWebhook(
        port,
        payload,
        signatureFor(payload),
        "delivery-replay-38",
      );
      expect(first.status).toBe(202);
      expect(queue.size()).toBe(1);
      const second = await postWebhook(
        port,
        payload,
        signatureFor(payload),
        "delivery-replay-38",
      );
      expect(second.status).toBe(409);
      expect(queue.size()).toBe(1);
    });
  });

  it("returns safe server error without enqueueing when the queue fails", async () => {
    const payload = signedPayload("opened");
    const failingQueue = {
      enqueue: async () => {
        throw new Error("queue backend exploded with secret-material");
      },
    };
    const orchestrator = createGitHubVerificationOrchestrator(
      failingQueue as never,
    );
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(port, payload, signatureFor(payload));
      expect(response.status).toBe(500);
      expect(response.body).toContain("internal server error");
      expect(response.body).not.toContain("secret-material");
      expect(response.body).not.toContain(SECRET);
    });
  });

  it("queue failure leaves delivery retryable", async () => {
    const payload = signedPayload("opened");
    const delivery = "delivery-retry-after-fail";
    let failFirst = true;
    const conditionalQueue = {
      enqueue: async () => {
        if (failFirst) {
          failFirst = false;
          throw new Error("transient queue failure");
        }
      },
    };
    const orchestrator = createGitHubVerificationOrchestrator(
      conditionalQueue as never,
    );
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: guard,
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const first = await postWebhook(
        port,
        payload,
        signatureFor(payload),
        delivery,
      );
      expect(first.status).toBe(500);
      expect(first.body).toContain("internal server error");

      expect(guard.isReplay(delivery)).toBe(false);

      const second = await postWebhook(
        port,
        payload,
        signatureFor(payload),
        delivery,
      );
      expect(second.status).toBe(202);
      expect(JSON.parse(second.body)).toMatchObject({ status: "accepted" });
    });
  });

  it("successful enqueue records replay state and prevents retry", async () => {
    const payload = signedPayload("opened");
    const delivery = "delivery-success-replay";
    const { queue, orchestrator } = createOrchestrator();
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: guard,
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const first = await postWebhook(
        port,
        payload,
        signatureFor(payload),
        delivery,
      );
      expect(first.status).toBe(202);
      expect(queue.size()).toBe(1);
      expect(guard.isReplay(delivery)).toBe(true);

      const second = await postWebhook(
        port,
        payload,
        signatureFor(payload),
        delivery,
      );
      expect(second.status).toBe(409);
      expect(queue.size()).toBe(1);
    });
  });

  it("invalid signature does not consume replay state", async () => {
    const payload = signedPayload("opened");
    const delivery = "delivery-invalid-sig-no-replay";
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const { queue, orchestrator } = createOrchestrator();
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: guard,
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const badSig = `sha256=${"0".repeat(64)}`;
      const first = await postWebhook(port, payload, badSig, delivery);
      expect(first.status).toBe(401);
      expect(guard.isReplay(delivery)).toBe(false);
      expect(guard.size()).toBe(0);

      const second = await postWebhook(
        port,
        payload,
        signatureFor(payload),
        delivery,
      );
      expect(second.status).toBe(202);
      expect(queue.size()).toBe(1);
    });
  });
});

describe("production omission regression (Codex P3)", () => {
  it("production composition without orchestrator must fail immediately", () => {
    expect(() =>
      createConfiguredGitHubWebhookHandler({
        secret: SECRET,
      } as unknown as never),
    ).toThrow(GitHubWebhookConfigurationError);
  });

  it("production composition with orchestrator enqueues an authenticated PR", async () => {
    const payload = signedPayload("synchronize");
    const { queue, orchestrator } = createOrchestrator();
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(port, payload, signatureFor(payload));
      expect(response.status).toBe(202);
      expect(queue.size()).toBe(1);
    });
  });
});

describe("low-level handler compatibility", () => {
  it("remains usable without an orchestrator for intentional transport-only use", async () => {
    const payload = signedPayload("opened");
    const handler = createGitHubWebhookHttpHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(port, payload, signatureFor(payload));
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({ status: "accepted" });
    });
  });
});
