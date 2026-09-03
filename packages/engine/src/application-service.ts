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
import type { PlannerConfig } from "@verify-agent/checks";
import type { ExecutionLimits } from "./interfaces.js";
import type { DetectionContext } from "./pipeline-types.js";
import {
  type VerificationPipeline,
  type VerificationPipelineInput,
  type VerificationPipelineOutput,
  VerificationPipelineError,
} from "./pipeline.js";
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

export class VerificationApplicationService {
  constructor(private readonly pipeline: VerificationPipeline) {}

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
}
