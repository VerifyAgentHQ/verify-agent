import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  InvalidSourceReferenceError,
  normalizePath,
  type ResolvedSource,
  type SnapshotSourceReference,
  type SourceResolver,
} from "@verify-agent/domain";
import { decodeGitHubSnapshotReference } from "./github.js";

/**
 * Batch 54 — SHA-keyed snapshot-store publication.
 *
 * Decorates an existing `SourceResolver` without creating a second source
 * architecture:
 *
 * ```text
 * SourceResolver (e.g. GitHub SourceResolver)
 *     ↓ ResolvedSource{ snapshot, sourceContents }
 * SnapshotStorePublisher
 *     ↓ publishes sourceContents to <root>/<exact-commit-SHA>
 * ResolvedSource (original snapshot, unchanged)
 * ```
 *
 * The external verify-sandbox resolves the pipeline's
 * `snapshot.sourceState.value` as a directory beneath its configured
 * `VERIFY_SANDBOX_SNAPSHOT_ROOT`. Publication closes that gap: the exact
 * bytes the resolver authenticated are published under the exact commit SHA
 * before verification runs, preserving the invariant
 *
 * ```text
 * PR HEAD SHA == resolved commit == sourceState.value
 *          == published store identity == materialized source
 * ```
 *
 * The publisher never installs dependencies, never clones repositories,
 * never invokes git, and never spawns processes: it writes already-acquired
 * bytes to the operator-configured store root.
 */

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
// Mirrors the external sandbox `source_for` acceptance set so a published
// identity is always materializable: non-empty, <=256 chars, no separators.
const SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_TOTAL_BYTES = 5_000_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

export class SnapshotStorePublicationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SnapshotStorePublicationError";
    if (options?.cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = options.cause;
    }
  }
}

export interface SnapshotStorePublisherOptions {
  /** Trusted operator-configured store root. Must be an absolute path. */
  readonly snapshotStoreRoot: string;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
}

/**
 * Reads the trusted snapshot-store root from the process environment.
 * Returns `undefined` when unconfigured so composition can preserve the
 * historical resolver behavior without publication.
 */
export function readSnapshotStoreRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.VERIFY_SANDBOX_SNAPSHOT_ROOT;
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return raw.trim();
}

/**
 * Derives the snapshot-store directory identity for a resolved source and
 * binds it to the requested immutable reference.
 *
 * - `snapshot.sourceState.value` is the sandbox identity and must always be
 *   sandbox-safe (charset/length, no traversal).
 * - When the requested source decodes as a GitHub `owner:repository:sha`
 *   reference, the identity must additionally be the exact requested commit
 *   SHA (lowercase 40-hex), and a present `commitSha` must agree with it.
 *   Anything else fails closed as an invalid source reference, so a result
 *   for commit A can never be produced from commit B's bytes.
 */
export function deriveSnapshotStoreIdentity(
  snapshot: ResolvedSource["snapshot"],
  requested: SnapshotSourceReference,
): string {
  const value = snapshot?.sourceState?.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidSourceReferenceError(
      "resolved snapshot has no source state identity",
    );
  }
  if (
    !SNAPSHOT_ID_RE.test(value) ||
    value === "." ||
    value === ".." ||
    value.includes(sep) ||
    value.includes("/")
  ) {
    throw new InvalidSourceReferenceError(
      "resolved snapshot identity is not sandbox-safe",
    );
  }
  let github: { sha: string } | undefined;
  try {
    github = decodeGitHubSnapshotReference(requested.id);
  } catch {
    github = undefined;
  }
  if (github === undefined) return value;
  const lowered = value.toLowerCase();
  if (!COMMIT_SHA_RE.test(lowered)) {
    throw new InvalidSourceReferenceError(
      "GitHub snapshot identity must be the exact commit SHA",
    );
  }
  if (lowered !== github.sha) {
    throw new InvalidSourceReferenceError(
      "resolved commit does not match the requested commit",
    );
  }
  if (
    snapshot.commitSha !== undefined &&
    snapshot.commitSha.toLowerCase() !== lowered
  ) {
    throw new InvalidSourceReferenceError(
      "resolved commitSha does not match the snapshot identity",
    );
  }
  return lowered;
}

function assertContentPath(path: string): void {
  if (typeof path !== "string" || path.length === 0) {
    throw new InvalidSourceReferenceError("source content path is empty");
  }
  let normalized: string;
  try {
    normalized = normalizePath(path);
  } catch (error) {
    throw new InvalidSourceReferenceError(`unsafe source content path`, {
      cause: error,
    });
  }
  // normalizePath tolerates backslashes by converting them; the acquisition
  // boundary rejects them, and so does publication.
  if (
    normalized !== path ||
    path.startsWith("/") ||
    path.includes("..") ||
    path.includes("\\") ||
    path.includes("//") ||
    path.endsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === ".")
  ) {
    throw new InvalidSourceReferenceError(`unsafe source content path`);
  }
}

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

interface ValidatedEntry {
  readonly path: string;
  readonly text: string;
  readonly bytes: number;
}

