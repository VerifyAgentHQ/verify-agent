import { randomUUID } from "node:crypto";
import { lstat, mkdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DependencyProvisioningRequest,
  GeneratedArtifactRequirement,
} from "@verify-agent/domain";
import type { ExecutionEnvironment } from "./interfaces.js";
import {
  artifactDirectoryContentHash,
  artifactEntriesContentHash,
  DependencyProvisioningError,
} from "./dependency-provisioning.js";
import type {
  ExecutionEnvironmentDependencyVerification,
  ExecutionEnvironmentMaterializer,
} from "./environment-materializer.js";

/**
 * Batch 56C-R1 — atomic composed-snapshot materialization (Codex finding 1).
 *
 * The published source snapshot is immutable. Dependencies are therefore
 * never written into the source snapshot directory. Instead:
 *
 * ```text
 * published source snapshot (<storeRoot>/<sourceIdentity>, immutable)
 *         ↓
 * composition staging directory (<storeRoot>/.staging-<identity>-<uuid>)
 *         ↓
 * copy/compose source + trusted dependency artifact
 *         ↓
 * validate the complete composed tree
 *         ↓
 * atomically publish  rename(staging → <storeRoot>/<composedIdentity>)
 *         ↓
 * sandbox request references the exact opaque composed identity
 * ```
 *
 * Publication uses the repository's existing publish/locking mechanism: a
 * uniquely named staging directory under the same store root followed by a
 * single atomic rename to a path that does not exist yet, with first-writer
 * wins and byte-identical acceptance on a lost race. This is deliberately the
 * same contract as `SnapshotStorePublisher`, because atomically *replacing* an
 * existing non-empty directory is not available (POSIX rejects `rename` onto a
 * non-empty directory; Windows rejects it with `EPERM`/`ENOTEMPTY`), and
 * removing the published source snapshot first would expose a window with no
 * snapshot at all.
 *
 * Consequences, by construction:
 *
 * - A failed composition removes its staging tree and never touches the final
 *   identity, so no partially usable final snapshot can exist.
 * - A concurrent composition of the same identity stages separately; the
 *   rename decides the single winner, and the loser only accepts a
 *   byte-identical tree (otherwise it fails closed).
 * - A retry starts from a fresh staging tree and never mutates a previous
 *   incomplete attempt.
 * - An existing complete composition for the same exact source/dependency
 *   identity is reused unchanged; a conflicting identity fails closed.
 */

const SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SANDBOX_SNAPSHOT_ID_MAX = 256;
const HASH = /^[a-f0-9]{64}$/;

export class SnapshotCompositionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "SnapshotCompositionError";
    if (options?.cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = options.cause;
    }
  }
}

function confinedTo(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== "..");
}

const COMPOSITION_LOCK_DIR = ".locks";
const DEFAULT_LEASE_WAIT_MS = 30_000;
const DEFAULT_LEASE_POLL_MS = 25;

/** Bounded-wait options for the composition lease. */
export interface CompositionLeaseOptions {
  /** Maximum time to keep trying before failing closed (default 30s). */
  readonly waitMs?: number;
  /** Poll interval while waiting for a contended lease (default 25ms). */
  readonly pollMs?: number;
}

