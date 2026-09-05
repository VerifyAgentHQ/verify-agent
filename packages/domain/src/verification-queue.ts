import type { SnapshotSourceReference } from "./source-resolution.js";
import { DomainValidationError } from "./validation.js";

export type VerificationQueueTrigger = {
  readonly kind: "pull-request";
  readonly action: string;
  readonly pullRequestNumber: number;
};

export interface VerificationQueueJob {
  readonly jobId: string;
  readonly source: SnapshotSourceReference;
  readonly trigger: VerificationQueueTrigger;
  readonly deliveryId: string;
  readonly createdAt: string;
}

export interface VerificationJobQueue {
  enqueue(job: VerificationQueueJob): Promise<void>;
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
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
}

export function createVerificationQueueJob(input: {
  readonly jobId: string;
  readonly source: SnapshotSourceReference;
  readonly trigger: VerificationQueueTrigger;
  readonly deliveryId: string;
  readonly createdAt: string;
}): VerificationQueueJob {
  validateVerificationQueueJob(input as unknown);
  return Object.freeze({
    jobId: input.jobId,
    source: Object.freeze({ ...input.source }),
    trigger: Object.freeze({ ...input.trigger }),
    deliveryId: input.deliveryId,
    createdAt: input.createdAt,
  });
}
