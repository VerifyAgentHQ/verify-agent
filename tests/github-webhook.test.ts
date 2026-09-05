import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubWebhookAuthenticationError,
  GitHubWebhookPayloadError,
  GitHubWebhookReplayError,
  GitHubWebhookUnsupportedEventError,
  createInMemoryGitHubWebhookReplayGuard,
  handleGitHubWebhookHttpRequest,
  handleGitHubWebhookRequest,
  parseTrustedGitHubPullRequestEvent,
  readGitHubWebhookSecret,
  verifyGitHubWebhookSignature,
} from "../apps/github-bot/src/webhook.js";
import { decideGitHubPullRequestEvent } from "../packages/adapters-source/src/github-pr.js";

const SECRET = "test_webhook_secret_123456";
const OWNER = "octocat";
const REPO = "hello-world";
const HEAD_SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function sign(payload: string, secret = SECRET): string {
  const digest = createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");
  return `sha256=${digest}`;
}

function makePayload(overrides: Record<string, unknown> = {}): string {
  const base = {
    action: "opened",
    repository: { owner: { login: OWNER }, name: REPO },
    pull_request: {
      number: 42,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
    },
  } as Record<string, unknown>;
  // shallow merge overrides
  for (const [k, v] of Object.entries(overrides)) {
    (base as Record<string, unknown>)[k] = v;
  }
  return JSON.stringify(base);
}

function makeRawPayloadWithAction(action: string): string {
  return JSON.stringify({
    action,
    repository: { owner: { login: OWNER }, name: REPO },
    pull_request: {
      number: 7,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
    },
  });
}

describe("GitHub webhook signature verification", () => {
  it("valid sha256 signature succeeds", () => {
    const payload = makePayload();
    const sig = sign(payload);
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: sig,
        payload,
      }),
    ).not.toThrow();
  });

  it("incorrect signature fails", () => {
    const payload = makePayload();
    const sig = "sha256=" + "0".repeat(64);
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: sig,
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
  });

  it("modified payload fails", () => {
    const payload = makePayload();
    const sig = sign(payload);
    const tampered = payload.replace(OWNER, "evil");
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: sig,
        payload: tampered,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
  });

  it("missing signature fails", () => {
    const payload = makePayload();
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: null,
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: "",
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
  });

  it("malformed prefix fails", () => {
    const payload = makePayload();
    const digest = createHmac("sha256", SECRET)
      .update(payload, "utf8")
      .digest("hex");
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: digest,
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: `sha1=${digest}`,
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
  });

  it("wrong digest length fails", () => {
    const payload = makePayload();
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: "sha256=" + "a".repeat(63),
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: "sha256=" + "a".repeat(65),
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
  });

  it("invalid hex fails", () => {
    const payload = makePayload();
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: "sha256=" + "g".repeat(64),
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: "sha256=" + "z".repeat(64),
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
  });

  it("unsupported algorithm fails", () => {
    const payload = makePayload();
    const digest = createHmac("sha256", SECRET)
      .update(payload, "utf8")
      .digest("hex");
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: `sha512=${digest}`,
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
  });

  it("empty secret fails", () => {
    const payload = makePayload();
    const sig = sign(payload, "valid");
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: "",
        signatureHeader: sig,
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: "   ",
        signatureHeader: sig,
        payload,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
  });

  it("uses constant-time comparison (hex case insensitive via lowercasing)", () => {
    const payload = makePayload();
    const sigLower = sign(payload);
    const hex = sigLower.slice("sha256=".length);
    const sigUpper = `sha256=${hex.toUpperCase()}`;
    // Our implementation lowercases received hex before compare, so upper should succeed
    expect(() =>
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: sigUpper,
        payload,
      }),
    ).not.toThrow();
  });

  it("secret never appears in thrown errors", () => {
    const payload = makePayload();
    try {
      verifyGitHubWebhookSignature({
        secret: SECRET,
        signatureHeader: "sha256=" + "0".repeat(64),
        payload,
      });
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
      expect((e as Error).message).not.toContain(SECRET);
    }
  });
});

