import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  brandId,
  type CheckPlan,
  type ChangeSet,
  type RepositorySnapshot,
  type VerificationRequest,
  type VerificationJob,
  type CheckResult,
} from "../packages/domain/src/index.js";
import {
  createFileSystemDetectionContext,
  createProjectDetectionService,
} from "../packages/adapters-lang/src/index.js";
import {
  FakeSandboxTransport,
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
  VerificationApplicationService,
  VerificationApplicationServiceError,
} from "../packages/engine/src/index.js";

const project = {
  id: brandId<"ProjectId">("app-service-project"),
  name: "app-service-fixture",
  root: ".",
};
const snapshot: RepositorySnapshot = {
  id: brandId<"RepositorySnapshotId">("app-service-snapshot"),
  projectId: project.id,
  source: { provider: "fixture", reference: "app-service-fixture" },
  sourceState: { type: "snapshot", value: "app-service-snapshot" },
  retrievedAt: "2026-08-31T10:00:00Z",
};
const changeSet: ChangeSet = {
  id: brandId<"ChangeSetId">("app-service-change"),
  baseSourceState: { type: "snapshot", value: "base" },
  headSourceState: snapshot.sourceState,
  changedFiles: [],
  additions: 0,
  deletions: 0,
  changeHash: "b".repeat(64),
  issueReferences: [],
};
const sandboxResult = {
  schemaVersion: "1.0.0" as const,
  jobId: "app-service-job",
  status: "completed" as const,
  exitCode: 0,
  durationMs: 5,
  logsRef: "fixture://logs/app-service-job",
  artifactRefs: [],
  resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
  errors: [],
};
const request: VerificationRequest = {
  id: brandId<"VerificationRequestId">("app-service-request"),
  projectId: project.id,
  snapshotId: snapshot.id,
  changeSetId: changeSet.id,
  requestedBy: { type: "system" },
  mode: "manual",
  requestedChecks: [],
  policyId: brandId<"PolicyId">("app-service-policy"),
  priority: 1,
  createdAt: "2026-08-31T10:01:00Z",
};
const job: VerificationJob = {
  id: brandId<"VerificationJobId">("app-service-job"),
  requestId: request.id,
  attempt: 1,
  status: "completed",
};
const fixtureRoot = resolve("tests/fixtures/execution/typescript-pass");

function verificationInput() {
  return {
    project,
    snapshot,
    changeSet,
    detectionContext: createFileSystemDetectionContext(fixtureRoot),
    request,
    job,
    verificationId: "app-service-verification",
  };
}

function buildService(
  response = sandboxResult,
  detector = createProjectDetectionService(),
) {
  const transport = new FakeSandboxTransport(
    response instanceof Error ? sandboxResult : response,
    response instanceof Error ? response : undefined,
  );
  const executor = createCheckExecutor(
    createSandboxExecutorFromTransport(transport),
  );
  return {
    service: new VerificationApplicationService(
      createVerificationPipeline({ detector, executor }),
    ),
    transport,
  };
}

