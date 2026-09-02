import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  brandId,
  type ChangeSet,
  type RepositorySnapshot,
} from "../packages/domain/src/index.js";
import {
  createFileSystemDetectionContext,
  createProjectDetectionService,
} from "../packages/adapters-lang/src/index.js";
import {
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  FakeSandboxTransport,
  createVerificationPipeline,
  VerificationPipelineError,
  type PublicSandboxJobResult,
  type VerificationPipelineInput,
} from "../packages/engine/src/index.js";

const project = {
  id: brandId<"ProjectId">("pipeline-project"),
  name: "pipeline-fixture",
  root: ".",
};
const snapshot: RepositorySnapshot = {
  id: brandId<"RepositorySnapshotId">("pipeline-snapshot"),
  projectId: project.id,
  source: { provider: "fixture", reference: "pipeline-fixture" },
  sourceState: { type: "snapshot", value: "pipeline-snapshot" },
  retrievedAt: "2026-08-31T10:00:00Z",
};
const changeSet: ChangeSet = {
  id: brandId<"ChangeSetId">("pipeline-change"),
  baseSourceState: { type: "snapshot", value: "base" },
  headSourceState: snapshot.sourceState,
  changedFiles: [],
  additions: 0,
  deletions: 0,
  changeHash: "a".repeat(64),
  issueReferences: [],
};
const result: PublicSandboxJobResult = {
  schemaVersion: "1.0.0",
  jobId: "pipeline-job",
  status: "completed",
  exitCode: 0,
  durationMs: 5,
  logsRef: "fixture://logs/pipeline-job",
  artifactRefs: [],
  resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
  errors: [],
};
const fixtureRoot = resolve("tests/fixtures/execution/typescript-pass");

function input(contextRoot = fixtureRoot): VerificationPipelineInput {
  return {
    project,
    snapshot,
    changeSet,
    detectionContext: createFileSystemDetectionContext(contextRoot),
    jobId: "pipeline-job",
    executionId: "pipeline-execution",
    resultId: "pipeline-result",
    createdAt: "2026-08-31T10:01:00Z",
  };
}

function pipeline(
  response: PublicSandboxJobResult | Error,
  detector = createProjectDetectionService(),
) {
  const transport = new FakeSandboxTransport(
    response instanceof Error ? result : response,
    response instanceof Error ? response : undefined,
  );
  const executor = createCheckExecutor(
    createSandboxExecutorFromTransport(transport),
  );
  return {
    pipeline: createVerificationPipeline({ detector, executor }),
    transport,
  };
}

describe("first end-to-end verification pipeline", () => {
  it("detects, plans, and executes the selected TypeScript typecheck", async () => {
    const { pipeline: service, transport } = pipeline(result);
    const output = await service.verify(input());

    expect(output.profile.languages).toContain("typescript");
    expect(output.plan.snapshotId).toBe(snapshot.id);
    expect(output.plan.items).toContainEqual(
      expect.objectContaining({
        checkId: "typescript.typecheck",
        applicability: "applicable",
      }),
    );
    expect(output.selectedItem.checkId).toBe("typescript.typecheck");
    expect(output.sandboxRequest.snapshot).toBe(snapshot.sourceState.value);
    expect(output.sandboxRequest.networkPolicy).toBe("none");
    expect(output.sandboxRequest.commands[0].executable).toBe("pnpm");
    expect(transport.requests).toHaveLength(1);
    expect(output.checkResult.status).toBe("passed");
    expect(output.checkResult.checkId).toBe("typescript.typecheck");
    expect(output.execution.status).toBe("completed");
  });

  it.each([
    ["completed", 1, "failed"],
    ["timed_out", undefined, "timed_out"],
    ["cancelled", undefined, "cancelled"],
  ] as const)(
    "maps sandbox %s into the corresponding CheckResult status",
    async (status, exitCode, expected) => {
      const { pipeline: service } = pipeline({
        ...result,
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
      });
      const output = await service.verify(input());
      expect(output.checkResult.status).toBe(expected);
    },
  );

  it("returns a controlled error for a transport failure", async () => {
    const { pipeline: service } = pipeline(new Error("transport offline"));
    await expect(service.verify(input())).rejects.toMatchObject({
      name: "VerificationPipelineError",
      code: "execution_failed",
      cause: expect.any(Error),
    });
  });

  it("stops when the selected check is not in the applicable plan", async () => {
    const { pipeline: service } = pipeline(result);
    await expect(
      service.verify({
        ...input(),
        selectedCheckId: brandId<"CheckId">("typescript.typecheck"),
        detectionContext: createFileSystemDetectionContext(
          resolve("tests/fixtures/execution/typescript-fail"),
        ),
      }),
    ).resolves.toBeDefined();
    await expect(
      service.verify({
        ...input(),
        detectionContext: createFileSystemDetectionContext(
          resolve("tests/fixtures/project-detection/rust-basic"),
        ),
      }),
    ).rejects.toMatchObject({
      name: "VerificationPipelineError",
      code: "no_applicable_check",
    });
  });

  it("wraps detection errors and never invokes execution", async () => {
    const transport = new FakeSandboxTransport(result);
    const service = createVerificationPipeline({
      detector: {
        detect() {
          throw new Error("detector unavailable");
        },
      },
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    });
    await expect(service.verify(input())).rejects.toMatchObject({
      name: "VerificationPipelineError",
      code: "detection_failed",
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("keeps snapshot identity and deterministic output stable", async () => {
    const first = await pipeline(result).pipeline.verify(input());
    const second = await pipeline(result).pipeline.verify(input());
    expect(first.snapshot.id).toBe(snapshot.id);
    expect(first.profile.snapshotId).toBe(snapshot.id);
    expect(first.plan.snapshotId).toBe(snapshot.id);
    expect(first.sandboxRequest.snapshot).toBe(snapshot.sourceState.value);
    expect(first.checkResult).toEqual(second.checkResult);
    expect(first.plan.contentHash).toBe(second.plan.contentHash);
  });

  it("provisions the execution environment before execution and carries its identity", async () => {
    const { pipeline: service, transport } = pipeline(result);
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
    const output = await createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
      dependencyProvisioner: {
        async provision() {
          return environment;
        },
      },
    }).verify({
      ...input(),
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
        destination: "C:\\temp\\verify-agent-fixture",
      },
    });
    expect(output.provisioningStatus).toBe("ready");
    expect(output.executionEnvironment?.dependencyEnvironment?.artifactId).toBe(
      artifact.artifactId,
    );
    expect(output.execution.dependencyArtifactId).toBe(artifact.artifactId);
    expect(output.checkResult.inputHash).toBeDefined();
  });

  it("does not execute when dependency provisioning fails", async () => {
    const { pipeline: service, transport } = pipeline(result);
    await expect(
      service.verify({
        ...input(),
        dependencyProvisioning: {
          request: {} as never,
          destination: "C:\\temp\\verify-agent-fixture",
        },
      }),
    ).rejects.toMatchObject({ code: "dependency_provisioning_failed" });
    expect(transport.requests).toHaveLength(0);
  });
});
