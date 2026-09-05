import { describe, expect, it } from "vitest";
import {
  createVerificationQueueJob,
  validateVerificationQueueJob,
} from "../packages/domain/src/verification-queue.js";
import { createInMemoryVerificationJobQueue } from "../packages/engine/src/in-memory-job-queue.js";

const SOURCE = {
  kind: "snapshot",
  id: "octocat:hello-world:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} as const;
const TRIGGER = {
  kind: "pull-request",
  action: "opened",
  pullRequestNumber: 7,
} as const;

function job(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-1",
    source: { ...SOURCE },
    trigger: { ...TRIGGER },
    deliveryId: "delivery-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("verification queue contract", () => {
  it("accepts a well-formed immutable job", () => {
    expect(() => validateVerificationQueueJob(job())).not.toThrow();
    const created = createVerificationQueueJob(job());
    expect(created.jobId).toBe("job-1");
    expect(Object.isFrozen(created)).toBe(true);
  });

  it("rejects branch-like or mutable source identities", () => {
    expect(() =>
      validateVerificationQueueJob(
        job({ source: { kind: "snapshot", id: "" } }),
      ),
    ).toThrow();
    expect(() =>
      validateVerificationQueueJob(job({ source: { kind: "repo", id: "x" } })),
    ).toThrow();
  });

  it("rejects malformed triggers, delivery IDs, and timestamps", () => {
    expect(() =>
      validateVerificationQueueJob(job({ deliveryId: "   " })),
    ).toThrow();
    expect(() =>
      validateVerificationQueueJob(job({ createdAt: "not-a-date" })),
    ).toThrow();
    expect(() =>
      validateVerificationQueueJob(
        job({
          trigger: { kind: "pull-request", action: "", pullRequestNumber: 7 },
        }),
      ),
    ).toThrow();
    expect(() =>
      validateVerificationQueueJob(
        job({ trigger: { kind: "push", action: "x", pullRequestNumber: 1 } }),
      ),
    ).toThrow();
  });
});

describe("in-memory verification job queue", () => {
  it("enqueue preserves the job", async () => {
    const queue = createInMemoryVerificationJobQueue();
    const input = job({ jobId: "job-preserve" });
    await queue.enqueue(input as never);
    expect(queue.size()).toBe(1);
    expect(queue.jobs[0]).toMatchObject({
      jobId: "job-preserve",
      deliveryId: "delivery-1",
      source: SOURCE,
    });
  });

  it("preserves insertion order deterministically", async () => {
    const queue = createInMemoryVerificationJobQueue();
    for (const id of ["job-a", "job-b", "job-c"]) {
      await queue.enqueue(
        job({ jobId: id, deliveryId: `delivery-${id}` }) as never,
      );
    }
    expect(queue.jobs.map((entry) => entry.jobId)).toEqual([
      "job-a",
      "job-b",
      "job-c",
    ]);
  });

  it("does not silently mutate enqueued jobs", async () => {
    const queue = createInMemoryVerificationJobQueue();
    const input = job({ jobId: "job-frozen" });
    await queue.enqueue(input as never);
    const stored = queue.jobs[0];
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.source)).toBe(true);
    expect(Object.isFrozen(stored.trigger)).toBe(true);
    (input as Record<string, unknown>).jobId = "mutated-after-enqueue";
    expect(queue.jobs[0].jobId).toBe("job-frozen");
  });

  it("keeps multiple jobs independently represented", async () => {
    const queue = createInMemoryVerificationJobQueue();
    await queue.enqueue(job({ jobId: "job-1", deliveryId: "d-1" }) as never);
    await queue.enqueue(
      job({
        jobId: "job-2",
        deliveryId: "d-2",
        source: {
          kind: "snapshot",
          id: "octocat:other:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      }) as never,
    );
    expect(queue.size()).toBe(2);
    expect(queue.jobs[0].source.id).toContain("hello-world");
    expect(queue.jobs[1].source.id).toContain("other");
  });

  it("uses per-instance state without globals", async () => {
    const first = createInMemoryVerificationJobQueue();
    const second = createInMemoryVerificationJobQueue();
    await first.enqueue(job({ jobId: "job-only-first" }) as never);
    expect(first.size()).toBe(1);
    expect(second.size()).toBe(0);
  });
});
