import type {
  ChangeSet,
  CheckId,
  GeneratedArtifactRequirement,
  Project,
  RepositorySnapshot,
  VerificationCheckSelection,
  VerificationJob,
  VerificationRequest,
  VerificationResult,
} from "@verify-agent/domain";
import {
  brandId,
  InvalidSourceReferenceError,
  type ResolvedSource,
  type SnapshotSourceReference,
  type SourceResolver,
} from "@verify-agent/domain";
import type { PlannerConfig } from "@verify-agent/checks";
import type {
  DependencyProvisioningPort,
  ExecutionEnvironment,
  ExecutionLimits,
} from "./interfaces.js";
import type { DetectionContext } from "./pipeline-types.js";
import {
  type VerificationPipeline,
  type VerificationPipelineInput,
  type VerificationPipelineOutput,
  VerificationPipelineError,
} from "./pipeline.js";
import { createMemoryDetectionContext } from "./memory-detection-context.js";
import {
  aggregateVerification,
  aggregationInputFromPipeline,
} from "./aggregation.js";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  dependencyArtifactId,
  readDependencyArtifactMetadata,
  validateDependencyProvisioningRequest,
} from "./dependency-provisioning.js";
import type { ExecutionEnvironmentMaterializer } from "./environment-materializer.js";
import { ComposedSnapshotStore } from "./snapshot-composition.js";
import { deriveNodeDependencyIdentity } from "./snapshot-dependency-materialization.js";

export interface VerifyRepositorySnapshotRequest {
  readonly project: Project;
  readonly snapshot: RepositorySnapshot;
  readonly changeSet: ChangeSet;
  readonly detectionContext: DetectionContext;
  readonly request: VerificationRequest;
  readonly job: VerificationJob;
  readonly verificationId: string;
  readonly plannerConfig?: PlannerConfig;
  readonly selectedCheckIds?: readonly CheckId[];
  /**
   * Batch 53 — selection intent forwarded to the pipeline. Explicit
   * `selectedCheckIds` win when present; `"all-applicable"` requests the
   * deterministic applicable executable plan. Absent preserves history.
   */
  readonly selection?: VerificationCheckSelection;
  readonly executionLimits?: ExecutionLimits;
  readonly dependencyProvisioning?: VerificationPipelineInput["dependencyProvisioning"];
  /**
   * Batch 56C-R1 — already materialized immutable environment. When present
   * the pipeline consumes it and never provisions again.
   */
  readonly executionEnvironment?: ExecutionEnvironment;
  readonly generatedArtifactRequirements?: readonly GeneratedArtifactRequirement[];
  readonly generatedArtifactDestination?: string;
}

export interface VerifySourceRequest {
  readonly source: SnapshotSourceReference;
  readonly plannerConfig?: PlannerConfig;
  readonly selectedCheckIds?: readonly CheckId[];
  readonly selection?: VerificationCheckSelection;
  readonly executionLimits?: ExecutionLimits;
  readonly dependencyProvisioning?: VerifyRepositorySnapshotRequest["dependencyProvisioning"];
  readonly generatedArtifactRequirements?: readonly GeneratedArtifactRequirement[];
  readonly generatedArtifactDestination?: string;
}

export class VerificationApplicationServiceError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    cause?: unknown,
  ) {
    // Batch 56C-R1 — preserve the underlying cause so a fail-closed
    // dependency/integrity rejection stays diagnosable end to end.
    super(message, cause === undefined ? undefined : { cause });
    this.name = "VerificationApplicationServiceError";
  }
}

/**
 * Batch 56C — production snapshot-dependency materialization.
 *
 * When configured, `verifySource` derives the canonical dependency
 * identity from exact resolved source bytes, provisions the trusted
 * offline artifact, and composes it into the SAME snapshot-store
 * directory the external sandbox resolves (`<root>/<sourceState.value>`)
 * via the existing `ExecutionEnvironmentMaterializer`.
 *
 * - Snapshot identity is never substituted: the sandbox request still
 *   carries the exact `snapshot.sourceState.value` (SHA for GitHub).
 * - No second workspace, no host working-directory fallback, no host
 *   `node_modules` copy, no package-manager invocation, no network.
 * - `artifactPolicy` stays `"none"`: dependencies live inside the opaque
 *   snapshot workspace, so the sandbox contract is unchanged.
 * - Artifact selection stays by validated identity beneath the configured
 *   artifact root (provisioner confinement); the caller can never select
 *   an arbitrary filesystem path.
 * - When unconfigured (or when the source has no Node/pnpm manifest
 *   pair), historical behavior is preserved: no auto-provisioning, and an
 *   explicitly requested provisioning without a provisioner still fails
 *   closed in the pipeline.
 */