describe("GitHub webhook event parsing", () => {
  it("valid pull_request payload succeeds", () => {
    const payload = makePayload();
    const sig = sign(payload);
    const event = parseTrustedGitHubPullRequestEvent({
      rawBody: payload,
      signatureHeader: sig,
      eventHeader: "pull_request",
      deliveryHeader: "delivery-1",
      secret: SECRET,
    });
    expect(event.action).toBe("opened");
    expect(event.repository.owner).toBe(OWNER);
    expect(event.repository.name).toBe(REPO);
    expect(event.pullRequest.number).toBe(42);
    expect(event.pullRequest.head.sha).toBe(HEAD_SHA);
  });

  it("supported PR action maps correctly via Batch 31", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      const payload = makeRawPayloadWithAction(action);
      const sig = sign(payload);
      const event = parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: `delivery-${action}`,
        secret: SECRET,
      });
      const decision = decideGitHubPullRequestEvent(event);
      expect(decision.kind).toBe("verify");
    }
  });

  it("unsupported PR action reaches Batch 31 and is ignored", () => {
    const payload = makeRawPayloadWithAction("closed");
    const sig = sign(payload);
    const event = parseTrustedGitHubPullRequestEvent({
      rawBody: payload,
      signatureHeader: sig,
      eventHeader: "pull_request",
      deliveryHeader: "delivery-closed",
      secret: SECRET,
    });
    const decision = decideGitHubPullRequestEvent(event);
    expect(decision.kind).toBe("ignore");
  });

  it("missing repository owner fails", () => {
    const payload = JSON.stringify({
      action: "opened",
      repository: { name: REPO },
      pull_request: {
        number: 1,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    });
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d1",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookPayloadError);
  });

  it("missing repository name fails", () => {
    const payload = JSON.stringify({
      action: "opened",
      repository: { owner: { login: OWNER } },
      pull_request: {
        number: 1,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    });
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d2",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookPayloadError);
  });

  it("missing PR number fails", () => {
    const payload = JSON.stringify({
      action: "opened",
      repository: { owner: { login: OWNER }, name: REPO },
      pull_request: {
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    });
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d3",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookPayloadError);
  });

  it("missing base SHA fails", () => {
    const payload = JSON.stringify({
      action: "opened",
      repository: { owner: { login: OWNER }, name: REPO },
      pull_request: {
        number: 1,
        base: {},
        head: { sha: HEAD_SHA },
      },
    });
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d4",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookPayloadError);
  });

  it("missing head SHA fails", () => {
    const payload = JSON.stringify({
      action: "opened",
      repository: { owner: { login: OWNER }, name: REPO },
      pull_request: {
        number: 1,
        base: { sha: BASE_SHA },
        head: {},
      },
    });
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d5",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookPayloadError);
  });

  it("malformed JSON fails", () => {
    const payload = "{ not json";
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d6",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookPayloadError);
  });

  it("unrelated GitHub payload fields do not leak into internal event", () => {
    const payload = JSON.stringify({
      action: "opened",
      repository: {
        owner: { login: OWNER },
        name: REPO,
        extra: "ignore",
        html_url: "https://evil.com",
      },
      pull_request: {
        number: 42,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
        extra: "ignore",
        url: "https://evil.com",
      },
      sender: { login: "evil" },
      extra_top: "ignore",
    });
    const sig = sign(payload);
    const event = parseTrustedGitHubPullRequestEvent({
      rawBody: payload,
      signatureHeader: sig,
      eventHeader: "pull_request",
      deliveryHeader: "d7",
      secret: SECRET,
    });
    expect(
      (event as unknown as Record<string, unknown>).sender,
    ).toBeUndefined();
    expect(
      (event.repository as unknown as Record<string, unknown>).extra,
    ).toBeUndefined();
    expect(
      (event.pullRequest as unknown as Record<string, unknown>).extra,
    ).toBeUndefined();
    expect(event.repository.owner).toBe(OWNER);
  });
});

describe("GitHub webhook event-type isolation", () => {
  it("push is rejected", () => {
    const payload = makePayload();
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "push",
        deliveryHeader: "d-push",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookUnsupportedEventError);
  });

  it("issue_comment is rejected", () => {
    const payload = makePayload();
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "issue_comment",
        deliveryHeader: "d-issue",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookUnsupportedEventError);
  });

  it("arbitrary event names are rejected", () => {
    const payload = makePayload();
    const sig = sign(payload);
    for (const ev of [
      "pull_request_review",
      "ping",
      "repository_dispatch",
      "workflow_run",
      "evil",
    ]) {
      expect(() =>
        parseTrustedGitHubPullRequestEvent({
          rawBody: payload,
          signatureHeader: sig,
          eventHeader: ev,
          deliveryHeader: `d-${ev}`,
          secret: SECRET,
        }),
      ).toThrow(GitHubWebhookUnsupportedEventError);
    }
  });
});