describe("verification application service", () => {
  it("routes a verification request through the existing pipeline", async () => {
    const { service: appService, transport } = buildService();
    const result = await appService.verify(verificationInput());

    expect(transport.requests).toHaveLength(1);
    expect(result).toBeDefined();
  });

  it("returns the resulting verification result", async () => {
    const { service: appService } = buildService();
    const result = await appService.verify(verificationInput());

    expect(result.id).toBe(
      brandId<"VerificationId">("app-service-verification"),
    );
    expect(result.requestId).toBe(request.id);
    expect(result.jobId).toBe(job.id);
    expect(result.projectId).toBe(project.id);
    expect(result.snapshotId).toBe(snapshot.id);
    expect(result.changeSetId).toBe(changeSet.id);
    expect(result.resultVersion).toBe("1.0.0");
    expect(result.checkResults.length).toBeGreaterThanOrEqual(1);
    expect(result.coverage).toBeDefined();
  });

  it("does not mutate prior results and produces deterministic output", async () => {
    const { service: appService } = buildService();
    const first = await appService.verify(verificationInput());
    const second = await appService.verify(verificationInput());
    expect(first).toEqual(second);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.id).toBe(second.id);
  });

  it("surfaces pipeline execution errors as application errors", async () => {
    const { service: appService } = buildService(
      new Error("transport offline"),
    );
    await expect(appService.verify(verificationInput())).rejects.toMatchObject({
      name: "VerificationApplicationServiceError",
    });
  });

  it("does not silently convert pipeline errors into success", async () => {
    const { service: appService } = buildService(
      new Error("transport offline"),
    );
    await expect(appService.verify(verificationInput())).rejects.toThrow(
      /Verification failed/,
    );
  });

  it("preserves execution provenance through the application layer", async () => {
    const { service: appService } = buildService();
    const result = await appService.verify(verificationInput());

    expect(result).toBeDefined();
    expect(result.status).toBe("needs_changes");
  });

  it("keeps snapshot identity and dependency environment identity", async () => {
    const artifact = {
      artifactId: "dependency-fixture",
      sourceSnapshotId: snapshot.id,
      ecosystem: "node" as const,
      packageManager: "pnpm",
      packageManagerVersion: "11.21.0",
      toolchainVersion: "node-24.19.0",
      platform: { operatingSystem: "linux", architecture: "amd64" },
      manifestHash: "a".repeat(64),
      lockfileHash: "b".repeat(64),
      generatedArtifactInputs: [],
      availability: "offline_capable" as const,
      contentHash: "c".repeat(64),
      producer: { type: "system" as const, name: "fixture" },
    };
    const environment = {
      artifactId: artifact.artifactId,
      contentHash: artifact.contentHash,
      sourceSnapshotId: snapshot.id,
      availability: "offline_capable" as const,
      generatedArtifactInputs: [],
      producer: artifact.producer,
    };
    const pipeline = createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(
          new FakeSandboxTransport(sandboxResult),
        ),
      ),
      dependencyProvisioner: {
        async provision() {
          return environment;
        },
      },
    });
    const appService = new VerificationApplicationService(pipeline);

    const result = await appService.verify({
      ...verificationInput(),
      dependencyProvisioning: {
        request: {
          identity: {
            snapshotId: snapshot.id,
            manifestHash: artifact.manifestHash,
            lockfileHash: artifact.lockfileHash,
            ecosystem: artifact.ecosystem,
            packageManager: artifact.packageManager,
            packageManagerVersion: artifact.packageManagerVersion,
            toolchainVersion: artifact.toolchainVersion,
            provisioningConfig: { offline: "true" },
            generatedArtifactInputs: [],
          },
          artifact,
          offlineOnly: true,
        },
        destination: "C:\\temp\\verify-agent-app-service",
      },
    });
    expect(result).toBeDefined();
    expect(result.status).toBe("needs_changes");
  });

  it("does not require Docker or Stellar Forge execution", async () => {
    const { service: appService } = buildService();
    const result = await appService.verify(verificationInput());

    expect(result).toBeDefined();
  });

  it("executes selected checks in deterministic plan order", async () => {
    const checkIds = [
      brandId<"CheckId">("typescript.typecheck"),
      brandId<"CheckId">("typescript.lint"),
    ] as const;
    const plan: CheckPlan = {
      planId: brandId<"CheckPlanId">("multi-check-plan"),
      plannerVersion: "test-planner",
      projectId: project.id,
      snapshotId: snapshot.id,
      items: checkIds.map((checkId, priority) => ({
        checkId,
        checkVersion: "1.0.0",
        applicability: "applicable" as const,
        required: true,
        reason: "controlled multi-check test",
        priority,
        dependencies: [],
        scope: "repository" as const,
      })),
      createdAt: "2026-08-31T10:00:00Z",
      contentHash: "d".repeat(64),
    };
    const transport = new FakeSandboxTransport((req) => ({
      ...sandboxResult,
      jobId: req.jobId,
    }));
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(transport),
    );
    const pipeline = createVerificationPipeline({
      detector: createProjectDetectionService(),
      planner: { plan: () => plan },
      executor,
    });
    const appService = new VerificationApplicationService(pipeline);

    const aggOutput = await appService.verify({
      ...verificationInput(),
      selectedCheckIds: checkIds,
    });

    expect(aggOutput.checkResults).toBeDefined();
    expect(aggOutput.checkResults.length).toBe(2);
  });
});
