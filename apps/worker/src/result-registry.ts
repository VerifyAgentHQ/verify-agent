import type { VerificationResult } from "@verify-agent/domain";
import { validateVerificationResult } from "@verify-agent/domain";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_MAX_VERIFICATION_RESULTS = 100;

export interface VerificationResultRegistry {
  /**
   * Store an immutable verification result correlated with the queue job
   * that triggered it. Returns the stored frozen value.
   *
   * The queue job identity and the result identities are kept separate:
   * `queueJobId` is a correlation index, while the verification identity
   * remains the primary key.
   */
  store(queueJobId: string, result: VerificationResult): VerificationResult;
  /** Retrieve a stored result by its verification identity. */
  getByVerificationId(id: string): VerificationResult | undefined;
  /** Retrieve a stored result by the job identity recorded on the result. */
  getByJobId(jobId: string): VerificationResult | undefined;
  /** Retrieve a stored result by the originating queue job identity. */
  getByQueueJobId(queueJobId: string): VerificationResult | undefined;
  size(): number;
  clear(): void;
}

export interface InMemoryVerificationResultRegistryOptions {
  /**
   * Maximum retained results. When exceeded, the oldest stored result is
   * evicted first (deterministic FIFO). Must be a positive integer.
   */
  readonly maxResults?: number;
}

export interface FileVerificationResultRegistryOptions extends InMemoryVerificationResultRegistryOptions {
  readonly filePath: string;
}

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

/**
 * Bounded, process-local, non-durable in-memory registry for immutable
 * verification results.
 *
 * - Stores the existing `VerificationResult` unchanged; no wrapper model.
 * - Primary key is the result's own verification identity, with secondary
 *   indexes on the native job identity recorded on the result and on the
 *   originating queue job identity supplied at store time. Queue and result
 *   identities are correlated, never conflated.
 * - The native result job identity is unique per stored result: storing a
 *   result whose native job identity already belongs to a different
 *   verification result is rejected and leaves the registry unchanged.
 * - The queue job identity is unique per stored result: storing with a queue
 *   job identity that already belongs to a different verification result is
 *   rejected and leaves the registry unchanged.
 * - Storing a result whose verification identity already exists replaces the
 *   entry in place (including its secondary mappings) without growing
 *   retention. Both uniqueness checks allow reuse by the same verification
 *   identity and are evaluated against pre-mutation state.
 * - Every store validates fully before mutating, so a rejected store cannot
 *   leave partially updated indexes.
 * - Eviction removes a result from all indexes at once; no stale lookup can
 *   return an evicted result.
 * - Lookups return the stored frozen value, so callers cannot accidentally
 *   mutate authoritative registry state.
 * - Retention is explicitly bounded; this is not persistence.
 */