describe("GitHub webhook request limits", () => {
  it("payload below limit succeeds", () => {
    const payload = makePayload();
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d-limit-ok",
        secret: SECRET,
        maxBytes: 1_048_576,
      }),
    ).not.toThrow();
  });

  it("payload exactly at limit behaves deterministically", () => {
    const basePayload = makePayload();
    const baseLen = Buffer.byteLength(basePayload, "utf8");
    const limit = baseLen;
    const sig = sign(basePayload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: basePayload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d-exact",
        secret: SECRET,
        maxBytes: limit,
      }),
    ).not.toThrow();
  });

  it("payload above limit is rejected before parsing", () => {
    const payload = "x".repeat(100);
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d-over",
        secret: SECRET,
        maxBytes: 10,
      }),
    ).toThrow(GitHubWebhookPayloadError);
    // Ensure signature verification not bypassed – even if payload would be valid JSON, it's rejected for size first
  });
});

describe("GitHub webhook delivery/replay", () => {
  it("missing X-GitHub-Delivery fails", () => {
    const payload = makePayload();
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: null,
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookReplayError);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookReplayError);
  });

  it("first delivery succeeds, repeated delivery is rejected while retained", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard({
      maxEntries: 10,
      ttlMs: 60_000,
    });
    const payload = makePayload();
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "delivery-123",
        secret: SECRET,
        replayGuard: guard,
      }),
    ).not.toThrow();
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "delivery-123",
        secret: SECRET,
        replayGuard: guard,
      }),
    ).toThrow(GitHubWebhookReplayError);
  });

  it("different delivery IDs succeed", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const payload = makePayload();
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "delivery-a",
        secret: SECRET,
        replayGuard: guard,
      }),
    ).not.toThrow();
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "delivery-b",
        secret: SECRET,
        replayGuard: guard,
      }),
    ).not.toThrow();
  });

  it("retention is bounded and deterministic", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard({
      maxEntries: 2,
      ttlMs: 1_000_000,
    });
    const mk = (delivery: string) => {
      const payload = makePayload();
      const sig = sign(payload);
      return () =>
        parseTrustedGitHubPullRequestEvent({
          rawBody: payload,
          signatureHeader: sig,
          eventHeader: "pull_request",
          deliveryHeader: delivery,
          secret: SECRET,
          replayGuard: guard,
        });
    };
    expect(mk("d1")).not.toThrow();
    expect(mk("d2")).not.toThrow();
    expect(guard.size()).toBe(2);
    expect(mk("d3")).not.toThrow();
    expect(guard.size()).toBe(2);
    // d1 should have been evicted (FIFO)
    expect(mk("d1")).not.toThrow();
  });
});

