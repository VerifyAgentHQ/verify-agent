import type { SnapshotSourceReference } from "./source-resolution.js";
import { DomainValidationError } from "./validation.js";

export type VerificationQueueTrigger = {
  readonly kind: "pull-request";
  readonly action: string;
  readonly pullRequestNumber: number;
};

/**
 * Batch 53 — provider-neutral check-selection intent for a queue job.
 *
 * - `"default"` preserves the historical generic pipeline fallback (a single
 *   default check) and is equivalent to omitting `selection`.
 * - `"all-applicable"` requests every planner-applicable check that has a
 *   trusted executable specification, in deterministic planner order.
 *
 * The job carries only intent. Project applicability stays authoritative in
 * detection → planner; the queue never names concrete checks.
 */
export type VerificationCheckSelection = "default" | "all-applicable";

export function isVerificationCheckSelection(
  value: unknown,
): value is VerificationCheckSelection {
  return value === "default" || value === "all-applicable";
}

export interface VerificationQueueJob {
  readonly jobId: string;
  readonly source: SnapshotSourceReference;
  readonly trigger: VerificationQueueTrigger;
  readonly deliveryId: string;
  readonly createdAt: string;
  /**
   * Optional selection intent. Absent means `"default"` for backwards
   * compatibility with jobs enqueued before Batch 53.
   */
  readonly selection?: VerificationCheckSelection;
}

export interface VerificationJobQueue {
  enqueue(job: VerificationQueueJob): Promise<void>;
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/**
 * Batch 50 — single domain-level queue-job ID contract.
 *
 * The queue-job ID has no domain maximum length: any non-empty string
 * matching `IDENTIFIER_RE` is valid. HTTP and queue boundaries must reuse
 * this validator instead of inventing a second maximum.
 */
export const VERIFICATION_QUEUE_JOB_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function isValidVerificationQueueJobId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    VERIFICATION_QUEUE_JOB_ID_PATTERN.test(value)
  );
}
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function fail(message: string): never {
  throw new DomainValidationError(message);
}

function assertIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${name} must be a non-empty string`);
  }
  const text = value as string;
  if (!IDENTIFIER_RE.test(text)) {
    fail(`${name} is not a valid identifier`);
  }
  return text;
}

function assertIsoDate(value: unknown, name: string): string {
  if (typeof value !== "string") {
    fail(`${name} must be an ISO date-time with timezone`);
  }
  const text = value as string;
  if (!ISO_DATE_RE.test(text) || Number.isNaN(Date.parse(text))) {
    fail(`${name} must be an ISO date-time with timezone`);
  }
  return text;
}

export function validateVerificationQueueJob(
  job: unknown,
): asserts job is VerificationQueueJob {
  if (typeof job !== "object" || job === null || Array.isArray(job)) {
    fail("verification queue job must be an object");
  }
  const record = job as Record<string, unknown>;

  assertIdentifier(record.jobId, "jobId");

  const source = record.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    fail("job source must be an object");
  }
  const sourceRecord = source as Record<string, unknown>;
  if (sourceRecord.kind !== "snapshot") {
    fail("job source kind must be snapshot");
  }
  if (
    typeof sourceRecord.id !== "string" ||
    (sourceRecord.id as string).trim().length === 0
  ) {
    fail("job source id must be a non-empty string");
  }

  const trigger = record.trigger;
  if (
    typeof trigger !== "object" ||
    trigger === null ||
    Array.isArray(trigger)
  ) {
    fail("job trigger must be an object");
  }
  const triggerRecord = trigger as Record<string, unknown>;
  if (triggerRecord.kind !== "pull-request") {
    fail("job trigger kind must be pull-request");
  }
  if (
    typeof triggerRecord.action !== "string" ||
    (triggerRecord.action as string).trim().length === 0
  ) {
    fail("job trigger action must be a non-empty string");
  }
  const pullRequestNumber = triggerRecord.pullRequestNumber;
  if (
    typeof pullRequestNumber !== "number" ||
    !Number.isInteger(pullRequestNumber) ||
    pullRequestNumber <= 0
  ) {
    fail("job trigger pullRequestNumber must be a positive integer");
  }

  if (
    typeof record.deliveryId !== "string" ||
    (record.deliveryId as string).trim().length === 0
  ) {
    fail("deliveryId must be a non-empty string");
  }

  assertIsoDate(record.createdAt, "createdAt");

  if (
    record.selection !== undefined &&
    !isVerificationCheckSelection(record.selection)
  ) {
    fail("job selection must be default or all-applicable");
  }
}

export function createVerificationQueueJob(input: {
  readonly jobId: string;
  readonly source: SnapshotSourceReference;
  readonly trigger: VerificationQueueTrigger;
  readonly deliveryId: string;
  readonly createdAt: string;
  readonly selection?: VerificationCheckSelection;
}): VerificationQueueJob {
  validateVerificationQueueJob(input as unknown);
  return Object.freeze({
    jobId: input.jobId,
    source: Object.freeze({ ...input.source }),
    trigger: Object.freeze({ ...input.trigger }),
    deliveryId: input.deliveryId,
    createdAt: input.createdAt,
    ...(input.selection === undefined ? {} : { selection: input.selection }),
  });
}