export interface SnapshotDependencyMaterialization {
  /** Operator-controlled snapshot store root (same as sandbox `SNAPSHOT_ROOT`). */
  readonly snapshotStoreRoot: string;
  /** Trusted artifact store that carries the published artifact metadata. */
  readonly dependencyArtifactRoot: string;
  readonly dependencyProvisioner: DependencyProvisioningPort;
  readonly materializer: ExecutionEnvironmentMaterializer;
}

const SNAPSHOT_STORE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

function requireSnapshotStoreIdentity(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    !SNAPSHOT_STORE_ID_RE.test(value) ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new VerificationApplicationServiceError(
      "snapshot identity is not sandbox-safe",
      "dependency_provisioning_failed",
    );
  }
  return value;
}

function confinedUnder(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  const suffix = relative(base, target);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== "..");
}

function isInvalidSourceReferenceError(error: unknown): boolean {
  return (
    error instanceof InvalidSourceReferenceError ||
    (error instanceof Error && error.name === "InvalidSourceReferenceError")
  );
}

function validateSourceReference(source: unknown): SnapshotSourceReference {
  if (
    typeof source !== "object" ||
    source === null ||
    (source as { kind?: unknown }).kind !== "snapshot" ||
    typeof (source as { id?: unknown }).id !== "string" ||
    (source as { id: string }).id.trim().length === 0
  ) {
    throw new InvalidSourceReferenceError("invalid source reference");
  }
  return source as SnapshotSourceReference;
}

export class VerificationApplicationService {
  /** Atomic composed-snapshot publication; present only when configured. */
  private readonly composition?: ComposedSnapshotStore;

  constructor(
    private readonly pipeline: VerificationPipeline,
    private readonly sourceResolver: SourceResolver,
    private readonly materialization?: SnapshotDependencyMaterialization,
  ) {
    if (materialization !== undefined) {
      if (
        typeof materialization.snapshotStoreRoot !== "string" ||
        !isAbsolute(materialization.snapshotStoreRoot)
      ) {
        throw new VerificationApplicationServiceError(
          "snapshot store root must be an absolute path",
          "dependency_provisioning_failed",
        );
      }
      if (
        typeof materialization.dependencyArtifactRoot !== "string" ||
        !isAbsolute(materialization.dependencyArtifactRoot)
      ) {
        throw new VerificationApplicationServiceError(
          "dependency artifact root must be an absolute path",
          "dependency_provisioning_failed",
        );
      }
      if (
        !materialization.dependencyProvisioner ||
        typeof materialization.dependencyProvisioner.provision !== "function" ||
        !materialization.materializer ||
        typeof materialization.materializer.materialize !== "function"
      ) {
        throw new VerificationApplicationServiceError(
          "snapshot materialization requires a provisioner and materializer",
          "dependency_provisioning_failed",
        );
      }
      // Composition is staged and atomically published under the same store
      // root the external sandbox resolves; the source snapshot is immutable.
      this.composition = new ComposedSnapshotStore({
        storeRoot: materialization.snapshotStoreRoot,
        materializer: materialization.materializer,
      });
    }
  }