function validateContents(
  contents: ResolvedSource["sourceContents"],
  limits: { maxFiles: number; maxTotalBytes: number; maxFileBytes: number },
): readonly ValidatedEntry[] {
  const entries = Object.entries(contents ?? {});
  if (entries.length > limits.maxFiles) {
    throw new SnapshotStorePublicationError(
      `snapshot file limit exceeded: ${entries.length} > ${limits.maxFiles}`,
    );
  }
  let totalBytes = 0;
  const validated = entries.map(([path, text]) => {
    assertContentPath(path);
    if (typeof text !== "string") {
      throw new InvalidSourceReferenceError(`source content must be text`);
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > limits.maxFileBytes) {
      throw new SnapshotStorePublicationError(
        `snapshot file too large (${bytes} > ${limits.maxFileBytes})`,
      );
    }
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new SnapshotStorePublicationError(
        `snapshot total bytes exceeded (${totalBytes} > ${limits.maxTotalBytes})`,
      );
    }
    return { path, text, bytes };
  });
  return [...validated].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}

/**
 * Reads an existing store directory without following symlinks. Returns
 * `undefined` when the directory is absent, not a directory, or contains
 * any non-regular entry (symlink, socket, ...): such trees are never treated
 * as compatible.
 */
async function readPublishedTree(
  destination: string,
): Promise<Map<string, Buffer> | undefined> {
  try {
    const status = await fs.lstat(destination);
    if (!status.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const files = new Map<string, Buffer>();
  async function walk(directory: string, prefix: string): Promise<boolean> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!(await walk(full, relativePath))) return false;
      } else if (entry.isFile()) {
        try {
          files.set(relativePath, await fs.readFile(full));
        } catch {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  }
  return (await walk(destination, "")) ? files : undefined;
}

function treesEqual(
  published: Map<string, Buffer>,
  expected: readonly ValidatedEntry[],
): boolean {
  if (published.size !== expected.length) return false;
  for (const entry of expected) {
    const actual = published.get(entry.path);
    if (actual === undefined) return false;
    if (sha256Hex(actual) !== sha256Hex(Buffer.from(entry.text, "utf8"))) {
      return false;
    }
  }
  return true;
}

function isExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    ((error as { code?: unknown }).code === "EEXIST" ||
      (error as { code?: unknown }).code === "EPERM" ||
      (error as { code?: unknown }).code === "ENOTEMPTY" ||
      (error as { code?: unknown }).code === "EISDIR")
  );
}

export function createSnapshotStorePublisher(
  inner: SourceResolver,
  options: SnapshotStorePublisherOptions,
): SourceResolver {
  if (!inner || typeof inner.resolveSnapshot !== "function") {
    throw new SnapshotStorePublicationError(
      "an inner SourceResolver is required",
    );
  }
  const root = options?.snapshotStoreRoot;
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) {
    throw new SnapshotStorePublicationError(
      "snapshot store root must be a non-empty path",
    );
  }
  if (!isAbsolute(root)) {
    throw new SnapshotStorePublicationError(
      "snapshot store root must be an absolute path",
    );
  }
  const limits = {
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  };
  if (
    !Number.isSafeInteger(limits.maxFiles) ||
    limits.maxFiles < 1 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes < 1 ||
    !Number.isSafeInteger(limits.maxFileBytes) ||
    limits.maxFileBytes < 1
  ) {
    throw new SnapshotStorePublicationError(
      "snapshot store publication limits are invalid",
    );
  }

  async function publish(
    identity: string,
    entries: readonly ValidatedEntry[],
  ): Promise<void> {
    await fs.mkdir(root, { recursive: true, mode: 0o755 });
    const destination = join(root, identity);
    if (relative(root, destination).startsWith("..")) {
      throw new SnapshotStorePublicationError(
        "snapshot store identity escapes the store root",
      );
    }
    const existing = await readPublishedTree(destination);
    if (existing !== undefined) {
      if (!treesEqual(existing, entries)) {
        throw new SnapshotStorePublicationError(
          `snapshot store already holds different contents for ${identity}`,
        );
      }
      return;
    }
    // Stage under an unpredictable name, then atomically rename: readers
    // (verify-sandbox) never observe a partially published snapshot.
    const staging = join(root, `.staging-${identity}-${randomUUID()}`);
    await fs.mkdir(staging, { mode: 0o755 });
    try {
      for (const entry of entries) {
        const file = join(staging, ...entry.path.split("/"));
        await fs.mkdir(dirname(file), { recursive: true, mode: 0o755 });
        await fs.writeFile(file, entry.text, {
          encoding: "utf8",
          mode: 0o644,
          flag: "wx",
        });
      }
      await fs.rename(staging, destination);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (isExistsError(error)) {
        // Lost a concurrent-publication race: accept only byte-identical
        // content, never overwrite.
        const raced = await readPublishedTree(destination);
        if (raced !== undefined && treesEqual(raced, entries)) return;
        throw new SnapshotStorePublicationError(
          `snapshot store already holds different contents for ${identity}`,
          { cause: error },
        );
      }
      throw error instanceof SnapshotStorePublicationError ||
        error instanceof InvalidSourceReferenceError
        ? error
        : new SnapshotStorePublicationError("snapshot publication failed", {
            cause: error,
          });
    }
  }

  return {
    async resolveSnapshot(
      source: SnapshotSourceReference,
    ): Promise<ResolvedSource> {
      const resolved = await inner.resolveSnapshot(source);
      const identity = deriveSnapshotStoreIdentity(resolved.snapshot, source);
      const entries = validateContents(resolved.sourceContents, limits);
      await publish(identity, entries);
      return resolved;
    },
  };
}
