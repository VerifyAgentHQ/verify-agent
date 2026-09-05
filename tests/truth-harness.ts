import { createHash } from "node:crypto";
import {
  brandId,
  type CheckExecution,
  type CheckId,
  type CheckResult,
  type ChangeSet,
  type Project,
  type ProjectProfile,
  type RepositorySnapshot,
  type VerificationJob,
  type VerificationRequest,
} from "../packages/domain/src/index.js";
import {
  createProjectDetectionService,
  createFileSystemDetectionContext,
} from "../packages/adapters-lang/src/index.js";
import { createCheckPlanner } from "../packages/checks/src/index.js";
import {
  createVerificationPipeline,
  aggregateVerification,
  aggregationInputFromPipeline,
  type CheckExecutor,
  type CheckExecutionOutcome,
  type VerificationPipelineOutput,
} from "../packages/engine/src/index.js";
import type {
  DetectionContext,
  FixtureScenario,
  ExpectedCheckOutcome,
} from "./truth-matrix-metadata.js";

// ---------------------------------------------------------------------------
// Deterministic test execution adapter
// ---------------------------------------------------------------------------
// This adapter produces structured SandboxJobResults derived from the fixture
// scenario metadata. It is explicitly a test/simulation adapter and does not
// execute arbitrary commands, access the network, or invoke a real sandbox.
// ---------------------------------------------------------------------------

const CHECK_EXECUTION_SOURCE = "simulated" as const;

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Creates a deterministic CheckExecutor for a given fixture scenario.
 *
 * The returned executor maps each check ID to a pre-determined outcome
 * defined in the scenario's expectedCheckOutcomes. Checks not present in
 * the map default to "passed" (healthy behaviour).
 *
 * This is a test-only adapter. Its execution source is always "simulated".
 */
