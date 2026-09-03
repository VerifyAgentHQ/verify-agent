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
  DependencyProvisioningPort,
  ExecutionEnvironment,
  ProvisioningStatus,
} from "./interfaces.js";
import type { GeneratedArtifactPreparer } from "./generated-artifacts.js";
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
  /** Optional deterministic subset; items retain CheckPlan order. */
  readonly selectedCheckIds?: readonly CheckId[];
  readonly executionLimits?: ExecutionLimits;
  readonly jobId: string;
  readonly executionId: string;
  readonly resultId: string;
  readonly createdAt: string;
  readonly dependencyProvisioning?: {
    readonly request: import("@verify-agent/domain").DependencyProvisioningRequest;
    readonly destination: string;
  };
  readonly generatedArtifactRequirements?: readonly import("@verify-agent/domain").GeneratedArtifactRequirement[];
  readonly generatedArtifactDestination?: string;
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
  readonly executions: readonly CheckExecutionOutcome["execution"][];
  readonly sandboxRequests: readonly CheckExecutionOutcome["request"][];
  readonly checkResults: readonly CheckExecutionOutcome["result"][];
  readonly executionEnvironment?: ExecutionEnvironment;
  readonly provisioningStatus: ProvisioningStatus;
}

export type VerificationPipelineErrorCode =
  | "detection_failed"
  | "no_applicable_check"
  | "dependency_provisioning_failed"
  | "execution_failed";

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
  environment?: ExecutionEnvironment,
  index = 0,
): CheckExecution {
  return {
    id: brandId<"CheckExecutionId">(
      index === 0 ? input.executionId : `${input.executionId}-${index}`,
    ),
    checkDefinitionId: item.checkId,
    jobId: brandId<"VerificationJobId">(input.jobId),
    inputsHash: stableHash({
      projectId: input.project.id,
      snapshotId: input.snapshot.id,
      changeSetId: input.changeSet.id,
      checkId: item.checkId,
      checkVersion: item.checkVersion,
      dependencyArtifactId: environment?.dependencyEnvironment?.artifactId,
      environmentIdentity: environment?.identityHash,
    }),
    status: "queued",
    ...(environment?.dependencyEnvironment?.artifactId === undefined
      ? {}
      : { dependencyArtifactId: environment.dependencyEnvironment.artifactId }),
  };
}

export interface VerificationPipeline {
  verify(input: VerificationPipelineInput): Promise<VerificationPipelineOutput>;
}

