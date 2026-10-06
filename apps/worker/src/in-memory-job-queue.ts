import {
  validateVerificationQueueJob,
  type VerificationJobQueue,
  type VerificationQueueJob,
} from "@verify-agent/domain";

export interface InMemoryVerificationJobQueue extends VerificationJobQueue {
  readonly jobs: readonly VerificationQueueJob[];
  size(): number;
  clear(): void;
  dequeue(): Promise<VerificationQueueJob | null>;
  onEnqueue(listener: () => void): () => void;
}

export function createInMemoryVerificationJobQueue(): InMemoryVerificationJobQueue {
  const entries: VerificationQueueJob[] = [];
  const listeners = new Set<() => void>();
  const freezeJob = (job: VerificationQueueJob): VerificationQueueJob =>
    Object.freeze({
      jobId: job.jobId,
      source: Object.freeze({ ...job.source }),
      trigger: Object.freeze({ ...job.trigger }),
      deliveryId: job.deliveryId,
      createdAt: job.createdAt,
      ...(job.selection === undefined ? {} : { selection: job.selection }),
    });

  return {
    async enqueue(job) {
      validateVerificationQueueJob(job);
      entries.push(freezeJob(job));
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // A wakeup listener must never fail the enqueue.
        }
      }
    },
    async dequeue() {
      return entries.shift() ?? null;
    },
    get jobs() {
      return Object.freeze([...entries]);
    },
    size: () => entries.length,
    clear: () => {
      entries.length = 0;
    },
    onEnqueue(listener) {
      if (typeof listener !== "function") {
        throw new Error("enqueue listener must be a function");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
