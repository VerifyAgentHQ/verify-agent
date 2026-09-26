import type {
  VerificationQueueJob,
  VerificationResult,
} from "@verify-agent/domain";
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
 *
 * Batch 51 — queues MAY expose an optional synchronous wakeup
 * notification (`onEnqueue`) invoked after each successful enqueue.
 * When present the runtime consumes without polling or timers; when
 * absent the automatic loop falls back to a single bounded,
 * stoppable delay between idle checks (no busy-spin).
 */
export interface ConsumableVerificationJobQueue {
  enqueue(job: VerificationQueueJob): Promise<void>;
  dequeue(): Promise<VerificationQueueJob | null>;
  onEnqueue?(listener: () => void): () => void;
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

export type VerificationJobSettledOutcome = Extract<
  VerificationJobRuntimeOutcome,
  { kind: "completed" } | { kind: "failed" }
>;

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
  /**
   * Batch 51 — begin automatic in-process consumption.
   *
   * Idempotent while active. Ensures the runtime is marked running and
   * starts a single sequential background loop that consumes queued jobs
   * through the existing `processNext()` path (no second execution
   * path). Ownership is generation-aware: each start from a stopped
   * state mints a new generation, so stopping one generation can never
   * revive or await a newer one. Processing is additionally serialized
   * across generations, so at most one verification operation is ever
   * active even when a new generation starts while an old in-flight
   * operation is still awaiting. When the queue exposes `onEnqueue` the
   * loop wakes event-driven with no timers; otherwise it waits on a
   * single bounded stoppable delay (no busy-spin). A failing job yields
   * a `failed` outcome, registers nothing, and never stops the loop; no
   * retries are attempted.
   */
  startAutoProcessing(): void;
  /**
   * Batch 51 — stop automatic consumption and wait for the loop to exit.
   *
   * Idempotent. Captures the generation being stopped and awaits exactly
   * that generation's loop, so a concurrent start (a newer generation)
   * is neither awaited nor revived. After it resolves the stopped
   * generation's loop is definitely finished; when no newer generation
   * started meanwhile, no wakeup listener remains attached. A job
   * already in `processNext()` finishes according to existing semantics
   * before the loop exits. Queued jobs remain queued.
   */
  stopAutoProcessing(): Promise<void>;
  /** Batch 51 — whether automatic consumption is currently active. */
  isAutoProcessing(): boolean;
  /**
   * Batch 51 — deterministic completion wait without invoking processing.
   *
   * Resolves with the `completed` or `failed` outcome for the given
   * originating queue job ID. If the job already settled (including a
   * prior failure remembered by the runtime, or a completed result still
   * retained in the registry) it resolves immediately. Otherwise it
   * resolves when the automatic loop settles that job. Rejects on timeout
   * (default 10s). Never triggers verification itself and never logs
   * secrets or credentials.
   */
  waitForQueueJob(
    queueJobId: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<VerificationJobSettledOutcome>;
  /**
   * Batch 51 — subscribe to settled (`completed`/`failed`) outcomes in
   * order. Returns an unsubscribe function. Listener errors are isolated.
   */
  onSettled(
    listener: (outcome: VerificationJobSettledOutcome) => void,
  ): () => void;
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
 *
 * Batch 51 adds opt-in automatic consumption (`startAutoProcessing()`):
 * a single sequential loop over the same `processNext()` path, woken
 * event-driven via `queue.onEnqueue` when available. Explicit consumption
 * semantics are unchanged when automatic mode is not started.
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
  // Generation-aware automatic-processing lifecycle. Each successful
  // `startAutoProcessing()` from a stopped state mints a new generation
  // that owns its loop; stopping invalidates the current generation so a
  // concurrent start can never revive the generation being stopped. The
  // stopped generation's loop is awaited directly (never via shared
  // mutable state that a new start could replace).
  let generationCounter = 0;
  let activeGeneration = 0;
  let activeLoop: { generation: number; promise: Promise<void> } | null = null;
  // Generation-safe processing serialization. At most one verification
  // operation (dequeue + processor + store) is active across ALL
  // generations: a new generation's loop cannot begin processing while a
  // previous generation's in-flight operation still holds the slot.
  // Released in a finally so failures can never wedge the chain.
  let processingSlot: Promise<void> = Promise.resolve();
  let unsubscribeQueue: (() => void) | null = null;
  let wakeupResolve: (() => void) | null = null;
  let wakeupNotified = false;
  const settledListeners = new Set<
    (outcome: VerificationJobSettledOutcome) => void
  >();
  const waiters = new Map<
    string,
    Set<{
      resolve: (outcome: VerificationJobSettledOutcome) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | null;
    }>
  >();
  const recentSettled = new Map<string, VerificationJobSettledOutcome>();
  const MAX_RECENT_SETTLED = 200;

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

  function rememberSettled(outcome: VerificationJobSettledOutcome): void {
    recentSettled.set(outcome.job.jobId, outcome);
    while (recentSettled.size > MAX_RECENT_SETTLED) {
      const oldest = recentSettled.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      recentSettled.delete(oldest);
    }
    for (const listener of [...settledListeners]) {
      try {
        listener(outcome);
      } catch {
        // Isolated: a listener must never break the runtime.
      }
    }
    const pending = waiters.get(outcome.job.jobId);
    if (pending !== undefined) {
      waiters.delete(outcome.job.jobId);
      for (const waiter of [...pending]) {
        if (waiter.timer !== null) clearTimeout(waiter.timer);
        try {
          waiter.resolve(outcome);
        } catch {
          // Ignore waiter resolve errors.
        }
      }
    }
  }

  function signalWakeup(): void {
    if (wakeupResolve !== null) {
      const resolve = wakeupResolve;
      wakeupResolve = null;
      wakeupNotified = false;
      resolve();
    } else {
      wakeupNotified = true;
    }
  }

  function waitForWakeup(): Promise<void> {
    if (wakeupNotified) {
      wakeupNotified = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      wakeupResolve = resolve;
    });
  }