export interface VerificationPipelineDependencies {
  readonly detector: ProjectDetectionPort;
  readonly planner?: CheckPlanner;
  readonly executor: CheckExecutor;
  readonly dependencyProvisioner?: DependencyProvisioningPort;
  readonly generatedArtifactPreparer?: GeneratedArtifactPreparer;
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
      const selectedCheckIds = input.selectedCheckIds ?? [
        input.selectedCheckId ?? brandId<"CheckId">("typescript.typecheck"),
      ];
      if (selectedCheckIds.length === 0) {
        throw new VerificationPipelineError(
          "no_applicable_check",
          "No checks were selected for execution",
        );
      }
      const selectedSet = new Set(selectedCheckIds.map(String));
      if (selectedSet.size !== selectedCheckIds.length)
        throw new VerificationPipelineError(
          "no_applicable_check",
          "Duplicate checks cannot be executed",
        );
      const selectedItems = plan.items.filter((item) =>
        selectedSet.has(String(item.checkId)),
      );
      if (
        selectedItems.length !== selectedCheckIds.length ||
        selectedItems.some((item) => item.applicability !== "applicable")
      )
        throw new VerificationPipelineError(
          "no_applicable_check",
          `No applicable planned check: ${selectedCheckIds
            .filter(
              (checkId) =>
                !selectedItems.some((item) => item.checkId === checkId),
            )
            .map(String)
            .join(", ")}`,
        );
      const selectedItem = selectedItems[0];
      const definitionsForItems = selectedItems.map((item) => {
        const definition = definitions.find(item.checkId);
        if (!definition)
          throw new VerificationPipelineError(
            "execution_failed",
            `No definition for planned check: ${String(item.checkId)}`,
          );
        return definition;
      });
      let executionEnvironment: ExecutionEnvironment | undefined;
      let provisioningStatus: ProvisioningStatus = "not_started";
      if (input.dependencyProvisioning) {
        if (!dependencies.dependencyProvisioner)
          throw new VerificationPipelineError(
            "dependency_provisioning_failed",
            "Dependency provisioning was requested but no provisioner is configured",
          );
        provisioningStatus = "provisioning";
        try {
          const dependencyEnvironment =
            await dependencies.dependencyProvisioner.provision(
              input.dependencyProvisioning.request,
              input.dependencyProvisioning.destination,
            );
          executionEnvironment = Object.freeze({
            sourceSnapshotId: input.snapshot.id,
            dependencyEnvironment,
            generatedArtifacts: Object.freeze([]),
            identityHash: stableHash({
              sourceSnapshotId: input.snapshot.id,
              dependencyArtifactId: dependencyEnvironment.artifactId,
              dependencyContentHash: dependencyEnvironment.contentHash,
              generatedArtifacts: [],
            }),
          });
          provisioningStatus = "ready";
        } catch (error) {
          provisioningStatus = "failed";
          throw new VerificationPipelineError(
            "dependency_provisioning_failed",
            "Dependency provisioning failed",
            error,
          );
        }
      }
      const requirements = input.generatedArtifactRequirements ?? [];
      if (requirements.length > 0 && !dependencies.generatedArtifactPreparer)
        throw new VerificationPipelineError(
          "dependency_provisioning_failed",
          "Generated artifact preparation was requested but no preparer is configured",
        );
      if (requirements.length > 0 && !input.generatedArtifactDestination)
        throw new VerificationPipelineError(
          "dependency_provisioning_failed",
          "Generated artifact destination is required",
        );
      if (requirements.length > 0) {
        provisioningStatus = "provisioning";
        try {
          const baseEnvironment: ExecutionEnvironment =
            executionEnvironment ??
            (Object.freeze({
              sourceSnapshotId: input.snapshot.id,
              generatedArtifacts: Object.freeze([]),
              identityHash: stableHash({ sourceSnapshotId: input.snapshot.id }),
            }) as ExecutionEnvironment);
          const generatedArtifacts = [];
          for (const requirement of requirements) {
            generatedArtifacts.push(
              await dependencies.generatedArtifactPreparer!.prepare(
                requirement,
                baseEnvironment,
                input.generatedArtifactDestination!,
              ),
            );
          }
          executionEnvironment = Object.freeze({
            ...baseEnvironment,
            generatedArtifacts: Object.freeze(generatedArtifacts),
            identityHash: stableHash({
              sourceSnapshotId: baseEnvironment.sourceSnapshotId,
              dependencyEnvironment: baseEnvironment.dependencyEnvironment,
              generatedArtifacts,
            }),
          });
          provisioningStatus = "ready";
        } catch (error) {
          provisioningStatus = "failed";
          throw new VerificationPipelineError(
            "dependency_provisioning_failed",
            "Generated artifact preparation failed",
            error,
          );
        }
      }
      const outcomes: CheckExecutionOutcome[] = [];
      for (const [index, item] of selectedItems.entries()) {
        try {
          outcomes.push(
            await dependencies.executor.execute({
              project: input.project,
              profile: detected.profile,
              snapshot: input.snapshot,
              planItem: item,
              definition: definitionsForItems[index],
              execution: createInitialExecution(
                input,
                item,
                executionEnvironment,
                index,
              ),
              resultId:
                index === 0 ? input.resultId : `${input.resultId}-${index}`,
              createdAt: input.createdAt,
              limits: input.executionLimits ?? DEFAULT_EXECUTION_LIMITS,
              executionEnvironment,
            }),
          );
        } catch (error) {
          throw new VerificationPipelineError(
            "execution_failed",
            `Check execution failed: ${String(item.checkId)}`,
            error,
          );
        }
      }
      const outcome = outcomes[0];
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
        executions: Object.freeze(outcomes.map(({ execution }) => execution)),
        sandboxRequests: Object.freeze(outcomes.map(({ request }) => request)),
        checkResults: Object.freeze(outcomes.map(({ result }) => result)),
        executionEnvironment,
        provisioningStatus,
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
