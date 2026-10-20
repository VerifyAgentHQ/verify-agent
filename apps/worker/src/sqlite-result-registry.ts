import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { VerificationResult } from "@verify-agent/domain";
import { validateVerificationResult } from "@verify-agent/domain";
import {
  DEFAULT_MAX_VERIFICATION_RESULTS,
  type InMemoryVerificationResultRegistryOptions,
  type VerificationResultRegistry,
} from "./result-registry.js";

export interface SqliteVerificationResultRegistryOptions extends InMemoryVerificationResultRegistryOptions {
  readonly filePath: string;
}

type StoredRow = { payload: string };

const DatabaseSync = process.getBuiltinModule("node:sqlite")
  .DatabaseSync as typeof DatabaseSyncType;

function deepFreezeResult(result: VerificationResult): VerificationResult {
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Object.isFrozen(value)) return;
    for (const key of Reflect.ownKeys(value as Record<PropertyKey, unknown>)) {
      freeze((value as Record<PropertyKey, unknown>)[key]);
    }
    Object.freeze(value);
  };
  freeze(result);
  return result;
}

function assertQueueJobId(queueJobId: unknown): string {
  if (typeof queueJobId !== "string" || queueJobId.trim().length === 0) {
    throw new Error("queueJobId must be a non-empty string");
  }
  return queueJobId;
}

function readResult(row: unknown): VerificationResult | undefined {
  if (
    typeof row !== "object" ||
    row === null ||
    typeof (row as StoredRow).payload !== "string"
  )
    return undefined;
  try {
    const result = JSON.parse((row as StoredRow).payload) as VerificationResult;
    validateVerificationResult(result);
    return deepFreezeResult(result);
  } catch {
    return undefined;
  }
}

/**
 * Durable single-instance result registry backed by SQLite.
 *
 * SQLite provides transactional writes, indexed identity lookups, and
 * restart persistence. The active in-process queue is still intentionally
 * not durable; this adapter guarantees result durability after a job has
 * reached the registry, not recovery of an in-flight queue item.
 */
export function createSqliteVerificationResultRegistry(
  options: SqliteVerificationResultRegistryOptions,
): VerificationResultRegistry {
  if (
    !options ||
    typeof options.filePath !== "string" ||
    options.filePath.trim().length === 0
  ) {
    throw new Error("filePath must be a non-empty string");
  }
  const maxResults = options.maxResults ?? DEFAULT_MAX_VERIFICATION_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("maxResults must be a positive integer");
  }

  mkdirSync(dirname(options.filePath), { recursive: true });
  const database = new DatabaseSync(options.filePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = FULL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS verification_results (
      queue_job_id TEXT PRIMARY KEY NOT NULL,
      verification_id TEXT UNIQUE NOT NULL,
      job_id TEXT UNIQUE NOT NULL,
      payload TEXT NOT NULL,
      stored_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS verification_results_job_id
      ON verification_results(job_id);
  `);

  const byQueueJobId = database.prepare(
    "SELECT payload FROM verification_results WHERE queue_job_id = ?",
  );
  const byVerificationId = database.prepare(
    "SELECT payload FROM verification_results WHERE verification_id = ?",
  );
  const byJobId = database.prepare(
    "SELECT payload FROM verification_results WHERE job_id = ?",
  );
  const countRows = database.prepare(
    "SELECT COUNT(*) AS count FROM verification_results",
  );
  const oldestRow = database.prepare(
    "SELECT queue_job_id FROM verification_results ORDER BY rowid ASC LIMIT 1",
  );
  const deleteQueueJob = database.prepare(
    "DELETE FROM verification_results WHERE queue_job_id = ?",
  );
  const deleteVerification = database.prepare(
    "DELETE FROM verification_results WHERE verification_id = ?",
  );
  const deleteOldest = database.prepare(
    "DELETE FROM verification_results WHERE queue_job_id = ?",
  );

  function lookup(statement: ReturnType<typeof database.prepare>, key: string) {
    return readResult(statement.get(key));
  }

  function trimRetention(): void {
    while (
      Number((countRows.get() as { count?: unknown } | undefined)?.count ?? 0) >
      maxResults
    ) {
      const oldest = oldestRow.get() as { queue_job_id?: unknown } | undefined;
      if (typeof oldest?.queue_job_id !== "string") break;
      deleteOldest.run(oldest.queue_job_id);
    }
  }

  return {
    store(queueJobId, result) {
      const queueKey = assertQueueJobId(queueJobId);
      validateVerificationResult(result);
      const verificationKey = String(result.id);
      const jobKey = String(result.jobId);
      const existingQueue = lookup(byQueueJobId, queueKey);
      const existingVerification = lookup(byVerificationId, verificationKey);
      const existingJob = lookup(byJobId, jobKey);
      if (
        existingQueue !== undefined &&
        String(existingQueue.id) !== verificationKey
      ) {
        throw new Error(`queue jobId "${queueKey}" is already registered`);
      }
      if (
        existingJob !== undefined &&
        String(existingJob.id) !== verificationKey
      ) {
        throw new Error(
          `native result jobId "${jobKey}" is already registered`,
        );
      }
      if (
        existingVerification !== undefined &&
        String(existingVerification.jobId) !== jobKey
      ) {
        throw new Error(
          `verification "${verificationKey}" has a different jobId`,
        );
      }

      const payload = JSON.stringify(result);
      database.exec("BEGIN IMMEDIATE");
      try {
        deleteQueueJob.run(queueKey);
        deleteVerification.run(verificationKey);
        database
          .prepare(
            "INSERT INTO verification_results (queue_job_id, verification_id, job_id, payload, stored_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(queueKey, verificationKey, jobKey, payload, result.createdAt);
        trimRetention();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      return deepFreezeResult(result);
    },

    getByVerificationId(id) {
      return lookup(byVerificationId, id);
    },
    getByJobId(id) {
      return lookup(byJobId, id);
    },
    getByQueueJobId(id) {
      return lookup(byQueueJobId, id);
    },
    size() {
      return Number(
        (countRows.get() as { count?: unknown } | undefined)?.count ?? 0,
      );
    },
    clear() {
      database.exec("DELETE FROM verification_results");
    },
    close() {
      database.close();
    },
  };
}
