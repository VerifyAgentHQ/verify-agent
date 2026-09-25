/**
 * Batch 49 — In-Process Job Runtime and Result Observation.
 *
 * Proves the application-owned runtime over the existing composition:
 *
 * ```text
 * enqueue(VerificationQueueJob)
 *   ↓ VerificationJobRuntime (start/processNext/drain/stop, explicit)
 * VerificationJobProcessor (existing worker boundary)
 *   ↓ VerificationApplicationService.verifySource()
 * GitHub source resolver over an injected deterministic fixture provider
 *   ↓ existing detection/planning/execution/evidence/policy pipeline
 * VerificationResult
 *   ↓ bounded in-memory result registry (process-local, non-durable)
 * narrow read surface: getByVerificationId / getByJobId
 * ```
 *
 * No durable queue, database, worker daemon, retries, GitHub writes, AI, or
 * host execution are involved. The sandbox boundary is the existing
 * `FakeSandboxTransport` reached through the real executor and pipeline.
 */

import { describe, expect, it, vi } from "vitest";
import { createVerificationJobProcessor } from "../apps/worker/src/index.js";
import {
  VerificationJobRuntimeError,
  createInMemoryVerificationResultRegistry,
  createVerificationJobRuntime,
  type VerificationJobRuntimeOutcome,
  type VerificationResultRegistry,
} from "../apps/worker/src/index.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
} from "../packages/adapters-source/src/github.js";
import type { VerificationQueueJob } from "../packages/domain/src/verification-queue.js";
import { createVerificationQueueJob } from "../packages/domain/src/verification-queue.js";
import type { VerificationResult } from "../packages/domain/src/verification.js";
import {
  FakeSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createInMemoryVerificationJobQueue,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
  type InMemoryVerificationJobQueue,
} from "../packages/engine/src/index.js";
import {
  BATCH48_EXPECTED_SNAPSHOT_ID,
  BATCH48_SOURCE_ID,
  createBatch48Composition,
  makeBatch48PullRequestPayload,
  postBatch48Webhook,
  signBatch48Payload,
  withBatch48Server,
} from "./batch-48-composition.js";

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const CREATED_AT = "2026-09-25T00:00:00.000Z";

const FIXTURE_CONTENTS = Object.freeze({
  "package.json": JSON.stringify({
    name: "batch49-fixture",
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
    logsRef: "fixture://logs/batch49",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
    errors: [],
  };
}

function makeJob(
  sha: string,
  suffix: string,
  action = "opened",
): VerificationQueueJob {
  return createVerificationQueueJob({
    jobId: `job-b49-${suffix}`,
    source: { kind: "snapshot", id: `${OWNER}:${REPOSITORY}:${sha}` },
    trigger: {
      kind: "pull-request",
      action,
      pullRequestNumber: 42,
    },
    deliveryId: `delivery-b49-${suffix}`,
    createdAt: CREATED_AT,
  });
}

interface RuntimeHarness {
  readonly queue: InMemoryVerificationJobQueue;
  readonly transport: FakeSandboxTransport;
  readonly service: VerificationApplicationService;
  readonly registry: VerificationResultRegistry;
  readonly runtime: ReturnType<typeof createVerificationJobRuntime>;
}

function createRuntimeHarness(
  shas: readonly string[],
  options?: { maxResults?: number },
): RuntimeHarness {
  const queue = createInMemoryVerificationJobQueue();
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
  const service = new VerificationApplicationService(
    createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    }),
    createGitHubSourceResolver(provider),
  );
  const registry = createInMemoryVerificationResultRegistry(
    options?.maxResults === undefined ? {} : { maxResults: options.maxResults },
  );
  const runtime = createVerificationJobRuntime({
    queue,
    processor: createVerificationJobProcessor(service),
    registry,
  });
  return { queue, transport, service, registry, runtime };
}

