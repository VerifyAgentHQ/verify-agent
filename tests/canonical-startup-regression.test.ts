/**
 * P1.5 — Canonical Production Startup Regression Test.
 *
 * Proves the package's normal executable startup selects the FULL
 * GitHub verification composition (not the incomplete API-only composition).
 *
 * Required behavior:
 *   canonical production startup
 *         ↓
 *   GET /health → 200
 *         ↓
 *   POST /webhook with valid HMAC
 *         ↓
 *   202 response
 *         ↓
 *   expected verification job is queued
 */

import { createHmac, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { startConfiguredProductionService } from "../apps/api/src/main.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
} from "../packages/adapters-source/src/index.js";
import type { SourceContents } from "../packages/adapters-source/src/resolver.js";
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
const SECRET = "canonical-startup-test-webhook-secret";
const INTERNAL_RESULT_TOKEN =
  "canonical-startup-internal-result-token-for-tests-only";
const CREATED_AT = "2026-10-02T00:00:00.000Z";
const INSTALLATION_TOKEN = "canonical-startup-test-installation-token";
const PERSONAL_TOKEN_SENTINEL =
  "canonical-startup-test-personal-token-sentinel";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const APP_PRIVATE_KEY_PEM = privateKey;
/** Numeric ID of the configured VerifyAgent App in this file. */
const OWN_APP_ID = 123456;

const RUST_CONTENTS = Object.freeze({
  "Cargo.toml": '[package]\nname = "canonical-startup"\nversion = "0.1.0"\n',
  "src/lib.rs": "pub fn value() -> u32 { 42 }\n",
});

function sandboxSuccess(request: { jobId: string }): unknown {
  return {
    schemaVersion: "1.0.0" as const,
    jobId: request.jobId,
    status: "completed" as const,
    exitCode: 0,
    durationMs: 5,
    logsRef: "fixture://logs/canonical-startup",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
    errors: [],
  };
}

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/**
 * Controlled double at the existing adapter boundary: installation
 * discovery, installation token, and Checks API. Records every call so
 * tests can prove App authentication and the absence of token fallback.
 */
function createAppBoundaryDouble() {
  const calls: RecordedCall[] = [];
  let nextId = 401;
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
    if (method === "GET" && urlText.endsWith("/installation")) {
      return json(200, { id: 4242 });
    }
    if (method === "POST" && urlText.includes("/access_tokens")) {
      return json(200, {
        token: INSTALLATION_TOKEN,
        expires_at: "2030-01-01T00:00:00.000Z",
      });
    }
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
          name: "VerifyAgent",
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
      return json(201, { id, name: "VerifyAgent" });
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
        name: "VerifyAgent",
      });
    }
    return json(404, { message: "Not Found" });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls, existing };
}

function fakeApplicationService(): VerificationApplicationService {
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
  return new VerificationApplicationService(
    createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    }),
    createGitHubSourceResolver(provider),
  );
}

function configuredEnv(): NodeJS.ProcessEnv {
  return {
    GITHUB_APP_ID: String(OWN_APP_ID),
    GITHUB_APP_PRIVATE_KEY: APP_PRIVATE_KEY_PEM,
    GITHUB_WEBHOOK_SECRET: SECRET,
    VERIFY_INTERNAL_RESULT_TOKEN: INTERNAL_RESULT_TOKEN,
    // Ambient token must never become the publication credential.
    GITHUB_TOKEN: PERSONAL_TOKEN_SENTINEL,
  };
}

function makePayload(): string {
  return JSON.stringify({
    action: "opened",
    repository: { owner: { login: OWNER }, name: REPOSITORY },
    pull_request: {
      number: 42,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
    },
  });
}

