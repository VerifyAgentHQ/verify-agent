import type { VerificationResult } from "./verification.js";

/**
 * Batch 50 — provider-neutral read port for asynchronous result observation.
 *
 * The API depends on this abstraction, never directly on the bounded
 * in-memory registry. The existing registry satisfies this port
 * structurally: both `null` and `undefined` mean "no retained result
 * currently available" (not completed/registered yet, evicted, process
 * restarted, or unknown queue ID).
 *
 * The lookup key is always the originating `VerificationQueueJob.jobId`,
 * which exists at webhook enqueue time. It is only a correlation handle:
 * the native `VerificationResult.jobId` and `VerificationResult.id`
 * (verificationId) remain distinct identities owned by the result.
 */
export interface VerificationResultReader {
  getByQueueJobId(queueJobId: string): VerificationResult | null | undefined;
}
