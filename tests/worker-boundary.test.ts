import { describe, expect, it, vi } from "vitest";
import { createVerificationJobProcessor } from "../apps/worker/src/index.js";
import type { VerificationQueueJob } from "../packages/domain/src/verification-queue.js";
import type { VerificationResult } from "../packages/domain/src/verification.js";

const JOB: VerificationQueueJob = Object.freeze({
  jobId: "job-worker-1",
  source: Object.freeze({
    kind: "snapshot",
    id: "octocat:hello-world:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  }),
  trigger: Object.freeze({
    kind: "pull-request",
    action: "opened",
    pullRequestNumber: 7,
  }),
  deliveryId: "delivery-worker-1",
  createdAt: "2026-01-01T00:00:00.000Z",
});

function result(): VerificationResult {
  return {} as VerificationResult;
}

describe("worker application boundary", () => {
  it("accepts a provider-neutral job and delegates to verifySource", async () => {
    const verifySource = vi.fn(async ({ source }: { source: unknown }) => {
      expect(source).toEqual(JOB.source);
      return result();
    });
    const processor = createVerificationJobProcessor({ verifySource });

    const output = await processor.process(JOB);

    expect(output).toBeDefined();
    expect(verifySource).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed jobs before calling the service", async () => {
    const verifySource = vi.fn(async () => result());
    const processor = createVerificationJobProcessor({ verifySource });

    await expect(
      processor.process({ ...JOB, deliveryId: "" }),
    ).rejects.toThrow();
    expect(verifySource).not.toHaveBeenCalled();
  });

  it("requires an application service at composition time", () => {
    expect(() =>
      createVerificationJobProcessor({} as unknown as never),
    ).toThrow();
  });
});
