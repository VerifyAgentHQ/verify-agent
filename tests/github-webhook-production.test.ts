import { createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createGitHubVerificationOrchestrator } from "../apps/github-bot/src/verification-orchestrator.js";
import {
  GitHubWebhookConfigurationError,
  createConfiguredGitHubWebhookHandler,
  createGitHubWebhookHttpHandler,
  createInMemoryGitHubWebhookReplayGuard,
} from "../apps/github-bot/src/webhook.js";
import type { VerificationResult } from "../packages/domain/src/verification.js";

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const SECRET = "batch37a-production-test-secret";
const OWNER = "octocat";
const REPOSITORY = "hello-world";

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

function result(): VerificationResult {
  return {} as VerificationResult;
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
    const verifySource = vi.fn(async () => result());
    const orchestrator = createGitHubVerificationOrchestrator({ verifySource });
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

  it("routes an authenticated supported PR to verifySource exactly once", async () => {
    const payload = signedPayload("opened");
    const verifySource = vi.fn(async ({ source }: { source: unknown }) => {
      expect(source).toEqual({
        kind: "snapshot",
        id: `${OWNER}:${REPOSITORY}:${SHA}`,
      });
      return result();
    });
    const orchestrator = createGitHubVerificationOrchestrator({ verifySource });
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
      orchestrator,
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(port, payload, signatureFor(payload));
      expect(response.status).toBe(202);
      expect(verifySource).toHaveBeenCalledTimes(1);
    });
  });

  it("does not invoke verifySource for invalid signatures", async () => {
    const verifySource = vi.fn(async () => result());
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      orchestrator: createGitHubVerificationOrchestrator({ verifySource }),
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(
        port,
        signedPayload("opened"),
        `sha256=${"0".repeat(64)}`,
      );
      expect(response.status).toBe(401);
      expect(verifySource).not.toHaveBeenCalled();
    });
  });

  it("does not invoke verifySource for unsupported actions", async () => {
    const payload = signedPayload("closed");
    const verifySource = vi.fn(async () => result());
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
      orchestrator: createGitHubVerificationOrchestrator({ verifySource }),
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(port, payload, signatureFor(payload));
      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toMatchObject({ status: "ignored" });
      expect(verifySource).not.toHaveBeenCalled();
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

  it("production composition with orchestrator verifies an authenticated PR", async () => {
    const payload = signedPayload("synchronize");
    const verifySource = vi.fn(async () => result());
    const handler = createConfiguredGitHubWebhookHandler({
      secret: SECRET,
      replayGuard: createInMemoryGitHubWebhookReplayGuard(),
      orchestrator: createGitHubVerificationOrchestrator({ verifySource }),
    });

    await withServer(handler, async (port) => {
      const response = await postWebhook(port, payload, signatureFor(payload));
      expect(response.status).toBe(202);
      expect(verifySource).toHaveBeenCalledTimes(1);
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