function completedOf(
  outcome: VerificationJobRuntimeOutcome,
): Extract<VerificationJobRuntimeOutcome, { kind: "completed" }> {
  expect(outcome.kind).toBe("completed");
  return outcome as Extract<
    VerificationJobRuntimeOutcome,
    { kind: "completed" }
  >;
}

describe("Batch 49 — in-process job runtime and result observation", () => {
  it("Test 1 — runtime consumes a queued job through the worker", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    const verifySource = vi.spyOn(harness.service, "verifySource");
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "t1"));
    const outcome = await harness.runtime.processNext();

    const completed = completedOf(outcome);
    expect(verifySource).toHaveBeenCalledTimes(1);
    expect(verifySource).toHaveBeenCalledWith({
      source: completed.job.source,
    });
    expect(completed.job.source).toEqual({
      kind: "snapshot",
      id: `${OWNER}:${REPOSITORY}:${sha}`,
    });
  });

  it("Test 2 — completed result becomes observable in the registry", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "t2"));
    const completed = completedOf(await harness.runtime.processNext());

    expect(
      harness.registry.getByVerificationId(String(completed.result.id)),
    ).toEqual(completed.result);
    // The job identity that exists naturally on the result is the
    // application-service job identity, correlated here via the outcome.
    expect(completed.job.jobId).toBe("job-b49-t2");
    expect(harness.registry.getByJobId(String(completed.result.jobId))).toEqual(
      completed.result,
    );
    expect(harness.registry.size()).toBe(1);
  });

  it("Test 3 — source identity survives the runtime boundary", async () => {
    const sha = "b".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "t3"));
    const completed = completedOf(await harness.runtime.processNext());

    expect(completed.job.source.id).toContain(sha);
    expect(String(completed.result.snapshotId)).toBe(
      `${OWNER}--${REPOSITORY}--${sha}`,
    );
    const observed = harness.registry.getByVerificationId(
      String(completed.result.id),
    );
    expect(String(observed?.snapshotId)).toContain(sha);
    expect(completed.result.checkResults.length).toBeGreaterThanOrEqual(1);
  });

  it("Test 4 — worker failure registers nothing and wedges nothing", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    const realProcessor = createVerificationJobProcessor(harness.service);
    const failure = new Error("sandbox backend down");
    const processor = {
      process: vi
        .fn<(job: VerificationQueueJob) => Promise<VerificationResult>>()
        .mockRejectedValueOnce(failure)
        .mockImplementation((job: VerificationQueueJob) =>
          realProcessor.process(job),
        ),
    };
    const runtime = createVerificationJobRuntime({
      queue: harness.queue,
      processor,
      registry: harness.registry,
    });
    runtime.start();

    await harness.queue.enqueue(makeJob(sha, "t4-fail"));
    const failed = await runtime.processNext();
    expect(failed.kind).toBe("failed");
    if (failed.kind === "failed") {
      expect(failed.error).toBe(failure);
      expect(failed.job.jobId).toBe("job-b49-t4-fail");
    }
    expect(harness.registry.size()).toBe(0);
    expect(
      harness.registry.getByVerificationId("job-b49-t4-fail-verification"),
    ).toBeUndefined();
    expect(harness.registry.getByQueueJobId("job-b49-t4-fail")).toBeUndefined();

    await harness.queue.enqueue(makeJob(sha, "t4-recover"));
    const recovered = completedOf(await runtime.processNext());
    expect(recovered.job.jobId).toBe("job-b49-t4-recover");
    expect(harness.registry.size()).toBe(1);
    expect(harness.registry.getByJobId(String(recovered.result.jobId))).toEqual(
      recovered.result,
    );
    expect(harness.registry.getByQueueJobId("job-b49-t4-recover")).toEqual(
      recovered.result,
    );
  });

  it("Test 5 — multiple jobs complete without collision or confusion", async () => {
    const shas = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const harness = createRuntimeHarness(shas);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(shas[0], "t5-a"));
    await harness.queue.enqueue(makeJob(shas[1], "t5-b"));
    await harness.queue.enqueue(makeJob(shas[2], "t5-c"));

    const outcomes = await harness.runtime.drain();
    expect(outcomes).toHaveLength(3);
    const completed = outcomes.map(completedOf);

    const snapshotIds = new Set(
      completed.map((entry) => String(entry.result.snapshotId)),
    );
    expect(snapshotIds.size).toBe(3);
    completed.forEach((entry, index) => {
      expect(entry.job.source.id).toContain(shas[index]);
      expect(String(entry.result.snapshotId)).toBe(
        `${OWNER}--${REPOSITORY}--${shas[index]}`,
      );
      expect(harness.registry.getByJobId(String(entry.result.jobId))).toEqual(
        entry.result,
      );
    });
    expect(harness.registry.size()).toBe(3);
    // Every job reached the controlled sandbox boundary exactly once.
    expect(harness.transport.requests).toHaveLength(3);
  });

  it("Test 6 — registry retention is bounded and deterministic", async () => {
    expect(() =>
      createInMemoryVerificationResultRegistry({ maxResults: 0 }),
    ).toThrow();
    expect(() =>
      createInMemoryVerificationResultRegistry({ maxResults: 1.5 }),
    ).toThrow();

    const shas = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const harness = createRuntimeHarness(shas, { maxResults: 2 });
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(shas[0], "t6-a"));
    await harness.queue.enqueue(makeJob(shas[1], "t6-b"));
    await harness.queue.enqueue(makeJob(shas[2], "t6-c"));
    const completed = (await harness.runtime.drain()).map(completedOf);

    expect(harness.registry.size()).toBe(2);
    // Oldest evicted first; newest retained — on every index.
    expect(
      harness.registry.getByVerificationId(String(completed[0].result.id)),
    ).toBeUndefined();
    expect(
      harness.registry.getByJobId(String(completed[0].result.jobId)),
    ).toBeUndefined();
    expect(harness.registry.getByQueueJobId("job-b49-t6-a")).toBeUndefined();
    expect(
      harness.registry.getByVerificationId(String(completed[1].result.id)),
    ).toEqual(completed[1].result);
    expect(
      harness.registry.getByVerificationId(String(completed[2].result.id)),
    ).toEqual(completed[2].result);
    expect(harness.registry.getByQueueJobId("job-b49-t6-b")).toBe(
      completed[1].result,
    );
    expect(harness.registry.getByQueueJobId("job-b49-t6-c")).toBe(
      completed[2].result,
    );
  });

  it("Test 7 — observed results are immutable registry state", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "t7"));
    const completed = completedOf(await harness.runtime.processNext());
    const observed = harness.registry.getByVerificationId(
      String(completed.result.id),
    );
    expect(observed).toBeDefined();
    if (observed === undefined) return;

    expect(Object.isFrozen(observed)).toBe(true);
    expect(Object.isFrozen(observed.coverage.simulated)).toBe(true);
    expect(() => {
      (observed as unknown as Record<string, unknown>).status = "pass";
    }).toThrow();
    expect(
      harness.registry.getByVerificationId(String(completed.result.id)),
    ).toBe(observed);
    expect(
      harness.registry.getByVerificationId(String(completed.result.id))?.status,
    ).toBe(completed.result.status);
  });

  it("Test 8 — authenticated PR flows through queue, runtime, and registry", async () => {
    const composition = createBatch48Composition();
    const registry = createInMemoryVerificationResultRegistry();
    const runtime = createVerificationJobRuntime({
      queue: composition.queue,
      processor: composition.processor,
      registry,
    });
    const verifySource = vi.spyOn(
      composition.applicationService,
      "verifySource",
    );
    runtime.start();

    await withBatch48Server(composition.handler, async (port) => {
      const payload = makeBatch48PullRequestPayload("opened");
      const response = await postBatch48Webhook(
        port,
        payload,
        signBatch48Payload(payload),
        "delivery-b49-t8",
      );
      expect(response.status).toBe(202);
      expect(verifySource).not.toHaveBeenCalled();

      // No manual queue access: the runtime owns consumption.
      const outcome = completedOf(await runtime.processNext());
      expect(outcome.job.source).toEqual({
        kind: "snapshot",
        id: BATCH48_SOURCE_ID,
      });
      expect(verifySource).toHaveBeenCalledTimes(1);
    });

    expect(registry.size()).toBe(1);
    const stored = registry.getByVerificationId(
      `${BATCH48_SOURCE_ID}-verification`,
    );
    expect(String(stored?.snapshotId)).toBe(BATCH48_EXPECTED_SNAPSHOT_ID);
    expect(composition.transport.requests).toHaveLength(1);
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("batch48-composition-secret");
  });

  it("Test 8b — invalid authentication still queues nothing for the runtime", async () => {
    const composition = createBatch48Composition();
    const registry = createInMemoryVerificationResultRegistry();
    const runtime = createVerificationJobRuntime({
      queue: composition.queue,
      processor: composition.processor,
      registry,
    });
    runtime.start();

    await withBatch48Server(composition.handler, async (port) => {
      const payload = makeBatch48PullRequestPayload("opened");
      const response = await postBatch48Webhook(
        port,
        payload,
        `sha256=${"0".repeat(64)}`,
        "delivery-b49-t8b",
      );
      expect(response.status).toBe(401);
      expect(await runtime.processNext()).toEqual({ kind: "idle" });
    });

    expect(registry.size()).toBe(0);
  });

  it("Test 9 — replayed delivery produces no second job or result", async () => {
    const composition = createBatch48Composition();
    const registry = createInMemoryVerificationResultRegistry();
    const runtime = createVerificationJobRuntime({
      queue: composition.queue,
      processor: composition.processor,
      registry,
    });
    runtime.start();

    await withBatch48Server(composition.handler, async (port) => {
      const payload = makeBatch48PullRequestPayload("opened");
      const first = await postBatch48Webhook(
        port,
        payload,
        signBatch48Payload(payload),
        "delivery-b49-t9",
      );
      expect(first.status).toBe(202);
      const second = await postBatch48Webhook(
        port,
        payload,
        signBatch48Payload(payload),
        "delivery-b49-t9",
      );
      expect(second.status).toBe(409);
    });

    const outcomes = await runtime.drain();
    expect(outcomes).toHaveLength(1);
    expect(completedOf(outcomes[0]).job.deliveryId).toBe("delivery-b49-t9");
    expect(registry.size()).toBe(1);
  });

  it("Test A — result is retrievable by queue job ID after completion", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tA"));
    const completed = completedOf(await harness.runtime.processNext());

    // Only the queue job identity is retained; the outcome object itself is
    // no longer needed for correlation.
    const queueJobId: string = completed.job.jobId;
    expect(harness.registry.getByQueueJobId(queueJobId)).toBe(completed.result);
    expect(harness.registry.getByQueueJobId(queueJobId)).toEqual(
      completed.result,
    );
  });

  it("Test B — queue job identity stays distinct from result job identity", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tB"));
    const completed = completedOf(await harness.runtime.processNext());

    // The architecture legitimately keeps these identities separate; the
    // registry correlates them instead of collapsing them.
    expect(completed.job.jobId).toBe("job-b49-tB");
    expect(String(completed.result.jobId)).not.toBe(completed.job.jobId);
    expect(harness.registry.getByQueueJobId("job-b49-tB")).toBe(
      completed.result,
    );
    expect(harness.registry.getByJobId(String(completed.result.jobId))).toBe(
      completed.result,
    );
  });

  it("Test C — each queued job maps to its own result", async () => {
    const shas = ["a".repeat(40), "b".repeat(40), "c".repeat(40)];
    const harness = createRuntimeHarness(shas);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(shas[0], "tC-a"));
    await harness.queue.enqueue(makeJob(shas[1], "tC-b"));
    await harness.queue.enqueue(makeJob(shas[2], "tC-c"));
    await harness.runtime.drain();

    (["tC-a", "tC-b", "tC-c"] as const).forEach((suffix, index) => {
      const stored = harness.registry.getByQueueJobId(`job-b49-${suffix}`);
      expect(stored).toBeDefined();
      expect(String(stored?.snapshotId)).toBe(
        `${OWNER}--${REPOSITORY}--${shas[index]}`,
      );
    });
  });

  it("Test D — duplicate native result jobId is rejected atomically", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tD"));
    const base = completedOf(await harness.runtime.processNext()).result;
    harness.registry.clear();

    const resultA = {
      ...base,
      id: "verification-D-A",
      jobId: "native-job-D-X",
    } as VerificationResult;
    const resultB = {
      ...base,
      id: "verification-D-B",
      jobId: "native-job-D-X",
    } as VerificationResult;

    const registry = createInMemoryVerificationResultRegistry();
    const storedA = registry.store("queue-D1", resultA);

    expect(() => registry.store("queue-D2", resultB)).toThrow(
      /already registered/,
    );
    // The rejected store leaves every index unchanged.
    expect(registry.size()).toBe(1);
    expect(registry.getByVerificationId("verification-D-A")).toBe(storedA);
    expect(registry.getByJobId("native-job-D-X")).toBe(storedA);
    expect(registry.getByQueueJobId("queue-D1")).toBe(storedA);
    expect(registry.getByVerificationId("verification-D-B")).toBeUndefined();
    expect(registry.getByQueueJobId("queue-D2")).toBeUndefined();

    expect(() => registry.store("   ", resultA)).toThrow(/queueJobId/);
    expect(registry.size()).toBe(1);
  });

  it("Test F — same verification ID replaces all mappings consistently", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tF"));
    const base = completedOf(await harness.runtime.processNext()).result;

    const registry = createInMemoryVerificationResultRegistry();
    const initial = {
      ...base,
      id: "verification-F",
      jobId: "native-job-F-X",
    } as VerificationResult;
    expect(registry.store("queue-F1", initial)).toBe(
      registry.getByQueueJobId("queue-F1"),
    );
    const replacement = {
      ...base,
      id: "verification-F",
      jobId: "native-job-F-Y",
      summary: `${base.summary} (superseded)`,
    } as VerificationResult;
    const stored = registry.store("queue-F2", replacement);

    expect(registry.size()).toBe(1);
    expect(registry.getByVerificationId("verification-F")).toBe(stored);
    expect(registry.getByQueueJobId("queue-F1")).toBeUndefined();
    expect(registry.getByQueueJobId("queue-F2")).toBe(stored);
    expect(registry.getByJobId("native-job-F-Y")).toBe(stored);
    expect(registry.getByJobId("native-job-F-X")).toBeUndefined();
  });

  it("Test G — worker failure creates no queue-job correlation", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    const runtime = createVerificationJobRuntime({
      queue: harness.queue,
      processor: {
        process: async () => {
          throw new Error("resolver unavailable");
        },
      },
      registry: harness.registry,
    });
    runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tG"));
    const outcome = await runtime.processNext();
    expect(outcome.kind).toBe("failed");

    expect(harness.registry.size()).toBe(0);
    expect(harness.registry.getByQueueJobId("job-b49-tG")).toBeUndefined();
  });

  it("Test H — replacement colliding with another native jobId is rejected atomically", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tH"));
    const base = completedOf(await harness.runtime.processNext()).result;

    const registry = createInMemoryVerificationResultRegistry();
    const resultA = {
      ...base,
      id: "verification-H-A",
      jobId: "native-job-H-X",
    } as VerificationResult;
    const resultB = {
      ...base,
      id: "verification-H-B",
      jobId: "native-job-H-Y",
    } as VerificationResult;
    const storedA = registry.store("queue-H1", resultA);
    const storedB = registry.store("queue-H2", resultB);
    expect(registry.size()).toBe(2);

    const colliding = {
      ...base,
      id: "verification-H-A",
      jobId: "native-job-H-Y",
    } as VerificationResult;
    expect(() => registry.store("queue-H3", colliding)).toThrow(
      /already registered/,
    );

    // Zero mutation: every index still resolves to its pre-existing value.
    expect(registry.size()).toBe(2);
    expect(registry.getByVerificationId("verification-H-A")).toBe(storedA);
    expect(registry.getByVerificationId("verification-H-B")).toBe(storedB);
    expect(registry.getByJobId("native-job-H-X")).toBe(storedA);
    expect(registry.getByJobId("native-job-H-Y")).toBe(storedB);
    expect(registry.getByQueueJobId("queue-H1")).toBe(storedA);
    expect(registry.getByQueueJobId("queue-H2")).toBe(storedB);
    expect(registry.getByQueueJobId("queue-H3")).toBeUndefined();
  });

  it("Test I — replacement colliding with another queue jobId is rejected atomically", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tI"));
    const base = completedOf(await harness.runtime.processNext()).result;

    const registry = createInMemoryVerificationResultRegistry();
    const resultA = {
      ...base,
      id: "verification-I-A",
      jobId: "native-job-I-X",
    } as VerificationResult;
    const resultB = {
      ...base,
      id: "verification-I-B",
      jobId: "native-job-I-Y",
    } as VerificationResult;
    const storedA = registry.store("queue-I1", resultA);
    const storedB = registry.store("queue-I2", resultB);
    expect(registry.size()).toBe(2);

    // Reuses A's own native jobId so only the queue correlation collides.
    const colliding = {
      ...base,
      id: "verification-I-A",
      jobId: "native-job-I-X",
    } as VerificationResult;
    expect(() => registry.store("queue-I2", colliding)).toThrow(
      /already registered/,
    );

    expect(registry.size()).toBe(2);
    expect(registry.getByVerificationId("verification-I-A")).toBe(storedA);
    expect(registry.getByVerificationId("verification-I-B")).toBe(storedB);
    expect(registry.getByJobId("native-job-I-X")).toBe(storedA);
    expect(registry.getByJobId("native-job-I-Y")).toBe(storedB);
    expect(registry.getByQueueJobId("queue-I1")).toBe(storedA);
    expect(registry.getByQueueJobId("queue-I2")).toBe(storedB);
  });

  it("Test J — replacement changes both IDs without conflict", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tJ"));
    const base = completedOf(await harness.runtime.processNext()).result;

    const registry = createInMemoryVerificationResultRegistry();
    const initial = {
      ...base,
      id: "verification-J-A",
      jobId: "native-job-J-X",
    } as VerificationResult;
    registry.store("queue-J1", initial);
    expect(registry.size()).toBe(1);

    const replacement = {
      ...base,
      id: "verification-J-A",
      jobId: "native-job-J-Y",
    } as VerificationResult;
    const stored = registry.store("queue-J2", replacement);

    expect(registry.size()).toBe(1);
    expect(registry.getByVerificationId("verification-J-A")).toBe(stored);
    expect(registry.getByJobId("native-job-J-X")).toBeUndefined();
    expect(registry.getByQueueJobId("queue-J1")).toBeUndefined();
    expect(registry.getByJobId("native-job-J-Y")).toBe(stored);
    expect(registry.getByQueueJobId("queue-J2")).toBe(stored);
  });

  it("Test K — replacement reusing its own IDs succeeds without growth", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tK"));
    const base = completedOf(await harness.runtime.processNext()).result;

    const registry = createInMemoryVerificationResultRegistry();
    const initial = {
      ...base,
      id: "verification-K-A",
      jobId: "native-job-K-X",
    } as VerificationResult;
    registry.store("queue-K1", initial);
    expect(registry.size()).toBe(1);

    const replacement = {
      ...base,
      id: "verification-K-A",
      jobId: "native-job-K-X",
      summary: `${base.summary} (refreshed)`,
    } as VerificationResult;
    const stored = registry.store("queue-K1", replacement);

    expect(registry.size()).toBe(1);
    expect(registry.getByVerificationId("verification-K-A")).toBe(stored);
    expect(registry.getByJobId("native-job-K-X")).toBe(stored);
    expect(registry.getByQueueJobId("queue-K1")).toBe(stored);
  });

  it("Test L — replacement with simultaneous native and queue conflicts leaves zero mutation", async () => {
    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    harness.runtime.start();

    await harness.queue.enqueue(makeJob(sha, "tL"));
    const base = completedOf(await harness.runtime.processNext()).result;

    const registry = createInMemoryVerificationResultRegistry();
    const resultA = {
      ...base,
      id: "verification-L-A",
      jobId: "native-job-L-X",
    } as VerificationResult;
    const resultB = {
      ...base,
      id: "verification-L-B",
      jobId: "native-job-L-Y",
    } as VerificationResult;
    const resultC = {
      ...base,
      id: "verification-L-C",
      jobId: "native-job-L-Z",
    } as VerificationResult;
    const storedA = registry.store("queue-L1", resultA);
    const storedB = registry.store("queue-L2", resultB);
    const storedC = registry.store("queue-L3", resultC);
    expect(registry.size()).toBe(3);

    // B owns native-job-L-Y and C owns queue-L3; A claims both at once.
    const colliding = {
      ...base,
      id: "verification-L-A",
      jobId: "native-job-L-Y",
    } as VerificationResult;
    expect(() => registry.store("queue-L3", colliding)).toThrow(
      /already registered/,
    );

    expect(registry.size()).toBe(3);
    expect(registry.getByVerificationId("verification-L-A")).toBe(storedA);
    expect(registry.getByVerificationId("verification-L-B")).toBe(storedB);
    expect(registry.getByVerificationId("verification-L-C")).toBe(storedC);
    expect(registry.getByJobId("native-job-L-X")).toBe(storedA);
    expect(registry.getByJobId("native-job-L-Y")).toBe(storedB);
    expect(registry.getByJobId("native-job-L-Z")).toBe(storedC);
    expect(registry.getByQueueJobId("queue-L1")).toBe(storedA);
    expect(registry.getByQueueJobId("queue-L2")).toBe(storedB);
    expect(registry.getByQueueJobId("queue-L3")).toBe(storedC);
  });

  it("Test 10 — runtime lifecycle is explicit and recoverable", async () => {
    expect(() => createVerificationJobRuntime({} as never)).toThrow(
      VerificationJobRuntimeError,
    );
    expect(() =>
      createVerificationJobRuntime({
        queue: { enqueue: async () => {} } as never,
        processor: createVerificationJobProcessor({
          verifySource: async () => ({}) as never,
        }),
        registry: createInMemoryVerificationResultRegistry(),
      }),
    ).toThrow(VerificationJobRuntimeError);

    const sha = "a".repeat(40);
    const harness = createRuntimeHarness([sha]);
    const { runtime } = harness;

    expect(runtime.isRunning()).toBe(false);
    await expect(runtime.processNext()).rejects.toThrow(
      VerificationJobRuntimeError,
    );

    runtime.start();
    expect(runtime.isRunning()).toBe(true);
    runtime.start();
    expect(runtime.isRunning()).toBe(true);

    await harness.queue.enqueue(makeJob(sha, "t10-a"));
    expect((await runtime.processNext()).kind).toBe("completed");

    runtime.stop();
    expect(runtime.isRunning()).toBe(false);
    await expect(runtime.processNext()).rejects.toThrow(
      VerificationJobRuntimeError,
    );
    await expect(runtime.drain()).rejects.toThrow(VerificationJobRuntimeError);

    runtime.start();
    await harness.queue.enqueue(makeJob(sha, "t10-b"));
    const second = completedOf(await runtime.processNext());
    expect(await runtime.drain()).toEqual([]);
    // Both jobs share one source identity, so both results share one
    // verification identity: the latest replaces the earlier entry in place.
    expect(harness.registry.size()).toBe(1);
    expect(harness.registry.getByVerificationId(String(second.result.id))).toBe(
      second.result,
    );
  });
});
