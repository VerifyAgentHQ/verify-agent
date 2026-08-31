import { createHash } from "node:crypto";
import type {
  ChangeSet,
  CheckId,
  CheckPlan,
  CheckPlanItem,
  CheckExecution,
  Project,
  ProjectProfile,
  RepositorySnapshot,
} from "@verify-agent/domain";
import {
  createCheckDefinitionRegistry,
  createCheckPlanner,
  type CheckPlanner,
  type PlannerConfig,
} from "@verify-agent/checks";
import type {
  DetectionContext,
  ProjectDetectionResult,
} from "./pipeline-types.js";
import { createCheckExecutor } from "./execution.js";
import type {
  CheckExecutor,
  CheckExecutionOutcome,
  ExecutionLimits,
} from "./interfaces.js";
import { DEFAULT_EXECUTION_LIMITS } from "./interfaces.js";
import { brandId } from "@verify-agent/domain";

export interface ProjectDetectionPort {
  detect(
    project: Project,
    snapshot: RepositorySnapshot,
    context: DetectionContext,
  ): ProjectDetectionResult;
}

export interface VerificationPipelineInput {
  readonly project: Project;
  readonly snapshot: RepositorySnapshot;
  readonly changeSet: ChangeSet;
  readonly detectionContext: DetectionContext;
  readonly plannerConfig?: PlannerConfig;
  readonly selectedCheckId?: CheckId;
  readonly executionLimits?: ExecutionLimits;
  readonly jobId: string;
  readonly executionId: string;
  readonly resultId: string;
  readonly createdAt: string;
}

export interface VerificationPipelineOutput {
  readonly project: Project;
  readonly snapshot: RepositorySnapshot;
  readonly changeSet: ChangeSet;
  readonly profile: ProjectProfile;
  readonly plan: CheckPlan;
  readonly selectedItem: CheckPlanItem;
  readonly execution: CheckExecutionOutcome["execution"];
  readonly sandboxRequest: CheckExecutionOutcome["request"];
  readonly checkResult: CheckExecutionOutcome["result"];
}

export type VerificationPipelineErrorCode =
  "detection_failed" | "no_applicable_check" | "execution_failed";

export class VerificationPipelineError extends Error {
  constructor(
    readonly code: VerificationPipelineErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VerificationPipelineError";
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function createInitialExecution(
  input: VerificationPipelineInput,
  item: CheckPlanItem,
): CheckExecution {
  return {
    id: brandId<"CheckExecutionId">(input.executionId),
    checkDefinitionId: item.checkId,
    jobId: brandId<"VerificationJobId">(input.jobId),
    inputsHash: stableHash({
      projectId: input.project.id,
      snapshotId: input.snapshot.id,
      changeSetId: input.changeSet.id,
      checkId: item.checkId,
      checkVersion: item.checkVersion,
    }),
    status: "queued",
  };
}

export interface VerificationPipeline {
  verify(input: VerificationPipelineInput): Promise<VerificationPipelineOutput>;
}

export interface VerificationPipelineDependencies {
  readonly detector: ProjectDetectionPort;
  readonly planner?: CheckPlanner;
  readonly executor: CheckExecutor;
}

export function createVerificationPipeline(
  dependencies: VerificationPipelineDependencies,
): VerificationPipeline {
  const planner = dependencies.planner ?? createCheckPlanner();
  const definitions = createCheckDefinitionRegistry();
  return {
    async verify(input): Promise<VerificationPipelineOutput> {
      let detected: ProjectDetectionResult;
      try {
        detected = dependencies.detector.detect(
          input.project,
          input.snapshot,
          input.detectionContext,
        );
      } catch (error) {
        throw new VerificationPipelineError(
          "detection_failed",
          "Project detection failed",
          error,
        );
      }
      const plan = planner.plan(detected.profile, input.plannerConfig);
      const selectedCheckId =
        input.selectedCheckId ?? brandId<"CheckId">("typescript.typecheck");
      const selectedItem = plan.items.find(
        (item) => item.checkId === selectedCheckId,
      );
      if (!selectedItem || selectedItem.applicability !== "applicable")
        throw new VerificationPipelineError(
          "no_applicable_check",
          `No applicable planned check: ${String(selectedCheckId)}`,
        );
      const definition = definitions.find(selectedItem.checkId);
      if (!definition)
        throw new VerificationPipelineError(
          "execution_failed",
          `No definition for planned check: ${String(selectedItem.checkId)}`,
        );
      let outcome: CheckExecutionOutcome;
      try {
        outcome = await dependencies.executor.execute({
          project: input.project,
          profile: detected.profile,
          snapshot: input.snapshot,
          planItem: selectedItem,
          definition,
          execution: createInitialExecution(input, selectedItem),
          resultId: input.resultId,
          createdAt: input.createdAt,
          limits: input.executionLimits ?? DEFAULT_EXECUTION_LIMITS,
        });
      } catch (error) {
        throw new VerificationPipelineError(
          "execution_failed",
          `Check execution failed: ${String(selectedCheckId)}`,
          error,
        );
      }
      return {
        project: input.project,
        snapshot: input.snapshot,
        changeSet: input.changeSet,
        profile: detected.profile,
        plan,
        selectedItem,
        execution: outcome.execution,
        sandboxRequest: outcome.request,
        checkResult: outcome.result,
      };
    },
  };
}

export function createDefaultVerificationPipeline(
  detector: ProjectDetectionPort,
  executor: CheckExecutor,
  planner?: CheckPlanner,
): VerificationPipeline {
  return createVerificationPipeline({ detector, executor, planner });
}