export function createDeterministicTestExecutor(
  scenario: FixtureScenario,
  expectedCheckOutcomes: Readonly<Record<string, ExpectedCheckOutcome>>,
): CheckExecutor {
  return {
    async execute(request): Promise<CheckExecutionOutcome> {
      const checkId = String(request.definition.id);
      const outcome = expectedCheckOutcomes[checkId] ?? "passed";
      const status = outcome === "passed" ? "passed" : "failed";
      const exitCode = outcome === "passed" ? 0 : 1;
      const completedAt = "2026-09-05T00:00:00.000Z";

      const execution: CheckExecution = {
        id: brandId<"CheckExecutionId">(
          `truth-${scenario}-${checkId.replace(/\./g, "-")}`,
        ),
        checkDefinitionId: request.definition.id,
        jobId: request.execution.jobId,
        inputsHash: request.execution.inputsHash,
        ...(request.execution.dependencyArtifactId === undefined
          ? {}
          : { dependencyArtifactId: request.execution.dependencyArtifactId }),
        startedAt: "2026-09-05T00:00:00.000Z",
        completedAt,
        status: "completed",
        executionSource: CHECK_EXECUTION_SOURCE,
      };

      const resultContent = {
        checkExecutionId: execution.id,
        checkId: request.definition.id,
        checkVersion: request.definition.version,
        status,
        exitCode,
        durationMs: 10,
        summary: `${request.definition.name}: ${status} (simulated, scenario: ${scenario})`,
        rawOutputRef: `fixture://logs/${scenario}/${checkId}`,
        artifactRefs: [] as readonly string[],
        inputHash: execution.inputsHash,
        executionSource: CHECK_EXECUTION_SOURCE,
      };

      const result: CheckResult = {
        id: brandId<"CheckResultId">(request.resultId),
        ...resultContent,
        metrics: { memoryBytes: 0, cpuTimeMs: 1 },
        environment: {},
        contentHash: sha256(resultContent),
        createdAt: request.createdAt,
        producer: {
          type: "system" as const,
          name: "truth-harness-test-adapter",
          version: "0.1.0-phase0",
        },
        executionSource: CHECK_EXECUTION_SOURCE,
      };

      // Minimal SandboxJobRequest for the outcome — the pipeline expects this shape.
      const sandboxRequest = {
        schemaVersion: "1.0.0" as const,
        jobId: String(execution.jobId),
        source: request.snapshot.source,
        snapshot: request.snapshot.sourceState.value,
        commands: [
          {
            executable: "fixture",
            args: [checkId],
            workingDirectory: "." as const,
            environment: {} as Readonly<Record<string, string>>,
          },
        ],
        resourceLimits: {
          timeoutMs: 120_000,
          memoryLimitBytes: 512 * 1024 * 1024,
        },
        networkPolicy: "none" as const,
        artifactPolicy: "none" as const,
      };

      return {
        request: sandboxRequest,
        execution,
        result,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Harness composition
// ---------------------------------------------------------------------------
// Wires the real detection → planning → execution → evidence → policy → result
// pipeline using the deterministic test execution adapter. All other components
// are real production components from the existing packages.
// ---------------------------------------------------------------------------

export interface TruthHarnessInput {
  readonly scenario: FixtureScenario;
  readonly fixturePath: string;
  readonly expectedCheckOutcomes: Readonly<
    Record<string, ExpectedCheckOutcome>
  >;
}

export interface TruthHarnessOutput {
  readonly scenario: FixtureScenario;
  readonly detectionProfile: ProjectProfile;
  readonly plan: VerificationPipelineOutput["plan"];
  readonly pipelineOutput: VerificationPipelineOutput;
  readonly verificationResult: import("../packages/domain/src/index.js").VerificationResult;
  readonly evidence: readonly import("../packages/domain/src/index.js").Evidence[];
  readonly findings: readonly import("../packages/domain/src/index.js").Finding[];
  readonly policyDecision: import("../packages/domain/src/index.js").PolicyDecision;
}

export const HARNESS_PROJECT_ID = brandId<"ProjectId">("truth-harness-project");
export const HARNESS_SNAPSHOT_ID = brandId<"RepositorySnapshotId">(
  "truth-harness-snapshot",
);

const HARNESS_PROJECT: Project = {
  id: HARNESS_PROJECT_ID,
  name: "truth-harness",
  root: ".",
};

const HARNESS_SNAPSHOT: RepositorySnapshot = {
  id: HARNESS_SNAPSHOT_ID,
  projectId: HARNESS_PROJECT_ID,
  source: { provider: "fixture", reference: "truth-matrix" },
  sourceState: { type: "snapshot", value: "truth-harness-snapshot" },
  retrievedAt: "2026-09-05T00:00:00Z",
};

const HARNESS_CHANGESET: ChangeSet = {
  id: brandId<"ChangeSetId">("truth-harness-changeset"),
  baseSourceState: { type: "snapshot", value: "truth-harness-snapshot" },
  headSourceState: { type: "snapshot", value: "truth-harness-snapshot" },
  changedFiles: [],
  additions: 0,
  deletions: 0,
  changeHash: "truth-harness".padEnd(64, "0"),
  issueReferences: [],
};

const HARNESS_REQUEST: VerificationRequest = {
  id: brandId<"VerificationRequestId">("truth-harness-request"),
  projectId: HARNESS_PROJECT_ID,
  snapshotId: HARNESS_SNAPSHOT_ID,
  changeSetId: brandId<"ChangeSetId">("truth-harness-changeset"),
  requestedBy: { type: "system" },
  mode: "manual",
  requestedChecks: [],
  policyId: brandId<"PolicyId">("policy.default"),
  priority: 0,
  createdAt: "2026-09-05T00:00:00Z",
};

const HARNESS_JOB: VerificationJob = {
  id: brandId<"VerificationJobId">("truth-harness-job"),
  requestId: brandId<"VerificationRequestId">("truth-harness-request"),
  attempt: 1,
  status: "completed",
};

/**
 * Runs the full verification pipeline against a truth-matrix fixture using
 * the deterministic test execution adapter.
 *
 * Components reused from the existing codebase:
 *   - Detection: createProjectDetectionService() from @verify-agent/adapters-lang
 *   - Planning:  createCheckPlanner() from @verify-agent/checks
 *   - Execution: createCheckExecutor() from @verify-agent/engine
 *   - Aggregation: aggregateVerification() from @verify-agent/engine
 *
 * Components substituted for test purposes:
 *   - SandboxExecutor: replaced by createDeterministicTestExecutor()
 *
 * The execution source is always "simulated". This harness does not execute
 * arbitrary fixture code, access the network, or invoke a real sandbox.
 */
export async function runTruthHarness(
  input: TruthHarnessInput,
): Promise<TruthHarnessOutput> {
  const detectionContext: DetectionContext = createFileSystemDetectionContext(
    input.fixturePath,
  );
  const detectionService = createProjectDetectionService();
  const planner = createCheckPlanner();
  const executor = createDeterministicTestExecutor(
    input.scenario,
    input.expectedCheckOutcomes,
  );

  // Run detection and planning first to determine applicable check IDs.
  // The pipeline defaults to typescript.typecheck when no selectedCheckIds
  // are provided, which fails for Rust fixtures.
  const detected = detectionService.detect(
    HARNESS_PROJECT,
    HARNESS_SNAPSHOT,
    detectionContext,
  );
  const plan = planner.plan(detected.profile);
  const applicableCheckIds = plan.items
    .filter((item) => item.applicability === "applicable")
    .map((item) => item.checkId);

  const pipeline = createVerificationPipeline({
    detector: {
      detect() {
        return detected;
      },
    },
    planner,
    executor,
  });

  const pipelineOutput = await pipeline.verify({
    project: HARNESS_PROJECT,
    snapshot: HARNESS_SNAPSHOT,
    changeSet: HARNESS_CHANGESET,
    detectionContext,
    selectedCheckIds: applicableCheckIds,
    jobId: String(HARNESS_JOB.id),
    executionId: "truth-harness-execution",
    resultId: "truth-harness-result",
    createdAt: HARNESS_REQUEST.createdAt,
  });

  const aggregationInput = aggregationInputFromPipeline(
    pipelineOutput,
    HARNESS_REQUEST,
    HARNESS_JOB,
    {
      verificationId: "truth-harness-verification",
      createdAt: HARNESS_REQUEST.createdAt,
    },
  );

  const aggregationOutput = aggregateVerification(aggregationInput);

  return {
    scenario: input.scenario,
    detectionProfile: pipelineOutput.profile,
    plan: pipelineOutput.plan,
    pipelineOutput,
    verificationResult: aggregationOutput.result,
    evidence: aggregationOutput.evidence,
    findings: aggregationOutput.findings,
    policyDecision: aggregationOutput.policyDecision,
  };
}
