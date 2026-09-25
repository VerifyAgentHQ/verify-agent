/**
 * Batch 48 — GitHub PR-to-Verification Composition Proof.
 *
 * Proves one focused integration path using only existing boundaries:
 *
 * ```text
 * authenticated GitHub PR event (HTTP, HMAC-SHA256)
 *   ↓ existing webhook boundary (authentication → replay reserve → parse)
 * GitHubVerificationOrchestrator → exactly one VerificationQueueJob
 *   ↓ existing in-memory queue (replay commit on success, rollback on failure)
 * VerificationJobProcessor (existing worker boundary)
 *   ↓ VerificationApplicationService.verifySource()
 * GitHub source resolver over an injected deterministic fixture provider
 *   ↓ existing detection/planning/execution/evidence/policy pipeline
 * VerificationResult bound to the same immutable head SHA
 * ```
 *
 * No durable queue, database, worker loop, retries, GitHub writes, AI,
 * network, or live credentials are involved. The sandbox boundary is the
 * existing `FakeSandboxTransport` reached through the real executor and
 * pipeline path; no host-side command execution is introduced.
 */

import { describe, expect, it, vi, type MockInstance } from "vitest";
import { createGitHubVerificationOrchestrator } from "../apps/github-bot/src/verification-orchestrator.js";
import {
  createConfiguredGitHubWebhookHandler,
  createInMemoryGitHubWebhookReplayGuard,
} from "../apps/github-bot/src/webhook.js";
import { createVerificationJobProcessor } from "../apps/worker/src/index.js";
import { decodeGitHubSnapshotReference } from "../packages/adapters-source/src/github.js";
import type { VerificationResult } from "../packages/domain/src/verification.js";
import {
  VerificationApplicationService,
  type VerifySourceRequest,
} from "../packages/engine/src/index.js";
import {
  BATCH48_BASE_SHA,
  BATCH48_EXPECTED_SNAPSHOT_ID,
  BATCH48_HEAD_SHA,
  BATCH48_OWNER,
  BATCH48_PR_NUMBER,
  BATCH48_REPOSITORY,
  BATCH48_SECRET,
  BATCH48_SOURCE_ID,
  createBatch48Composition,
  makeBatch48PullRequestPayload,
  postBatch48Webhook,
  signBatch48Payload,
  withBatch48Server,
  type Batch48Composition,
} from "./batch-48-composition.js";

interface ComposedRun {
  readonly composition: Batch48Composition;
  readonly httpStatus: number;
  readonly httpBody: string;
  readonly verifySourceCallsBeforeWorker: number;
  readonly queueSizeBeforeWorker: number;
  readonly verifySourceSpy: MockInstance<
    (input: VerifySourceRequest) => Promise<VerificationResult>
  >;
  readonly result: VerificationResult | null;
}

/**
 * Full composition run: authenticated webhook POST, then worker consumption
 * of the queued job. Records the application-service call count at the
 * moment the webhook response arrives (before the worker runs) so tests can
 * prove the webhook never verifies synchronously.
 */
async function runComposedVerification(
  delivery: string,
  action = "opened",
): Promise<ComposedRun> {
  const composition = createBatch48Composition();
  const spy = vi.spyOn(composition.applicationService, "verifySource");
  let httpStatus = 0;
  let httpBody = "";
  let verifySourceCallsBeforeWorker = -1;
  let queueSizeBeforeWorker = -1;
  let result: ComposedRun["result"] = null;

  await withBatch48Server(composition.handler, async (port) => {
    const payload = makeBatch48PullRequestPayload(action);
    const response = await postBatch48Webhook(
      port,
      payload,
      signBatch48Payload(payload),
      delivery,
    );
    httpStatus = response.status;
    httpBody = response.body;
    verifySourceCallsBeforeWorker = spy.mock.calls.length;
    queueSizeBeforeWorker = composition.queue.size();
    if (httpStatus === 202 && queueSizeBeforeWorker === 1) {
      result = await composition.processor.process(composition.queue.jobs[0]);
    }
  });

  return {
    composition,
    httpStatus,
    httpBody,
    verifySourceCallsBeforeWorker,
    queueSizeBeforeWorker,
    verifySourceSpy: spy,
    result,
  };
}