  async verify(
    input: VerifyRepositorySnapshotRequest,
  ): Promise<VerificationResult> {
    const pipelineInput: VerificationPipelineInput = {
      project: input.project,
      snapshot: input.snapshot,
      changeSet: input.changeSet,
      detectionContext: input.detectionContext,
      plannerConfig: input.plannerConfig,
      selectedCheckIds: input.selectedCheckIds,
      selection: input.selection,
      executionLimits: input.executionLimits,
      jobId: input.job.id,
      executionId: `${input.job.id}-execution`,
      resultId: `${input.verificationId}-result`,
      createdAt: input.request.createdAt,
      ...(input.dependencyProvisioning !== undefined
        ? { dependencyProvisioning: input.dependencyProvisioning }
        : {}),
      ...(input.executionEnvironment !== undefined
        ? { executionEnvironment: input.executionEnvironment }
        : {}),
      ...(input.generatedArtifactRequirements !== undefined
        ? {
            generatedArtifactRequirements: input.generatedArtifactRequirements,
            generatedArtifactDestination: input.generatedArtifactDestination,
          }
        : {}),
    };

    let pipelineOutput: VerificationPipelineOutput;
    try {
      pipelineOutput = await this.pipeline.verify(pipelineInput);
    } catch (error) {
      if (error instanceof VerificationPipelineError) {
        throw new VerificationApplicationServiceError(
          `Verification failed: ${error.message}`,
          error.code,
          error,
        );
      }
      throw new VerificationApplicationServiceError(
        `Verification failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        error,
      );
    }

    const aggregationInput = aggregationInputFromPipeline(
      pipelineOutput,
      input.request,
      input.job,
      {
        verificationId: input.verificationId,
        createdAt: input.request.createdAt,
      },
    );

    return aggregateVerification(aggregationInput).result;
  }

  /**
   * Resolves a provider-neutral source reference through the injected
   * SourceResolver, then verifies the resolved immutable snapshot with the
   * existing verification pipeline. The application service never learns how
   * the source was obtained.
   *
   * Batch 56C — when snapshot-dependency materialization is configured,
   * the exact resolved bytes are composed with the trusted offline
   * dependency artifact into a staging tree that is validated and then
   * atomically published under a distinct composed snapshot identity before
   * pipeline execution. The published source snapshot stays immutable, and
   * the sandbox request carries exactly that composed identity. An explicitly
   * supplied `dependencyProvisioning` input wins over auto-derivation to
   * preserve historical explicit-call behavior.
   */
  async verifySource(input: VerifySourceRequest): Promise<VerificationResult> {
    const reference = validateSourceReference(input?.source);
    let resolved: ResolvedSource;
    try {
      resolved = await this.sourceResolver.resolveSnapshot(reference);
    } catch (error) {
      if (isInvalidSourceReferenceError(error)) {
        throw error;
      }
      throw new VerificationApplicationServiceError(
        "Source resolution failed",
        "source_resolution_failed",
        error,
      );
    }
    let executionEnvironment: ExecutionEnvironment | undefined;
    if (input.dependencyProvisioning === undefined) {
      try {
        executionEnvironment =
          await this.materializeSnapshotDependencies(resolved);
      } catch (error) {
        if (
          error instanceof VerificationApplicationServiceError &&
          error.code === "dependency_provisioning_failed"
        ) {
          throw error;
        }
        throw new VerificationApplicationServiceError(
          "Dependency materialization failed",
          "dependency_provisioning_failed",
          error,
        );
      }
    }
    return this.verify(
      this.adaptResolvedSource(resolved, input, executionEnvironment),
    );
  }

  /**
   * Batch 56C-R1 production composition:
   *
   * ```text
   * exact source SHA → immutable published source snapshot →
   * trusted artifact metadata (content-hash bound) →
   * OfflineDependencyProvisioner → ExecutionEnvironmentMaterializer →
   * composition staging → validated → atomically published composed snapshot
   * (<root>/<sourceIdentity>-dep-<artifactContentHash>) →
   * SubprocessSandboxTransport → verify-sandbox → Docker
   * ```
   *
   * Materialization happens exactly once per verification: the returned
   * environment is handed to the pipeline, which never provisions again. The
   * returned environment retains the dependency artifact ID in execution
   * identity and carries the exact opaque sandbox snapshot identity.
   *
   * Returns `undefined` when materialization is unconfigured or the source
   * needs no Node/pnpm dependencies. Never installs, never uses network, never
   * copies host `node_modules`, and never mutates the published source
   * snapshot.
   */
  private async materializeSnapshotDependencies(
    resolved: ResolvedSource,
  ): Promise<ExecutionEnvironment | undefined> {
    const materialization = this.materialization;
    const composition = this.composition;
    if (materialization === undefined || composition === undefined) {
      return undefined;
    }
    const { snapshot, sourceContents } = resolved;
    const identity = deriveNodeDependencyIdentity(snapshot.id, sourceContents);
    if (identity === undefined) return undefined;
    const sourceIdentity = requireSnapshotStoreIdentity(
      snapshot.sourceState.value,
    );
    const storeRoot = materialization.snapshotStoreRoot;
    if (!confinedUnder(storeRoot, join(storeRoot, sourceIdentity))) {
      throw new VerificationApplicationServiceError(
        "snapshot store identity escapes the store root",
        "dependency_provisioning_failed",
      );
    }
    // Codex finding 2 — the trusted, content-hash carrying artifact metadata
    // is required. Without it there is no trusted artifact content identity to
    // bind to, so the whole path fails closed instead of copying an
    // `artifactId`-shaped directory on faith.
    const artifactId = dependencyArtifactId(identity);
    const artifact = await readDependencyArtifactMetadata(
      materialization.dependencyArtifactRoot,
      artifactId,
    );
    if (artifact === undefined) {
      throw new VerificationApplicationServiceError(
        "No trusted dependency artifact metadata is published for this revision",
        "dependency_provisioning_failed",
      );
    }
    // Complete identity binding before any copy: every identity-bearing field
    // (including the canonical content hash) is compared against the derived
    // identity using the single existing canonical algorithm.
    validateDependencyProvisioningRequest({
      identity,
      artifact,
      offlineOnly: true,
    });
    const environment: ExecutionEnvironment = Object.freeze({
      sourceSnapshotId: snapshot.id,
      dependencyEnvironment: Object.freeze({
        artifactId: artifact.artifactId,
        contentHash: artifact.contentHash,
        sourceSnapshotId: artifact.sourceSnapshotId,
        platform: artifact.platform,
        availability: "offline_capable" as const,
        generatedArtifactInputs: artifact.generatedArtifactInputs,
        producer: artifact.producer,
      }),
      generatedArtifacts: Object.freeze([]),
      identityHash: artifact.contentHash,
    });
    const composed = await composition.materialize({
      environment,
      sourceRoot: join(storeRoot, sourceIdentity),
      sourceIdentity,
      dependencyProvisioning: { identity, artifact, offlineOnly: true },
    });
    return composed.environment;
  }

  private adaptResolvedSource(
    resolved: ResolvedSource,
    input: VerifySourceRequest,
    executionEnvironment?: ExecutionEnvironment,
  ): VerifyRepositorySnapshotRequest {
    const snapshot: RepositorySnapshot = resolved.snapshot;
    const projectId = snapshot.projectId;
    const changeSetId = brandId(
      `${input.source.id}-changeset`,
    ) as ChangeSet["id"];
    const requestId = brandId(
      `${input.source.id}-request`,
    ) as VerificationRequest["id"];
    const jobId = brandId(`${input.source.id}-job`) as VerificationJob["id"];
    const verificationId = `${input.source.id}-verification`;
    const createdAt = new Date().toISOString();

    const changeSet: ChangeSet = {
      id: changeSetId,
      baseSourceState: snapshot.sourceState,
      headSourceState: snapshot.sourceState,
      changedFiles: [],
      additions: 0,
      deletions: 0,
      changeHash: input.source.id,
      issueReferences: [],
    };

    const request: VerificationRequest = {
      id: requestId,
      projectId,
      snapshotId: snapshot.id,
      changeSetId,
      requestedBy: { type: "source-platform" },
      mode: "commit",
      requestedChecks: [],
      policyId: brandId("default") as VerificationRequest["policyId"],
      priority: 0,
      createdAt,
    };

    const job: VerificationJob = {
      id: jobId,
      requestId,
      attempt: 1,
      status: "queued",
    };

    const project: Project = {
      id: projectId,
      name: "",
      root: ".",
    };

    return {
      project,
      snapshot,
      changeSet,
      detectionContext: createMemoryDetectionContext(resolved.sourceContents),
      request,
      job,
      verificationId,
      plannerConfig: input.plannerConfig,
      selectedCheckIds: input.selectedCheckIds,
      selection: input.selection,
      executionLimits: input.executionLimits,
      // An explicitly supplied provisioning input keeps the historical
      // explicit-call behavior; otherwise the exactly-once materialized
      // environment is handed to the pipeline (which never provisions again).
      dependencyProvisioning: input.dependencyProvisioning,
      executionEnvironment:
        input.dependencyProvisioning === undefined
          ? executionEnvironment
          : undefined,
      generatedArtifactRequirements: input.generatedArtifactRequirements,
      generatedArtifactDestination: input.generatedArtifactDestination,
    };
  }
}