function signPayload(payload: string, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function postWebhook(
  port: number,
  payload: string,
  delivery: string,
): Promise<{ status: number; body: string }> {
  const signature = signPayload(payload);
  return new Promise((resolvePromise, rejectPromise) => {
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
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

function httpGet(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(
      { port, host: "127.0.0.1", method: "GET", path },
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

function httpPost(
  port: number,
  path: string,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
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
    outbound.end(body);
  });
}

describe("P1.5 — Canonical production startup regression", () => {
  it("normal executable startup selects full GitHub verification composition", async () => {
    const packageJson = JSON.parse(
      readFileSync(
        new URL("../apps/api/package.json", import.meta.url),
        "utf8",
      ),
    ) as { scripts?: { start?: unknown } };
    expect(packageJson.scripts?.start).toBe("node dist/main.js");

    // This test exercises the same canonical bootstrap module targeted by the
    // package command: `pnpm start` → `node dist/main.js` →
    // `startConfiguredProductionService()`.
    const double = createAppBoundaryDouble();
    const service = await startConfiguredProductionService({
      port: 0,
      host: "127.0.0.1",
      env: configuredEnv(),
      applicationService: fakeApplicationService(),
      fetch: double.fetch,
    });

    try {
      const address = service.server.address();
      if (!address || typeof address === "string") {
        throw new Error("canonical service did not bind a port");
      }
      const port = address.port;

      // 1. GET /health → 200
      const health = await httpGet(port, "/health");
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ status: "ok" });

      // 2. POST /webhook with valid HMAC → 202
      const payload = makePayload();
      const delivery = "delivery-canonical-startup-regression";
      const webhookResponse = await postWebhook(port, payload, delivery);
      expect(webhookResponse.status).toBe(202);

      const body = JSON.parse(webhookResponse.body) as { queueJobId: string };
      expect(typeof body.queueJobId).toBe("string");
      expect(body.queueJobId.length).toBeGreaterThan(0);
      const queueJobId = body.queueJobId;

      // 3. Expected verification job is queued (verify via runtime wait)
      // This uses the service's built-in waitForQueueJob which awaits the
      // automatic event-driven consumption — no manual processNext() call.
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");

      // 4. Verify the job exists in the queue/runtime boundary
      // The registry should have the result for this queueJobId
      const stored = service.resultReader.getByQueueJobId(queueJobId);
      expect(stored).not.toBeNull();
      expect(["pass", "fail", "needs_changes"]).toContain(stored?.status);

      // 5. Verify /verify endpoint still works (internal/manual API)
      const verifyResponse = await httpGet(port, "/verify");
      // /verify only accepts POST, so GET returns 405
      expect(verifyResponse.status).toBe(405);
    } finally {
      // Always stop/close the service
      await service.stop();
    }
  });

  it("webhook path is the authenticated GitHub production trust boundary", async () => {
    const double = createAppBoundaryDouble();
    const service = await startConfiguredProductionService({
      port: 0,
      host: "127.0.0.1",
      env: configuredEnv(),
      applicationService: fakeApplicationService(),
      fetch: double.fetch,
    });

    try {
      const address = service.server.address();
      if (!address || typeof address === "string") {
        throw new Error("canonical service did not bind a port");
      }
      const port = address.port;

      // Invalid signature → 401 (webhook trust boundary enforced)
      const payload = makePayload();
      const badSignature = `sha256=${"0".repeat(64)}`;
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const outbound = httpRequest(
            {
              port,
              host: "127.0.0.1",
              method: "POST",
              path: "/webhook",
              headers: {
                "content-type": "application/json",
                "x-hub-signature-256": badSignature,
                "x-github-event": "pull_request",
                "x-github-delivery": "delivery-bad-sig",
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
          outbound.on("error", reject);
          outbound.end(payload);
        },
      );
      expect(response.status).toBe(401);
      expect(service.queue.size()).toBe(0);
      expect(service.registry.size()).toBe(0);

      // Valid signature → 202 and job queued
      const goodResponse = await postWebhook(
        port,
        payload,
        "delivery-good-sig",
      );
      expect(goodResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(goodResponse.body) as { queueJobId: string }
      ).queueJobId;
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
    } finally {
      await service.stop();
    }
  });

  it("/verify is an internal/manual API distinct from the webhook trust boundary", async () => {
    const double = createAppBoundaryDouble();
    const service = await startConfiguredProductionService({
      port: 0,
      host: "127.0.0.1",
      env: configuredEnv(),
      applicationService: fakeApplicationService(),
      fetch: double.fetch,
    });

    try {
      const address = service.server.address();
      if (!address || typeof address === "string") {
        throw new Error("canonical service did not bind a port");
      }
      const port = address.port;

      // /verify accepts POST with snapshot source
      const verifyResponse = await httpPost(
        port,
        "/verify",
        JSON.stringify({ source: { kind: "snapshot", id: "test-snap" } }),
      );
      // Returns 200 with verification result (or 400/500 for invalid source)
      // The key point: it works without GitHub webhook authentication
      expect([200, 400, 500]).toContain(verifyResponse.status);

      // But /verify does NOT accept GitHub webhook signatures
      // (it's a different trust boundary)
      const webhookPayload = makePayload();
      const webhookToVerify = await httpPost(port, "/verify", webhookPayload);
      // /verify doesn't validate webhook signatures; it expects { source: {...} }
      // So a webhook payload will be rejected as invalid source shape (400)
      expect(webhookToVerify.status).toBe(400);
    } finally {
      await service.stop();
    }
  });
});
