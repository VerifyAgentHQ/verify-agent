/**
 * Batch 55B — configured startup owns Check publication (Blocking 1).
 *
 * Proves `startConfiguredGitHubVerificationService(...)` constructs the
 * GitHub App-authenticated Check publisher from configuration and wires
 * it as the service's single lifecycle-owned subscription:
 *
 * - Configured service → settlement → Check publisher invoked, with NO
 *   test-side `service.onSettled(...)` registration and NO manually
 *   injected `checkPublisher`.
 * - The publisher uses App installation authentication at the existing
 *   adapter boundary (controlled fetch double); the ambient `GITHUB_TOKEN`
 *   sentinel is never consulted.
 * - Missing/incomplete App configuration fails closed with a diagnosable
 *   generic error, zero network calls, and no secret leakage.
 *
 * The sandbox-backed application service is substituted with the standard
 * fake-transport composition used across unit tests; publisher
 * construction (env → App config → resolver/token client/publisher) and
 * service wiring are fully configured. No live GitHub, no real sandbox.
 */

import { createHmac, generateKeyPairSync } from "node:crypto";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { startConfiguredGitHubVerificationService } from "../apps/api/src/github-verification-service.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
  VERIFY_AGENT_CHECK_NAME,
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
const SECRET = "batch55b-test-webhook-secret";
const INTERNAL_RESULT_TOKEN = "batch55b-internal-result-token-for-tests-only";
const CREATED_AT = "2026-09-28T00:00:00.000Z";
const INSTALLATION_TOKEN = "batch55b-test-installation-token";
const PERSONAL_TOKEN_SENTINEL = "batch55b-test-personal-token-sentinel";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const APP_PRIVATE_KEY_PEM = privateKey;

const RUST_CONTENTS = Object.freeze({
  "Cargo.toml": '[package]\nname = "batch55b"\nversion = "0.1.0"\n',
  "src/lib.rs": "pub fn value() -> u32 { 42 }\n",
});

function sandboxSuccess(request: { jobId: string }): unknown {
  return {
    schemaVersion: "1.0.0" as const,
    jobId: request.jobId,
    status: "completed" as const,
    exitCode: 0,
    durationMs: 5,
    logsRef: "fixture://logs/batch55b",
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
/** Batch 55D — numeric ID of the configured VerifyAgent App in this file. */
const OWN_APP_ID = 123456;

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

function postWebhook(
  port: number,
  payload: string,
  delivery: string,
): Promise<{ status: number; body: string }> {
  const signature = `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
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

describe("Batch 55B — configured startup owns Check publication", () => {
  it("configured service settles webhook verification into a Check Run", async () => {
    const double = createAppBoundaryDouble();
    const service = await startConfiguredGitHubVerificationService({
      port: 0,
      host: "127.0.0.1",
      env: configuredEnv(),
      applicationService: fakeApplicationService(),
      fetch: double.fetch,
    });
    try {
      const address = service.server.address();
      if (!address || typeof address === "string") {
        throw new Error("configured service did not bind a port");
      }
      // No test-side service.onSettled(...) and no injected checkPublisher:
      // publication must come from the configured composition itself.
      const webhookResponse = await postWebhook(
        address.port,
        makePayload(),
        "delivery-b55b-configured",
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");
      const deadline = Date.now() + 5000;
      for (;;) {
        const posts = double.calls.filter(
          (call) => call.method === "POST" && call.url.endsWith("/check-runs"),
        );
        if (posts.length >= 1) break;
        if (Date.now() >= deadline) {
          throw new Error("timed out waiting for configured Check Run POST");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const posts = double.calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/check-runs"),
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]?.body).toMatchObject({
        name: VERIFY_AGENT_CHECK_NAME,
        head_sha: HEAD_SHA,
        status: "completed",
      });
      // App installation authentication throughout: discovery/token calls
      // carry the App JWT (not the installation token), Checks calls carry
      // the installation token, and the ambient personal token never
      // appears anywhere.
      const discovery = double.calls.find((call) =>
        call.url.endsWith("/installation"),
      );
      expect(discovery?.authorization?.startsWith("Bearer ")).toBe(true);
      expect(discovery?.authorization).not.toBe(`Bearer ${INSTALLATION_TOKEN}`);
      for (const call of double.calls.filter((c) =>
        c.url.includes("/check-runs"),
      )) {
        expect(call.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
      }
      for (const call of double.calls) {
        expect(call.authorization).not.toContain(PERSONAL_TOKEN_SENTINEL);
        expect(call.url).not.toContain(PERSONAL_TOKEN_SENTINEL);
      }
      const stored = service.resultReader.getByQueueJobId(queueJobId);
      expect(stored).not.toBeNull();
    } finally {
      await service.stop();
    }
  });

  it("missing App configuration fails closed without token fallback", async () => {
    const double = createAppBoundaryDouble();
    const env: NodeJS.ProcessEnv = {
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_TOKEN: PERSONAL_TOKEN_SENTINEL,
    };
    const error = await startConfiguredGitHubVerificationService({
      port: 0,
      host: "127.0.0.1",
      env,
      applicationService: fakeApplicationService(),
      fetch: double.fetch,
    }).then(
      () => null,
      (cause: unknown) => cause as Error,
    );
    expect(error).not.toBeNull();
    expect(String(error?.name)).toContain("GitHubAppConfiguration");
    // Diagnosable without secrets, zero network, no fabricated publisher.
    expect(String(error?.message)).not.toContain(PERSONAL_TOKEN_SENTINEL);
    expect(String(error?.message)).not.toContain(SECRET);
    expect(String(error?.message)).not.toContain("PRIVATE KEY");
    expect(double.calls).toHaveLength(0);
  });

  it("partial App configuration fails closed", async () => {
    const double = createAppBoundaryDouble();
    const env: NodeJS.ProcessEnv = {
      GITHUB_APP_ID: String(OWN_APP_ID),
      GITHUB_WEBHOOK_SECRET: SECRET,
      GITHUB_TOKEN: PERSONAL_TOKEN_SENTINEL,
    };
    const error = await startConfiguredGitHubVerificationService({
      port: 0,
      host: "127.0.0.1",
      env,
      applicationService: fakeApplicationService(),
      fetch: double.fetch,
    }).then(
      () => null,
      (cause: unknown) => cause as Error,
    );
    expect(error).not.toBeNull();
    expect(String(error?.name)).toContain("GitHubAppConfiguration");
    expect(double.calls).toHaveLength(0);
  });
});
