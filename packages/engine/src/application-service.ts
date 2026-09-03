import type {
  ChangeSet,
  CheckId,
  GeneratedArtifactRequirement,
  Project,
  RepositorySnapshot,
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
import type { ExecutionLimits } from "./interfaces.js";
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
  readonly executionLimits?: ExecutionLimits;
  readonly dependencyProvisioning?: VerificationPipelineInput["dependencyProvisioning"];
  readonly generatedArtifactRequirements?: readonly GeneratedArtifactRequirement[];
  readonly generatedArtifactDestination?: string;
}

export interface VerifySourceRequest {
  readonly source: SnapshotSourceReference;
  readonly plannerConfig?: PlannerConfig;
  readonly selectedCheckIds?: readonly CheckId[];
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
    super(message);
    this.name = "VerificationApplicationServiceError";
  }
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
  constructor(
    private readonly pipeline: VerificationPipeline,
    private readonly sourceResolver: SourceResolver,
  ) {}

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
      executionLimits: input.executionLimits,
      jobId: input.job.id,
      executionId: `${input.job.id}-execution`,
      resultId: `${input.verificationId}-result`,
      createdAt: input.request.createdAt,
      ...(input.dependencyProvisioning !== undefined
        ? { dependencyProvisioning: input.dependencyProvisioning }
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
    return this.verify(this.adaptResolvedSource(resolved, input));
  }

  private adaptResolvedSource(
    resolved: ResolvedSource,
    input: VerifySourceRequest,
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
      executionLimits: input.executionLimits,
      dependencyProvisioning: input.dependencyProvisioning,
      generatedArtifactRequirements: input.generatedArtifactRequirements,
      generatedArtifactDestination: input.generatedArtifactDestination,
    };
  }
}