export function createInMemoryVerificationResultRegistry(
  options: InMemoryVerificationResultRegistryOptions = {},
): VerificationResultRegistry {
  const maxResults = options.maxResults ?? DEFAULT_MAX_VERIFICATION_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults <= 0) {
    throw new Error("maxResults must be a positive integer");
  }
  const byVerificationId = new Map<string, VerificationResult>();
  const verificationIdByJobId = new Map<string, string>();
  const verificationIdByQueueJobId = new Map<string, string>();

  function clearSecondaryMappings(verificationId: string): void {
    for (const [jobId, mapped] of verificationIdByJobId.entries()) {
      if (mapped === verificationId) {
        verificationIdByJobId.delete(jobId);
      }
    }
    for (const [queueJobId, mapped] of verificationIdByQueueJobId.entries()) {
      if (mapped === verificationId) {
        verificationIdByQueueJobId.delete(queueJobId);
      }
    }
  }

  function evictOldest(): void {
    const oldest = byVerificationId.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    byVerificationId.delete(oldest);
    clearSecondaryMappings(oldest);
  }

  function lookup(
    index: Map<string, string>,
    key: string,
  ): VerificationResult | undefined {
    const verificationId = index.get(key);
    if (verificationId === undefined) return undefined;
    return byVerificationId.get(verificationId);
  }

  function findNativeJobConflict(
    nativeJobKey: string,
    verificationKey: string,
  ): string | undefined {
    const owner = verificationIdByJobId.get(nativeJobKey);
    return owner !== undefined && owner !== verificationKey ? owner : undefined;
  }

  function findQueueJobConflict(
    queueKey: string,
    verificationKey: string,
  ): string | undefined {
    const owner = verificationIdByQueueJobId.get(queueKey);
    return owner !== undefined && owner !== verificationKey ? owner : undefined;
  }

  return {
    store(queueJobId: string, result: VerificationResult): VerificationResult {
      const queueKey = assertQueueJobId(queueJobId);
      validateVerificationResult(result);
      const key = String(result.id);
      const nativeJobKey = String(result.jobId);

      // Preflight every conflict against pre-mutation state. No primary or
      // secondary mutation may occur before all checks pass.
      const nativeConflict = findNativeJobConflict(nativeJobKey, key);
      if (nativeConflict !== undefined) {
        throw new Error(
          `native result jobId "${nativeJobKey}" is already registered ` +
            `for verification "${nativeConflict}"`,
        );
      }
      const queueConflict = findQueueJobConflict(queueKey, key);
      if (queueConflict !== undefined) {
        throw new Error(
          `queue jobId "${queueKey}" is already registered ` +
            `for verification "${queueConflict}"`,
        );
      }

      const replacing = byVerificationId.get(key);
      const frozen = deepFreezeResult(result);
      if (replacing !== undefined) {
        clearSecondaryMappings(key);
      }
      byVerificationId.set(key, frozen);
      verificationIdByJobId.set(nativeJobKey, key);
      verificationIdByQueueJobId.set(queueKey, key);
      while (byVerificationId.size > maxResults) {
        evictOldest();
      }
      return frozen;
    },

    getByVerificationId(id: string): VerificationResult | undefined {
      return byVerificationId.get(id);
    },

    getByJobId(jobId: string): VerificationResult | undefined {
      return lookup(verificationIdByJobId, jobId);
    },

    getByQueueJobId(queueJobId: string): VerificationResult | undefined {
      return lookup(verificationIdByQueueJobId, queueJobId);
    },

    size(): number {
      return byVerificationId.size;
    },

    clear(): void {
      byVerificationId.clear();
      verificationIdByJobId.clear();
      verificationIdByQueueJobId.clear();
    },
  };
}

/** Restart-safe registry for the single-instance MVP. The file is an opaque,
 * versioned JSON envelope and is replaced atomically after every successful
 * store. The in-memory indexes remain the hot path and preserve the existing
 * registry contract. */
export function createFileVerificationResultRegistry(
  options: FileVerificationResultRegistryOptions,
): VerificationResultRegistry {
  if (
    !options ||
    typeof options.filePath !== "string" ||
    options.filePath.trim() === ""
  ) {
    throw new Error("filePath must be a non-empty string");
  }
  const memory = createInMemoryVerificationResultRegistry(options);
  type Entry = { queueJobId: string; result: VerificationResult };
  let entries: Entry[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(options.filePath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      const raw = (parsed as { version?: unknown; entries?: unknown }).entries;
      if (
        (parsed as { version?: unknown }).version === 1 &&
        Array.isArray(raw)
      ) {
        entries = raw.filter(
          (entry): entry is Entry =>
            typeof entry === "object" &&
            entry !== null &&
            typeof (entry as Entry).queueJobId === "string" &&
            typeof (entry as Entry).result === "object" &&
            (entry as Entry).result !== null,
        );
        for (const entry of entries) {
          try {
            memory.store(entry.queueJobId, entry.result);
          } catch {
            /* corrupt entries are ignored */
          }
        }
      }
    }
  } catch {
    /* first boot or an absent/corrupt store starts empty */
  }

  const persist = (): void => {
    const snapshot: Entry[] = [];
    for (const entry of entries) {
      const result = memory.getByQueueJobId(entry.queueJobId);
      if (result) snapshot.push({ queueJobId: entry.queueJobId, result });
    }
    mkdirSync(dirname(options.filePath), { recursive: true });
    const temporary = `${options.filePath}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, entries: snapshot }, null, 2),
      { mode: 0o600 },
    );
    renameSync(temporary, options.filePath);
  };

  return {
    store(queueJobId, result) {
      const stored = memory.store(queueJobId, result);
      entries = entries.filter(
        (entry) =>
          entry.queueJobId !== queueJobId &&
          String(entry.result.id) !== String(result.id),
      );
      entries.push({ queueJobId, result: stored });
      while (
        entries.length >
        (options.maxResults ?? DEFAULT_MAX_VERIFICATION_RESULTS)
      )
        entries.shift();
      persist();
      return stored;
    },
    getByVerificationId: (id) => memory.getByVerificationId(id),
    getByJobId: (id) => memory.getByJobId(id),
    getByQueueJobId: (id) => memory.getByQueueJobId(id),
    size: () => memory.size(),
    clear: () => {
      memory.clear();
      entries = [];
      persist();
    },
  };
}
