import type { VerificationQueueJob } from "../../../packages/domain/src/verification-queue.js";
import type { VerificationResult } from "../../../packages/domain/src/verification.js";
import type { VerificationJobProcessor } from "./index.js";
import type { VerificationResultRegistry } from "./result-registry.js";

export class VerificationJobRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationJobRuntimeError";
  }
}

/**
 * Minimal application-level queue consumer surface for the job runtime.
 * Satisfied structurally by the existing in-memory queue; no queue
 * internals (arrays, snapshots, sizes) are visible here.
 */
export interface ConsumableVerificationJobQueue {
  enqueue(job: VerificationQueueJob): Promise<void>;
  dequeue(): Promise<VerificationQueueJob | null>;
}

export type VerificationJobRuntimeOutcome =
  | { readonly kind: "idle" }
  | {
      readonly kind: "completed";
      readonly job: VerificationQueueJob;
      readonly result: VerificationResult;
    }
  | {
      readonly kind: "failed";
      readonly job: VerificationQueueJob;
      readonly error: unknown;
    };

export interface VerificationJobRuntime {
  /** Mark the runtime as running. Idempotent. */
  start(): void;
  /** Mark the runtime as stopped. Queued jobs remain queued. Idempotent. */
  stop(): void;
  isRunning(): boolean;
  /**
   * Consume at most one queued job through the worker processor.
   *
   * Successful results are registered in the result registry together with
   * the originating queue job identity before the outcome is returned.
   * Failures register nothing and are reported on the outcome; the original
   * error is preserved, never swallowed, and the runtime stays usable.
   */
  processNext(): Promise<VerificationJobRuntimeOutcome>;
  /** Consume jobs until the queue is empty. Returns every outcome in order. */
  drain(): Promise<readonly VerificationJobRuntimeOutcome[]>;
}

export interface VerificationJobRuntimeOptions {
  readonly queue: ConsumableVerificationJobQueue;
  readonly processor: VerificationJobProcessor;
  readonly registry: VerificationResultRegistry;
}

/**
 * In-process application runtime owning queued-job consumption.
 *
 * The runtime orchestrates only: take a job from the queue, process it
 * through the existing worker boundary, and register the successful result
 * correlated with the originating queue job identity in the bounded
 * in-memory registry. It knows nothing about ecosystems,
 * sandbox execution, evidence, or policy — those remain behind
 * `VerificationApplicationService.verifySource()`.
 *
 * Consumption is explicit and deterministic (`processNext()` / `drain()`).
 * There is no background polling, no timers, no durability, and no retries:
 * a failed job is reported on its outcome and the runtime moves on.
 */
export function createVerificationJobRuntime(
  options: VerificationJobRuntimeOptions,
): VerificationJobRuntime {
  const queue = options?.queue;
  const processor = options?.processor;
  const registry = options?.registry;
  if (!queue || typeof queue.enqueue !== "function") {
    throw new VerificationJobRuntimeError(
      "a consumable VerificationJobQueue is required",
    );
  }
  if (!queue || typeof queue.dequeue !== "function") {
    throw new VerificationJobRuntimeError(
      "the VerificationJobQueue must support dequeue",
    );
  }
  if (!processor || typeof processor.process !== "function") {
    throw new VerificationJobRuntimeError(
      "a VerificationJobProcessor is required",
    );
  }
  if (
    !registry ||
    typeof registry.store !== "function" ||
    typeof registry.getByVerificationId !== "function"
  ) {
    throw new VerificationJobRuntimeError(
      "a VerificationResultRegistry is required",
    );
  }

  let running = false;

  function requireRunning(): void {
    if (!running) {
      throw new VerificationJobRuntimeError(
        "verification job runtime is not running",
      );
    }
  }

  async function processNext(): Promise<VerificationJobRuntimeOutcome> {
    requireRunning();
    const job = await queue.dequeue();
    if (job === null) {
      return { kind: "idle" };
    }
    let result: VerificationResult;
    try {
      result = await processor.process(job);
    } catch (error) {
      return { kind: "failed", job, error };
    }
    const stored = registry.store(job.jobId, result);
    return { kind: "completed", job, result: stored };
  }

  return {
    start(): void {
      running = true;
    },
    stop(): void {
      running = false;
    },
    isRunning(): boolean {
      return running;
    },
    processNext,
    async drain(): Promise<readonly VerificationJobRuntimeOutcome[]> {
      requireRunning();
      const outcomes: VerificationJobRuntimeOutcome[] = [];
      for (;;) {
        const outcome = await processNext();
        if (outcome.kind === "idle") return Object.freeze(outcomes);
        outcomes.push(outcome);
      }
    },
  };
}