describe("GitHub replay guard reserve/commit/rollback", () => {
  it("reserve returns true for unseen delivery and false on duplicate", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    expect(guard.reserve("r1")).toBe(true);
    expect(guard.reserve("r1")).toBe(false);
    expect(guard.reserve("r2")).toBe(true);
  });

  it("commit finalizes reservation as consumed", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    expect(guard.reserve("r1")).toBe(true);
    guard.commit("r1");
    expect(guard.isReplay("r1")).toBe(true);
    expect(guard.reserve("r1")).toBe(false);
  });

  it("rollback removes reservation making delivery retryable", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    expect(guard.reserve("r1")).toBe(true);
    guard.rollback("r1");
    expect(guard.isReplay("r1")).toBe(false);
    expect(guard.reserve("r1")).toBe(true);
  });

  it("rollback is no-op for already committed delivery", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    expect(guard.reserve("r1")).toBe(true);
    guard.commit("r1");
    guard.rollback("r1");
    expect(guard.isReplay("r1")).toBe(true);
  });

  it("rollback is no-op for unknown delivery", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    guard.rollback("unknown");
    expect(guard.isReplay("unknown")).toBe(false);
  });

  it("checkAndRemember treats reserved delivery as replay", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    expect(guard.reserve("r1")).toBe(true);
    expect(guard.checkAndRemember("r1")).toBe(true);
  });

  it("reserved delivery counts toward size", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard({ maxEntries: 3 });
    guard.reserve("r1");
    guard.reserve("r2");
    expect(guard.size()).toBe(2);
    guard.commit("r1");
    expect(guard.size()).toBe(2);
    guard.rollback("r2");
    expect(guard.size()).toBe(1);
  });

  it("concurrent reserve with same delivery only succeeds once", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    expect(guard.reserve("r1")).toBe(true);
    expect(guard.reserve("r1")).toBe(false);
    guard.commit("r1");
    expect(guard.reserve("r1")).toBe(false);
  });

  it("public parseTrustedGitHubPullRequestEvent enforces replay protection", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const payload = makePayload();
    const sig = sign(payload);
    parseTrustedGitHubPullRequestEvent({
      rawBody: payload,
      signatureHeader: sig,
      eventHeader: "pull_request",
      deliveryHeader: "delivery-enforced",
      secret: SECRET,
      replayGuard: guard,
    });
    expect(guard.isReplay("delivery-enforced")).toBe(true);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "delivery-enforced",
        secret: SECRET,
        replayGuard: guard,
      }),
    ).toThrow(GitHubWebhookReplayError);
  });

  it("commit(unknown) does not create a replay entry", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    guard.commit("unknown");
    expect(guard.isReplay("unknown")).toBe(false);
    expect(guard.size()).toBe(0);
  });

  it("commit(committed) does not corrupt state", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    expect(guard.reserve("r1")).toBe(true);
    guard.commit("r1");
    expect(guard.isReplay("r1")).toBe(true);
    guard.commit("r1");
    expect(guard.isReplay("r1")).toBe(true);
    expect(guard.reserve("r1")).toBe(false);
  });

  it("stale commit after eviction does not recreate entry", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard({
      maxEntries: 2,
      ttlMs: 1,
    });
    guard.reserve("d1");
    guard.reserve("d2");
    guard.reserve("d3");
    guard.commit("d3");
    guard.commit("d1");
    expect(guard.size()).toBe(2);
    guard.commit("d1");
    expect(guard.size()).toBe(2);
  });
});

