import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createVerificationQueueJob,
  validateVerificationQueueJob,
  type VerificationQueueJob,
} from "@verify-agent/domain";
import type { InMemoryVerificationJobQueue } from "./in-memory-job-queue.js";

const DatabaseSync = process.getBuiltinModule("node:sqlite")
  .DatabaseSync as typeof DatabaseSyncType;

export interface SqliteVerificationJobQueueOptions {
  readonly filePath: string;
}

type StoredRow = { payload: string };

function freezeJob(job: VerificationQueueJob): VerificationQueueJob {
  return createVerificationQueueJob({
    jobId: job.jobId,
    source: job.source,
    trigger: job.trigger,
    deliveryId: job.deliveryId,
    createdAt: job.createdAt,
    ...(job.selection === undefined ? {} : { selection: job.selection }),
  });
}

function decode(row: unknown): VerificationQueueJob | null {
  if (
    typeof row !== "object" ||
    row === null ||
    typeof (row as StoredRow).payload !== "string"
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      (row as StoredRow).payload,
    ) as VerificationQueueJob;
    validateVerificationQueueJob(parsed);
    return freezeJob(parsed);
  } catch {
    return null;
  }
}

/** Single-instance durable queue with restart recovery for unfinished jobs. */
export function createSqliteVerificationJobQueue(
  options: SqliteVerificationJobQueueOptions,
): InMemoryVerificationJobQueue {
  if (
    !options ||
    typeof options.filePath !== "string" ||
    options.filePath.trim().length === 0
  ) {
    throw new Error("filePath must be a non-empty string");
  }

  mkdirSync(dirname(options.filePath), { recursive: true });
  const database = new DatabaseSync(options.filePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS verification_queue_jobs (
      job_id TEXT PRIMARY KEY NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'processing')),
      payload TEXT NOT NULL,
      enqueued_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS verification_queue_jobs_order
      ON verification_queue_jobs(state, enqueued_at, job_id);
  `);
  database
    .prepare(
      "UPDATE verification_queue_jobs SET state = 'pending' WHERE state = 'processing'",
    )
    .run();

  const listeners = new Set<() => void>();
  const insert = database.prepare(
    "INSERT INTO verification_queue_jobs (job_id, state, payload, enqueued_at) VALUES (?, 'pending', ?, ?)",
  );
  const selectNext = database.prepare(
    "SELECT payload FROM verification_queue_jobs WHERE state = 'pending' ORDER BY enqueued_at, job_id LIMIT 1",
  );
  const markProcessing = database.prepare(
    "UPDATE verification_queue_jobs SET state = 'processing' WHERE job_id = ? AND state = 'pending'",
  );
  const acknowledge = database.prepare(
    "DELETE FROM verification_queue_jobs WHERE job_id = ? AND state = 'processing'",
  );
  const requeue = database.prepare(
    "UPDATE verification_queue_jobs SET state = 'pending' WHERE job_id = ? AND state = 'processing'",
  );
  const count = database.prepare(
    "SELECT COUNT(*) AS count FROM verification_queue_jobs",
  );
  const list = database.prepare(
    "SELECT payload FROM verification_queue_jobs ORDER BY enqueued_at, job_id",
  );

  return {
    async enqueue(job) {
      validateVerificationQueueJob(job);
      const frozen = freezeJob(job);
      insert.run(frozen.jobId, JSON.stringify(frozen), frozen.createdAt);
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch {
          // Wakeup listeners cannot fail a committed enqueue.
        }
      }
    },
    async dequeue() {
      database.exec("BEGIN IMMEDIATE");
      try {
        const job = decode(selectNext.get());
        if (job === null) {
          database.exec("COMMIT");
          return null;
        }
        markProcessing.run(job.jobId);
        database.exec("COMMIT");
        return job;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    async acknowledge(jobId) {
      acknowledge.run(jobId);
    },
    async reject(jobId) {
      requeue.run(jobId);
    },
    get jobs() {
      return Object.freeze(
        (list.all() as unknown[])
          .map(decode)
          .filter((job): job is VerificationQueueJob => job !== null),
      );
    },
    size() {
      return Number(
        (count.get() as { count?: unknown } | undefined)?.count ?? 0,
      );
    },
    clear() {
      database.exec("DELETE FROM verification_queue_jobs");
    },
    onEnqueue(listener) {
      if (typeof listener !== "function") {
        throw new Error("enqueue listener must be a function");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      database.close();
    },
  };
}