describe("Batch 48 — GitHub PR-to-Verification composition", () => {
  it("Test 1 — authenticated PR creates exactly one queue job", async () => {
    const composition = createBatch48Composition();
    const delivery = "delivery-batch48-t1";

    await withBatch48Server(composition.handler, async (port) => {
      const payload = makeBatch48PullRequestPayload("opened");
      const response = await postBatch48Webhook(
        port,
        payload,
        signBatch48Payload(payload),
        delivery,
      );

      expect(response.status).toBe(202);
      expect(JSON.parse(response.body)).toMatchObject({ status: "accepted" });
      expect(composition.queue.size()).toBe(1);
      // Replay committed only after successful enqueue.
      expect(composition.replayGuard.isReplay(delivery)).toBe(true);
    });
  });

  it("Test 2 — queued job preserves the immutable PR identity", async () => {
    const run = await runComposedVerification("delivery-batch48-t2");
    expect(run.httpStatus).toBe(202);

    const job = run.composition.queue.jobs[0];
    expect(job.source).toEqual({ kind: "snapshot", id: BATCH48_SOURCE_ID });
    expect(job.source.id).toContain(BATCH48_HEAD_SHA);
    expect(job.source.id).not.toContain(BATCH48_BASE_SHA);
    expect(job.trigger).toMatchObject({
      kind: "pull-request",
      action: "opened",
      pullRequestNumber: BATCH48_PR_NUMBER,
    });
    expect(job.deliveryId).toBe("delivery-batch48-t2");

    const decoded = decodeGitHubSnapshotReference(job.source.id);
    expect(decoded).toMatchObject({
      kind: "github-snapshot",
      owner: BATCH48_OWNER,
      repository: BATCH48_REPOSITORY,
      sha: BATCH48_HEAD_SHA,
    });
  });

  it("Test 3 — worker consumes the queued job through the existing boundary", async () => {
    const run = await runComposedVerification("delivery-batch48-t3");

    expect(run.queueSizeBeforeWorker).toBe(1);
    // The queued job was processed exactly once through the worker boundary.
    expect(run.verifySourceSpy).toHaveBeenCalledTimes(1);
    expect(run.result).not.toBeNull();
  });

  it("Test 4 — source resolver receives the exact immutable reference", async () => {
    const run = await runComposedVerification("delivery-batch48-t4");

    const observed = run.composition.observedReferences;
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      kind: "github-snapshot",
      owner: BATCH48_OWNER,
      repository: BATCH48_REPOSITORY,
      sha: BATCH48_HEAD_SHA,
    });
    // A base-SHA or branch substitution would resolve a different fixture or
    // fail outright; the recorded request must be the PR head SHA.
    expect(observed[0].sha).not.toBe(BATCH48_BASE_SHA);
    expect(observed[0].sha).toBe(BATCH48_HEAD_SHA);
  });

  it("Test 5 — worker delegates to the real VerificationApplicationService", async () => {
    const run = await runComposedVerification("delivery-batch48-t5");

    expect(run.composition.applicationService).toBeInstanceOf(
      VerificationApplicationService,
    );
    // Delegation happened through the worker processor with the
    // provider-neutral queue source — the webhook never calls the service.
    expect(run.verifySourceSpy).toHaveBeenCalledTimes(1);
    expect(run.verifySourceSpy).toHaveBeenCalledWith({
      source: run.composition.queue.jobs[0].source,
    });
    expect(run.result).not.toBeNull();
  });

  it("Test 6 — composition produces a real VerificationResult with provenance", async () => {
    const run = await runComposedVerification("delivery-batch48-t6");
    expect(run.httpStatus).toBe(202);

    const result = run.result;
    expect(result).not.toBeNull();
    if (result === null) return;

    // Source-to-result identity trace: PR head SHA → queue job → resolver →
    // result snapshot.
    expect(String(result.snapshotId)).toBe(BATCH48_EXPECTED_SNAPSHOT_ID);
    expect(String(result.snapshotId)).toContain(BATCH48_HEAD_SHA);
    expect(result.checkResults.length).toBeGreaterThanOrEqual(1);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.resultVersion).toBe("1.0.0");

    // Evidence provenance flowed through the pipeline: simulated sandbox
    // execution is recorded in coverage, and policy evaluated accordingly.
    expect(result.coverage.simulated).toContain("typescript.typecheck");
    expect(result.status).toBe("needs_changes");

    // Execution reached the controlled sandbox boundary exactly once — no
    // host-side bypass, no duplicate execution path.
    expect(run.composition.transport.requests).toHaveLength(1);

    // No credential leakage into the result or the sandbox request.
    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(BATCH48_SECRET);
    expect(serializedResult).not.toContain("ghs_");
    expect(serializedResult).not.toContain("Bearer");
    const serializedRequest = JSON.stringify(
      run.composition.transport.requests[0],
    );
    expect(serializedRequest).not.toContain(BATCH48_SECRET);
  });

  it("Test 7 — invalid authentication creates nothing", async () => {
    const composition = createBatch48Composition();
    const spy = vi.spyOn(composition.applicationService, "verifySource");
    const delivery = "delivery-batch48-t7";

    await withBatch48Server(composition.handler, async (port) => {
      const payload = makeBatch48PullRequestPayload("opened");
      const response = await postBatch48Webhook(
        port,
        payload,
        `sha256=${"0".repeat(64)}`,
        delivery,
      );

      expect(response.status).toBe(401);
      expect(composition.queue.size()).toBe(0);
      // Failed authentication must not consume replay state.
      expect(composition.replayGuard.isReplay(delivery)).toBe(false);
      expect(composition.replayGuard.size()).toBe(0);
    });

    expect(spy).not.toHaveBeenCalled();
    expect(composition.observedReferences).toHaveLength(0);
  });

  it("Test 8 — unsupported event/action remains ignored", async () => {
    const composition = createBatch48Composition();
    const spy = vi.spyOn(composition.applicationService, "verifySource");

    await withBatch48Server(composition.handler, async (port) => {
      const closedPayload = makeBatch48PullRequestPayload("closed");
      const closed = await postBatch48Webhook(
        port,
        closedPayload,
        signBatch48Payload(closedPayload),
        "delivery-batch48-t8-closed",
      );
      expect(closed.status).toBe(202);
      expect(JSON.parse(closed.body)).toMatchObject({ status: "ignored" });

      const openedPayload = makeBatch48PullRequestPayload("opened");
      const push = await postBatch48Webhook(
        port,
        openedPayload,
        signBatch48Payload(openedPayload),
        "delivery-batch48-t8-push",
        "push",
      );
      expect(push.status).toBe(202);
      expect(JSON.parse(push.body)).toMatchObject({ status: "ignored" });

      expect(composition.queue.size()).toBe(0);
    });

    expect(spy).not.toHaveBeenCalled();
    expect(composition.observedReferences).toHaveLength(0);
  });

  it("Test 9 — webhook returns before the worker processes the job", async () => {
    const run = await runComposedVerification("delivery-batch48-t9");

    expect(run.httpStatus).toBe(202);
    // At the moment the webhook response arrived, the application service
    // had not been invoked: the webhook only enqueues.
    expect(run.verifySourceCallsBeforeWorker).toBe(0);
    expect(run.queueSizeBeforeWorker).toBe(1);
    // The worker processed the job afterwards through the existing boundary.
    expect(run.verifySourceSpy).toHaveBeenCalledTimes(1);
    expect(run.result).not.toBeNull();
  });

  it("Test 10 — queue failure preserves existing retryable/error semantics", async () => {
    let failFirst = true;
    const conditionalQueue = {
      enqueue: async (): Promise<void> => {
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
      secret: BATCH48_SECRET,
      replayGuard: guard,
      orchestrator,
    });
    const delivery = "delivery-batch48-t10";

    await withBatch48Server(handler, async (port) => {
      const payload = makeBatch48PullRequestPayload("opened");

      const first = await postBatch48Webhook(
        port,
        payload,
        signBatch48Payload(payload),
        delivery,
      );
      expect(first.status).toBe(500);
      expect(first.body).toContain("internal server error");
      expect(first.body).not.toContain(BATCH48_SECRET);
      // Rollback: the failed delivery remains retryable.
      expect(guard.isReplay(delivery)).toBe(false);

      const second = await postBatch48Webhook(
        port,
        payload,
        signBatch48Payload(payload),
        delivery,
      );
      expect(second.status).toBe(202);
      expect(JSON.parse(second.body)).toMatchObject({ status: "accepted" });
      expect(guard.isReplay(delivery)).toBe(true);
    });

    // Worker contract: malformed jobs are rejected before the service runs.
    const composition = createBatch48Composition();
    const spy = vi.spyOn(composition.applicationService, "verifySource");
    const validJob = {
      jobId: "job-batch48-t10",
      source: { kind: "snapshot", id: BATCH48_SOURCE_ID },
      trigger: {
        kind: "pull-request",
        action: "opened",
        pullRequestNumber: BATCH48_PR_NUMBER,
      },
      deliveryId: "delivery-batch48-t10-worker",
      createdAt: "2026-09-25T00:00:00.000Z",
    } as const;
    const processor = createVerificationJobProcessor(
      composition.applicationService,
    );
    await expect(
      processor.process({ ...validJob, deliveryId: "" }),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