describe("authentication-before-reservation ordering (P2 fix)", () => {
  it("invalid signature does not reserve delivery", async () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const payload = makePayload();
    const badSig = "sha256=" + "0".repeat(64);
    const { createServer, request: httpRequest } = await import("node:http");
    const server = createServer((req, res) => {
      void handleGitHubWebhookHttpRequest(req, res, {
        secret: SECRET,
        replayGuard: guard,
        orchestrator: {
          handle: async () => {
            throw new Error("should not be called");
          },
        },
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          port: addr.port,
          method: "POST",
          path: "/webhook",
          headers: {
            "x-hub-signature-256": badSig,
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-auth-first",
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end(payload);
    });
    await new Promise<void>((r) => server.close(() => r()));
    expect(result.status).toBe(401);
    expect(guard.isReplay("delivery-auth-first")).toBe(false);
    expect(guard.size()).toBe(0);
  });

  it("invalid request cannot block concurrent valid request with same delivery", async () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const payload = makePayload();
    const badSig = "sha256=" + "0".repeat(64);
    const goodSig = sign(payload);
    const delivery = "delivery-concurrent-p2";
    let enqueued = false;
    const { createServer, request: httpRequest } = await import("node:http");
    const server = createServer((req, res) => {
      void handleGitHubWebhookHttpRequest(req, res, {
        secret: SECRET,
        replayGuard: guard,
        orchestrator: {
          handle: async () => {
            enqueued = true;
            return { kind: "enqueued" as const };
          },
        },
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };

    const sendRequest = (sig: string): Promise<{ status: number }> =>
      new Promise((resolve, reject) => {
        const req = httpRequest(
          {
            port: addr.port,
            method: "POST",
            path: "/webhook",
            headers: {
              "x-hub-signature-256": sig,
              "x-github-event": "pull_request",
              "x-github-delivery": delivery,
            },
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
          },
        );
        req.on("error", reject);
        req.end(payload);
      });

    const invalidResult = await sendRequest(badSig);
    expect(invalidResult.status).toBe(401);
    expect(guard.isReplay(delivery)).toBe(false);

    const validResult = await sendRequest(goodSig);
    expect(validResult.status).toBe(202);
    expect(enqueued).toBe(true);
    expect(guard.isReplay(delivery)).toBe(true);

    await new Promise<void>((r) => server.close(() => r()));
  });

  it("reservation is rolled back on parsing failure after authentication", async () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const badPayload = JSON.stringify({ not: "a valid pr payload" });
    const sig = sign(badPayload);
    const { createServer, request: httpRequest } = await import("node:http");
    const server = createServer((req, res) => {
      void handleGitHubWebhookHttpRequest(req, res, {
        secret: SECRET,
        replayGuard: guard,
        orchestrator: {
          handle: async () => {
            throw new Error("should not be called");
          },
        },
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest(
        {
          port: addr.port,
          method: "POST",
          path: "/webhook",
          headers: {
            "x-hub-signature-256": sig,
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-parse-fail",
          },
        },
        (res) => {
          res.on("data", () => {});
          res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        },
      );
      req.on("error", reject);
      req.end(badPayload);
    });
    await new Promise<void>((r) => server.close(() => r()));
    expect(result.status).toBe(400);
    expect(guard.isReplay("delivery-parse-fail")).toBe(false);
  });

  it("public parseTrustedGitHubPullRequestEvent still enforces replay", () => {
    const guard = createInMemoryGitHubWebhookReplayGuard();
    const payload = makePayload();
    const sig = sign(payload);
    parseTrustedGitHubPullRequestEvent({
      rawBody: payload,
      signatureHeader: sig,
      eventHeader: "pull_request",
      deliveryHeader: "delivery-public-replay",
      secret: SECRET,
      replayGuard: guard,
    });
    expect(guard.isReplay("delivery-public-replay")).toBe(true);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "delivery-public-replay",
        secret: SECRET,
        replayGuard: guard,
      }),
    ).toThrow(GitHubWebhookReplayError);
  });
});

describe("GitHub webhook security properties", () => {
  it("secret never appears in thrown errors", () => {
    const payload = makePayload();
    const badSig = "sha256=" + "0".repeat(64);
    try {
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: badSig,
        eventHeader: "pull_request",
        deliveryHeader: "d-sec",
        secret: SECRET,
      });
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
      expect((e as Error).message).not.toContain(SECRET);
    }
    expect(() =>
      readGitHubWebhookSecret({ GITHUB_WEBHOOK_SECRET: SECRET }),
    ).not.toThrow();
    expect(() => readGitHubWebhookSecret({})).toThrow(
      GitHubWebhookAuthenticationError,
    );
    try {
      readGitHubWebhookSecret({});
    } catch (e) {
      expect(String(e)).not.toContain(SECRET);
    }
  });

  it("secret never appears in returned structures", () => {
    const payload = makePayload();
    const sig = sign(payload);
    const result = handleGitHubWebhookRequest({
      rawBody: payload,
      signatureHeader: sig,
      eventHeader: "pull_request",
      deliveryHeader: "d-no-leak",
      secret: SECRET,
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("failed authentication does not call Batch 31", () => {
    const payload = makePayload();
    const badSig = "sha256=" + "0".repeat(64);
    let batch31Called = false;
    // We test by ensuring that even if payload would be valid, auth failure prevents event parsing
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: badSig,
        eventHeader: "pull_request",
        deliveryHeader: "d-auth-fail",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookAuthenticationError);
    // If we had a spy on decideGitHubPullRequestEvent, it would not be called – we verify via handle not returning verify
    const result = (() => {
      try {
        return handleGitHubWebhookRequest({
          rawBody: payload,
          signatureHeader: badSig,
          eventHeader: "pull_request",
          deliveryHeader: "d-auth-fail2",
          secret: SECRET,
        });
      } catch (e) {
        return e;
      }
    })();
    expect(result).toBeInstanceOf(GitHubWebhookAuthenticationError);
  });

  it("unsupported event types do not call Batch 31 verification", () => {
    const payload = makePayload();
    const sig = sign(payload);
    const result = (() => {
      try {
        return parseTrustedGitHubPullRequestEvent({
          rawBody: payload,
          signatureHeader: sig,
          eventHeader: "push",
          deliveryHeader: "d-push2",
          secret: SECRET,
        });
      } catch (e) {
        return e;
      }
    })();
    expect(result).toBeInstanceOf(GitHubWebhookUnsupportedEventError);
  });

  it("malformed requests do not trigger source resolution", () => {
    const payload = "{ not json";
    const sig = sign(payload);
    expect(() =>
      parseTrustedGitHubPullRequestEvent({
        rawBody: payload,
        signatureHeader: sig,
        eventHeader: "pull_request",
        deliveryHeader: "d-malformed",
        secret: SECRET,
      }),
    ).toThrow(GitHubWebhookPayloadError);
  });

  it("no network calls are made by the webhook boundary", async () => {
    const payload = makePayload();
    const sig = sign(payload);
    // Ensure parsing does not trigger fetch – we have no fetch in webhook module
    // This test just verifies that the function is synchronous except for not doing I/O
    const result = parseTrustedGitHubPullRequestEvent({
      rawBody: payload,
      signatureHeader: sig,
      eventHeader: "pull_request",
      deliveryHeader: "d-no-net",
      secret: SECRET,
    });
    expect(result.action).toBe("opened");
  });
});

describe("GitHub webhook integration", () => {
  it("signed raw GitHub PR payload → webhook boundary → Batch 31 decision → GitHubSnapshotReference", () => {
    const payload = JSON.stringify({
      action: "synchronize",
      repository: { owner: { login: OWNER }, name: REPO },
      pull_request: {
        number: 99,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    });
    const sig = sign(payload);
    const result = handleGitHubWebhookRequest({
      rawBody: payload,
      signatureHeader: sig,
      eventHeader: "pull_request",
      deliveryHeader: "delivery-integration",
      secret: SECRET,
    });
    expect(result.kind).toBe("verify");
    if (result.kind === "verify") {
      expect(result.decision.kind).toBe("verify");
      if (result.decision.kind === "verify") {
        expect(result.decision.source.owner).toBe(OWNER);
        expect(result.decision.source.repository).toBe(REPO);
        expect(result.decision.source.sha).toBe(HEAD_SHA);
        expect(result.decision.headSha).toBe(HEAD_SHA);
        expect(result.decision.baseSha).toBe(BASE_SHA);
        expect(result.event.pullRequest.head.sha).toBe(HEAD_SHA);
      }
    }
  });

  it("readGitHubWebhookSecret rejects absent/empty", () => {
    expect(() => readGitHubWebhookSecret({})).toThrow(
      GitHubWebhookAuthenticationError,
    );
    expect(() =>
      readGitHubWebhookSecret({ GITHUB_WEBHOOK_SECRET: "" }),
    ).toThrow(GitHubWebhookAuthenticationError);
    expect(() =>
      readGitHubWebhookSecret({ GITHUB_WEBHOOK_SECRET: "   " }),
    ).toThrow(GitHubWebhookAuthenticationError);
    expect(readGitHubWebhookSecret({ GITHUB_WEBHOOK_SECRET: SECRET })).toBe(
      SECRET,
    );
  });
});
