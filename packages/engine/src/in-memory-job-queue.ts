import {
  validateVerificationQueueJob,
  type VerificationJobQueue,
  type VerificationQueueJob,
} from "@verify-agent/domain";

/**
 * Deterministic in-memory queue for development and tests only.
 *
 * - Preserves insertion order.
 * - Freezes enqueued jobs and exposes only frozen snapshots.
 * - No timers, background workers, durability, retries, or global state.
 * - Each instance owns its entries; instances never share state.
 */
export interface InMemoryVerificationJobQueue extends VerificationJobQueue {
  readonly jobs: readonly VerificationQueueJob[];
  size(): number;
  clear(): void;
}

function freezeJob(job: VerificationQueueJob): VerificationQueueJob {
  return Object.freeze({
    jobId: job.jobId,
    source: Object.freeze({ ...job.source }),
    trigger: Object.freeze({ ...job.trigger }),
    deliveryId: job.deliveryId,
    createdAt: job.createdAt,
  });
}

export function createInMemoryVerificationJobQueue(): InMemoryVerificationJobQueue {
  const entries: VerificationQueueJob[] = [];

  return {
    async enqueue(job: VerificationQueueJob): Promise<void> {
      validateVerificationQueueJob(job);
      entries.push(freezeJob(job));
    },

    get jobs(): readonly VerificationQueueJob[] {
      return Object.freeze([...entries]);
    },

    size(): number {
      return entries.length;
    },

    clear(): void {
      entries.length = 0;
    },
  };
}
