/**
 * Batch 48 — GitHub PR-to-Verification composition harness (test-only).
 *
 * This module performs dependency wiring only. It duplicates no webhook
 * authentication, no source resolution, and no verification orchestration:
 * every stage delegates to the existing production boundary.
 *
 * ```text
 * authenticated GitHub PR event (HTTP)
 *   ↓ existing webhook boundary (HMAC + replay reserve/commit/rollback)
 * GitHubVerificationOrchestrator → VerificationQueueJob
 *   ↓ existing in-memory queue
 * VerificationJobProcessor (existing worker boundary)
 *   ↓ existing VerificationApplicationService.verifySource()
 * GitHub source resolver (existing adapter over an injected fixture provider)
 *   ↓ existing detection/planning/execution/evidence/policy pipeline
 * VerificationResult
 * ```
 *
 * The GitHub source provider is an in-memory deterministic fixture bound to
 * the expected immutable head SHA. No GitHub credentials, network, or live
 * API are required. The sandbox boundary is the existing
 * `FakeSandboxTransport` test double reached through the real
 * `createSandboxExecutorFromTransport` → `createCheckExecutor` → pipeline
 * path, so execution still flows through the controlled sandbox boundary and
 * never executes source commands on the host.
 *
 * This harness proves composition only. It provides no durable queue, no
 * worker loop, no persistence, no retries, and no GitHub writes.
 */

import { createHmac } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createGitHubVerificationOrchestrator } from "../apps/github-bot/src/verification-orchestrator.js";
import {
  createConfiguredGitHubWebhookHandler,
  createInMemoryGitHubWebhookReplayGuard,
  type GitHubWebhookReplayGuard,
} from "../apps/github-bot/src/webhook.js";
import {
  createVerificationJobProcessor,
  type VerificationJobProcessor,
} from "../apps/worker/src/index.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createSingleGitHubFixtureProvider,
  type GitHubSnapshotReference,
  type GitHubSourceProvider,
} from "../packages/adapters-source/src/github.js";
import type { SourceContents } from "../packages/adapters-source/src/resolver.js";
import {
  FakeSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createInMemoryVerificationJobQueue,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
  type InMemoryVerificationJobQueue,
} from "../packages/engine/src/index.js";

export const BATCH48_SECRET = "batch48-composition-secret";
export const BATCH48_OWNER = "octocat";
export const BATCH48_REPOSITORY = "hello-world";
export const BATCH48_PR_NUMBER = 42;
export const BATCH48_HEAD_SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
export const BATCH48_BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const BATCH48_CREATED_AT = "2026-09-25T00:00:00.000Z";
export const BATCH48_SOURCE_ID = `${BATCH48_OWNER}:${BATCH48_REPOSITORY}:${BATCH48_HEAD_SHA}`;
export const BATCH48_EXPECTED_SNAPSHOT_ID = `${BATCH48_OWNER}--${BATCH48_REPOSITORY}--${BATCH48_HEAD_SHA}`;

/**
 * Deterministic fixture source material for the expected head SHA. This is
 * the already-proven minimal TypeScript shape used by the application-service
 * boundary tests: static detection yields a single applicable
 * `typescript.typecheck` check.
 */
export const BATCH48_FIXTURE_CONTENTS: SourceContents = Object.freeze({
  "package.json": JSON.stringify({
    name: "batch48-fixture",
    devDependencies: { typescript: "5.0.0" },
  }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/index.ts": "export const value = 42;\n",
});

function sandboxSuccessResponse(request: { jobId: string }): unknown {
  return {
    schemaVersion: "1.0.0" as const,
    jobId: request.jobId,
    status: "completed" as const,
    exitCode: 0,
    durationMs: 5,
    logsRef: "fixture://logs/batch48-composition",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
    errors: [],
  };
}

export interface Batch48Composition {
  readonly queue: InMemoryVerificationJobQueue;
  readonly replayGuard: GitHubWebhookReplayGuard;
  readonly transport: FakeSandboxTransport;
  readonly applicationService: VerificationApplicationService;
  readonly processor: VerificationJobProcessor;
  readonly handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void;
  /** Immutable head-SHA references observed by the stub source provider. */
  readonly observedReferences: readonly GitHubSnapshotReference[];
}

export function createBatch48Composition(options?: {
  readonly createJobId?: () => string;
  readonly now?: () => string;
}): Batch48Composition {
  const queue = createInMemoryVerificationJobQueue();
  const replayGuard = createInMemoryGitHubWebhookReplayGuard();
  const transport = new FakeSandboxTransport(sandboxSuccessResponse);

  const observedReferences: GitHubSnapshotReference[] = [];
  const innerProvider: GitHubSourceProvider = createSingleGitHubFixtureProvider(
    {
      owner: BATCH48_OWNER,
      repository: BATCH48_REPOSITORY,
      sha: BATCH48_HEAD_SHA,
      sourceContents: { ...BATCH48_FIXTURE_CONTENTS },
    },
  );
  const spyingProvider: GitHubSourceProvider = {
    async resolveSnapshot(reference: GitHubSnapshotReference) {
      observedReferences.push(reference);
      return innerProvider.resolveSnapshot(reference);
    },
  };
  const sourceResolver = createGitHubSourceResolver(spyingProvider);

  const pipeline = createVerificationPipeline({
    detector: createProjectDetectionService(),
    executor: createCheckExecutor(
      createSandboxExecutorFromTransport(transport),
    ),
  });
  const applicationService = new VerificationApplicationService(
    pipeline,
    sourceResolver,
  );
  const processor = createVerificationJobProcessor(applicationService);

  let counter = 0;
  const orchestrator = createGitHubVerificationOrchestrator(queue, {
    createJobId:
      options?.createJobId ?? (() => `job-batch48-${(counter += 1)}`),
    now: options?.now ?? (() => BATCH48_CREATED_AT),
  });

  const handler = createConfiguredGitHubWebhookHandler({
    secret: BATCH48_SECRET,
    replayGuard,
    orchestrator,
  });

  return {
    queue,
    replayGuard,
    transport,
    applicationService,
    processor,
    handler,
    observedReferences,
  };
}

export function makeBatch48PullRequestPayload(action = "opened"): string {
  return JSON.stringify({
    action,
    repository: {
      owner: { login: BATCH48_OWNER },
      name: BATCH48_REPOSITORY,
    },
    pull_request: {
      number: BATCH48_PR_NUMBER,
      base: { sha: BATCH48_BASE_SHA },
      head: { sha: BATCH48_HEAD_SHA },
    },
  });
}

export function signBatch48Payload(
  payload: string,
  secret: string = BATCH48_SECRET,
): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function postBatch48Webhook(
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

export async function withBatch48Server(
  handler: (request: never, response: never) => void,
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