  function fallbackDelay(): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (wakeupResolve !== null) {
          wakeupResolve = null;
          wakeupNotified = false;
        }
        resolve();
      }, 10);
      // A stop request resolves the wait immediately instead of waiting
      // for the delay: chain the wakeup resolver without losing the timer.
      const previousResolve = wakeupResolve;
      void previousResolve;
      wakeupResolve = () => {
        clearTimeout(timer);
        wakeupResolve = null;
        wakeupNotified = false;
        resolve();
      };
    });
  }

  /**
   * Automatic-loop consumption serialized across generations. Chains
   * behind the shared slot, then re-validates ownership before touching
   * the queue: a generation invalidated while waiting returns null
   * instead of consuming. Returns the `processNext()` outcome for a
   * still-valid generation.
   */
  async function runAutomaticNext(
    generation: number,
  ): Promise<VerificationJobRuntimeOutcome | null> {
    const previous = processingSlot;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    processingSlot = slot;
    await previous;
    try {
      if (activeGeneration !== generation || !running) return null;
      return await processNext();
    } finally {
      release();
    }
  }

  async function runLoop(generation: number): Promise<void> {
    for (;;) {
      if (activeGeneration !== generation || !running) return;
      let outcome: VerificationJobRuntimeOutcome;
      try {
        const next = await runAutomaticNext(generation);
        // Invalidated while queued for the processing slot: exit without
        // consuming so a stopped generation never processes post-stop.
        if (next === null) return;
        outcome = next;
      } catch {
        // processNext throws only for lifecycle misuse (stopped) or a
        // registry store failure. A stopped or superseded generation
        // exits; any other throw leaves the loop usable for subsequent
        // jobs of the same generation.
        if (activeGeneration !== generation || !running) return;
        continue;
      }
      if (outcome.kind === "idle") {
        if (activeGeneration !== generation || !running) return;
        if (unsubscribeQueue !== null) {
          await waitForWakeup();
        } else {
          await fallbackDelay();
        }
        continue;
      }
      rememberSettled(outcome);
    }
  }

  function detachQueueListener(): void {
    if (unsubscribeQueue !== null) {
      try {
        unsubscribeQueue();
      } catch {
        // Ignore unsubscribe errors during shutdown.
      }
      unsubscribeQueue = null;
    }
  }

  function startAutoProcessing(): void {
    running = true;
    // Idempotent while a generation is active; a stop must happen first.
    if (activeGeneration !== 0) return;
    generationCounter += 1;
    const generation = generationCounter;
    activeGeneration = generation;
    wakeupNotified = false;
    // One shared wakeup subscription reused across generations; never
    // double-subscribed.
    if (unsubscribeQueue === null && typeof queue.onEnqueue === "function") {
      try {
        unsubscribeQueue = queue.onEnqueue(signalWakeup);
      } catch {
        unsubscribeQueue = null;
      }
    }
    const promise = runLoop(generation).finally(() => {
      if (activeLoop?.generation === generation) {
        activeLoop = null;
      }
    });
    // An uncaught loop error must never become an unhandled rejection:
    // runLoop already guards its body, but guard the join as well.
    promise.catch(() => {});
    activeLoop = { generation, promise };
  }

  async function stopAutoProcessing(): Promise<void> {
    // Capture the exact generation being stopped. A concurrent start
    // mints a NEW generation with its own loop; awaiting the captured
    // loop can therefore never await or revive the new generation.
    const stopped = activeLoop;
    activeGeneration = 0;
    signalWakeup();
    if (stopped !== null) {
      await stopped.promise;
    }
    // Detach the shared wakeup listener only when no newer generation
    // started while this stop was awaiting the old loop.
    if (activeGeneration === 0) {
      detachQueueListener();
      wakeupResolve = null;
      wakeupNotified = false;
    }
  }

  return {
    start(): void {
      running = true;
    },
    stop(): void {
      running = false;
      activeGeneration = 0;
      signalWakeup();
      // Synchronous stop cannot await the exiting loop, but it must leave
      // no listener behind for the invalidated generation. A newer
      // generation started after this stop resubscribes on demand.
      detachQueueListener();
      wakeupResolve = null;
      wakeupNotified = false;
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
    startAutoProcessing,
    stopAutoProcessing,
    isAutoProcessing(): boolean {
      return activeGeneration !== 0;
    },
    waitForQueueJob(
      queueJobId: string,
      options?: { readonly timeoutMs?: number },
    ): Promise<VerificationJobSettledOutcome> {
      if (typeof queueJobId !== "string" || queueJobId.length === 0) {
        return Promise.reject(
          new VerificationJobRuntimeError("queueJobId must be provided"),
        );
      }
      const key = queueJobId;
      const remembered = recentSettled.get(key);
      if (remembered !== undefined) return Promise.resolve(remembered);
      const timeoutMs = options?.timeoutMs ?? 10_000;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return Promise.reject(
          new VerificationJobRuntimeError("timeoutMs must be positive"),
        );
      }
      return new Promise<VerificationJobSettledOutcome>((resolve, reject) => {
        // Re-check in case the outcome settled between the first check
        // and waiter registration.
        const late = recentSettled.get(key);
        if (late !== undefined) {
          resolve(late);
          return;
        }
        const entry: {
          resolve: (outcome: VerificationJobSettledOutcome) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        } = {
          resolve: (outcome) => {
            clearTimeout(entry.timer);
            resolve(outcome);
          },
          reject: (error) => {
            reject(error);
          },
          timer: setTimeout(() => {
            const pending = waiters.get(key);
            if (pending !== undefined) {
              pending.delete(entry);
              if (pending.size === 0) waiters.delete(key);
            }
            reject(
              new VerificationJobRuntimeError(
                `timed out waiting for queue job ${key}`,
              ),
            );
          }, timeoutMs),
        };
        const existing = waiters.get(key);
        if (existing !== undefined) {
          existing.add(entry);
        } else {
          waiters.set(key, new Set([entry]));
        }
      });
    },
    onSettled(
      listener: (outcome: VerificationJobSettledOutcome) => void,
    ): () => void {
      if (typeof listener !== "function") {
        throw new VerificationJobRuntimeError(
          "a settled-outcome listener is required",
        );
      }
      settledListeners.add(listener);
      return () => {
        settledListeners.delete(listener);
      };
    },
  };
}