export class SnapshotCompositionLockError extends SnapshotCompositionError {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotCompositionLockError";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Batch 56C-R4 — cooperative cross-process composition lease.
 *
 * Atomic `mkdir` of `<storeRoot>/.locks/<composed-identity>.lock` is the
 * ownership token: directory creation is atomic and fails with `EEXIST` on
 * both POSIX and Windows, so two VerifyAgent compositions for the same exact
 * composed identity can never both hold it. The lease:
 *
 * - binds to the exact composed identity (which is sandbox-safe and can never
 *   start with `.`, so it can never collide with the `.locks` locator);
 * - lives outside every published identity directory, so it is never part of
 *   a snapshot and is never visible to the sandbox;
 * - fails closed (`SnapshotCompositionLockError`) after a bounded wait;
 * - is always released through `finally`.
 *
 * This is a cooperative application lock establishing the invariant that all
 * VerifyAgent composition mutation for an identity happens under the lease. It
 * is deliberately not a defence against an arbitrary process that ignores the
 * protocol; unpredictable private staging names remain defence in depth.
 */
export async function acquireCompositionLease(
  storeRoot: string,
  identity: string,
  options: CompositionLeaseOptions = {},
): Promise<() => Promise<void>> {
  if (typeof identity !== "string" || !SNAPSHOT_ID_RE.test(identity)) {
    throw new SnapshotCompositionError(
      "composition lease identity is not sandbox-safe",
    );
  }
  const waitMs = options.waitMs ?? DEFAULT_LEASE_WAIT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LEASE_POLL_MS;
  if (
    !Number.isFinite(waitMs) ||
    waitMs < 0 ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0
  ) {
    throw new SnapshotCompositionError("composition lease options are invalid");
  }
  const lockDir = join(storeRoot, COMPOSITION_LOCK_DIR);
  await mkdir(lockDir, { recursive: true, mode: 0o700 });
  const lockPath = join(lockDir, `${identity}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await rm(lockPath, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "EEXIST") {
        throw new SnapshotCompositionError(
          "composition lease acquisition failed",
          { cause: error },
        );
      }
      if (Date.now() >= deadline) {
        throw new SnapshotCompositionLockError(
          "composition identity is locked by another composition",
        );
      }
      await delay(pollMs);
    }
  }
}

/**
 * Derives the exact opaque sandbox snapshot identity for a composition of one
 * resolved source identity and one trusted dependency artifact content hash.
 *
 * The identity is deterministic, sandbox-safe (the external sandbox accepts
 * exactly `[A-Za-z0-9._-]{1,256}`), and *bound to both* inputs: the exact
 * source identity is the prefix and the exact dependency artifact content hash
 * is the suffix. No second identity scheme is introduced — this is a pure
 * naming function over the repository's existing identities.
 */
export function composedSnapshotIdentity(
  sourceIdentity: string,
  artifactContentHash: string,
): string {
  if (
    typeof sourceIdentity !== "string" ||
    !SNAPSHOT_ID_RE.test(sourceIdentity) ||
    sourceIdentity === "." ||
    sourceIdentity === ".." ||
    sourceIdentity.includes("/") ||
    sourceIdentity.includes("\\")
  ) {
    throw new SnapshotCompositionError(
      "source snapshot identity is not sandbox-safe",
    );
  }
  if (
    typeof artifactContentHash !== "string" ||
    !HASH.test(artifactContentHash)
  ) {
    throw new SnapshotCompositionError(
      "dependency artifact content hash is required for composition",
    );
  }
  const suffix = artifactContentHash.slice(0, 32);
  const identity = `${sourceIdentity}-dep-${suffix}`;
  if (identity.length > SANDBOX_SNAPSHOT_ID_MAX) {
    throw new SnapshotCompositionError(
      "composed snapshot identity exceeds the sandbox identity limit",
    );
  }
  return identity;
}

export interface ComposedSnapshotRequest {
  /** Environment whose dependency identity is being composed. */
  readonly environment: ExecutionEnvironment;
  /** Published, immutable source snapshot directory. */
  readonly sourceRoot: string;
  /** Exact source snapshot identity (e.g. the commit SHA). */
  readonly sourceIdentity: string;
  /** Trusted dependency artifact to compose (content-hash verified). */
  readonly dependencyProvisioning: DependencyProvisioningRequest;
  readonly generatedRequirements?: readonly GeneratedArtifactRequirement[];
}

export interface ComposedSnapshotResult {
  /** Exact opaque identity the sandbox must resolve. */
  readonly snapshotIdentity: string;
  readonly destination: string;
  /** Environment to hand to the verification pipeline (no re-provisioning). */
  readonly environment: ExecutionEnvironment;
  readonly identityHash: string;
  readonly dependencyArtifactId: string;
  readonly generatedArtifactIds: readonly string[];
  /** `true` when this call published the identity, `false` when reusing it. */
  readonly published: boolean;
}

export interface ComposedSnapshotStoreDependencies {
  /** Sandbox snapshot store root (`VERIFY_SANDBOX_SNAPSHOT_ROOT`). */
  readonly storeRoot: string;
  readonly materializer: ExecutionEnvironmentMaterializer;
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  /** Bounded-wait options for the composition lease. */
  readonly lease?: CompositionLeaseOptions;
  /**
   * Batch 56C-R4 — deterministic test/observability seam invoked while the
   * composition lease is held, immediately after the complete composed-tree
   * hash and before the atomic publication.
   */
  readonly onBeforePublish?: (event: {
    readonly identity: string;
    readonly staging: string;
    readonly destination: string;
    readonly contentHash: string;
  }) => void | Promise<void>;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory();
  } catch {
    return false;
  }
}

function isRenameConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "EEXIST" ||
    code === "ENOTEMPTY" ||
    code === "EPERM" ||
    code === "EACCES" ||
    code === "EISDIR" ||
    code === "ENOTDIR"
  );
}

/**
 * Publishes `staging` to `destination` atomically, or accepts an existing
 * byte-identical publication. Anything else fails closed.
 */
async function publishAtomically(
  staging: string,
  destination: string,
  limits: { readonly maxBytes: number; readonly maxFiles: number },
): Promise<boolean> {
  const digest = (path: string) => artifactDirectoryContentHash(path, limits);
  if (await isDirectory(destination)) {
    const [composed, existing] = await Promise.all([
      digest(staging),
      digest(destination),
    ]);
    if (composed !== existing) {
      throw new SnapshotCompositionError(
        "composed snapshot identity already holds different contents",
      );
    }
    return false;
  }
  try {
    await rename(staging, destination);
    return true;
  } catch (error) {
    if (!isRenameConflict(error)) throw error;
    if (!(await isDirectory(destination)))
      throw new SnapshotCompositionError(
        "composed snapshot publication failed",
        {
          cause: error,
        },
      );
    // Lost a concurrent-composition race: accept only a byte-identical tree.
    const [composed, existing] = await Promise.all([
      digest(staging),
      digest(destination),
    ]);
    if (composed !== existing) {
      throw new SnapshotCompositionError(
        "composed snapshot identity already holds different contents",
        { cause: error },
      );
    }
    return false;
  }
}

/** Composes source + trusted dependency artifact and publishes atomically. */
export class ComposedSnapshotStore {
  private readonly storeRoot: string;
  private readonly materializer: ExecutionEnvironmentMaterializer;
  private readonly limits: {
    readonly maxBytes: number;
    readonly maxFiles: number;
  };
  private readonly lease: CompositionLeaseOptions;
  private readonly onBeforePublish?: ComposedSnapshotStoreDependencies["onBeforePublish"];

  constructor(dependencies: ComposedSnapshotStoreDependencies) {
    if (
      typeof dependencies?.storeRoot !== "string" ||
      !isAbsolute(dependencies.storeRoot)
    ) {
      throw new SnapshotCompositionError(
        "composed snapshot store root must be an absolute path",
      );
    }
    if (
      !dependencies.materializer ||
      typeof dependencies.materializer.materialize !== "function"
    ) {
      throw new SnapshotCompositionError(
        "composed snapshot store requires an environment materializer",
      );
    }
    this.storeRoot = resolve(dependencies.storeRoot);
    this.materializer = dependencies.materializer;
    this.limits = {
      maxBytes: dependencies.maxBytes ?? 2 * 1024 * 1024 * 1024,
      maxFiles: dependencies.maxFiles ?? 100_000,
    };
    this.lease = dependencies.lease ?? {};
    this.onBeforePublish = dependencies.onBeforePublish;
  }

  async materialize(
    request: ComposedSnapshotRequest,
  ): Promise<ComposedSnapshotResult> {
    if (!isAbsolute(request.sourceRoot)) {
      throw new SnapshotCompositionError(
        "source snapshot path must be an absolute path",
      );
    }
    const sourceRoot = resolve(request.sourceRoot);
    const identity = composedSnapshotIdentity(
      request.sourceIdentity,
      request.dependencyProvisioning.artifact.artifactContentHash ?? "",
    );
    const destination = join(this.storeRoot, identity);
    if (!confinedTo(this.storeRoot, destination)) {
      throw new SnapshotCompositionError(
        "composed snapshot identity escapes the store root",
      );
    }
    // Batch 56C-R2 — defense in depth: composition may only consume the exact
    // published source snapshot `<storeRoot>/<sourceIdentity>`. An arbitrary
    // absolute path, a sibling directory, another SHA, or any path outside the
    // store root is rejected before any composition begins. `sourceIdentity`
    // was already validated as sandbox-safe by `composedSnapshotIdentity`.
    if (sourceRoot !== resolve(join(this.storeRoot, request.sourceIdentity))) {
      throw new SnapshotCompositionError(
        "source snapshot must be the published snapshot for this identity",
      );
    }
    if (!(await isDirectory(sourceRoot))) {
      throw new SnapshotCompositionError(
        "source snapshot is unavailable for composition",
      );
    }
    await mkdir(this.storeRoot, { recursive: true, mode: 0o755 });
    // Unique staging identity: an attempt can never inherit (and therefore
    // never continue mutating) an incomplete tree from a previous attempt.
    const staging = join(
      this.storeRoot,
      `.staging-${identity}-${randomUUID()}`,
    );
    try {
      await mkdir(staging, { mode: 0o755 });
      const composed = await this.materializer.materialize({
        environment: request.environment,
        sourceRoot,
        destination: staging,
        dependencyProvisioning: request.dependencyProvisioning,
        ...(request.generatedRequirements === undefined
          ? {}
          : { generatedRequirements: request.generatedRequirements }),
      });
      // Batch 56C-R4 — acquire exclusive composition ownership for this exact
      // identity before the final verification→publication interval, then
      // re-verify the dependency subtree at its final location, hash the
      // complete composed tree, and publish atomically while ownership is held.
      const { published } = await this.verifyAndPublish(
        identity,
        staging,
        destination,
        composed.dependencyVerification,
      );
      // Published staging was renamed away; a reused staging tree is removed.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      const environment: ExecutionEnvironment = Object.freeze({
        ...request.environment,
        sandboxSnapshotIdentity: identity,
        identityHash: composed.identityHash,
      });
      return Object.freeze({
        snapshotIdentity: identity,
        destination,
        environment,
        identityHash: composed.identityHash,
        dependencyArtifactId:
          composed.dependencyArtifactId ??
          request.dependencyProvisioning.artifact.artifactId,
        generatedArtifactIds: composed.generatedArtifactIds,
        published,
      });
    } catch (error) {
      // A failed composition can never leave a partially usable final
      // snapshot: only the uniquely named staging tree is removed.
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      if (error instanceof SnapshotCompositionError) throw error;
      if (error instanceof DependencyProvisioningError) throw error;
      throw new SnapshotCompositionError("snapshot composition failed", {
        cause: error,
      });
    }
  }

  /**
   * Owns the complete final-verification→publication interval under the
   * composition lease:
   *
   * ```text
   * acquire composition ownership
   *   → final dependency verification (at the composed-staging location)
   *   → complete composed-tree hash/validation
   *   → atomic first-writer-wins publication
   * release ownership
   * ```
   *
   * No VerifyAgent composition can hold the same identity's lease during this
   * interval, so the bytes that were hashed are the bytes that are published.
   */
  private async verifyAndPublish(
    identity: string,
    staging: string,
    destination: string,
    dependencyVerification:
      ExecutionEnvironmentDependencyVerification | undefined,
  ): Promise<{ readonly published: boolean }> {
    const release = await acquireCompositionLease(
      this.storeRoot,
      identity,
      this.lease,
    );
    try {
      if (dependencyVerification !== undefined) {
        const placed = await artifactEntriesContentHash(
          staging,
          dependencyVerification.topLevelEntries,
          this.limits,
        );
        if (placed !== dependencyVerification.artifactContentHash)
          throw new SnapshotCompositionError(
            "composed dependency artifact integrity mismatch",
          );
      }
      // Complete composed-tree hash/validation while ownership is held.
      const contentHash = await artifactDirectoryContentHash(
        staging,
        this.limits,
      );
      await this.onBeforePublish?.({
        identity,
        staging,
        destination,
        contentHash,
      });
      const published = await publishAtomically(
        staging,
        destination,
        this.limits,
      );
      return { published };
    } finally {
      await release();
    }
  }
}
