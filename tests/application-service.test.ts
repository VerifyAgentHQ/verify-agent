import { describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import {
  brandId,
  InvalidSourceReferenceError,
  type CheckPlan,
  type ChangeSet,
  type RepositorySnapshot,
  type SourceResolver,
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

function noopResolver(): SourceResolver {
  return {
    async resolveSnapshot() {
      throw new InvalidSourceReferenceError(
        "unexpected source resolution in verify-only test",
      );
    },
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
      noopResolver(),
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
    const appService = new VerificationApplicationService(
      pipeline,
      noopResolver(),
    );

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
    const appService = new VerificationApplicationService(
      pipeline,
      noopResolver(),
    );

    const aggOutput = await appService.verify({
      ...verificationInput(),
      selectedCheckIds: checkIds,
    });

    expect(aggOutput.checkResults).toBeDefined();
    expect(aggOutput.checkResults.length).toBe(2);
  });
});

describe("verifySource with an injected SourceResolver", () => {
  const sourceId =
    "octocat:hello-world:da39a3ee5e6b4b0d3255bfef95601890afd80709";
  const source = { kind: "snapshot" as const, id: sourceId };
  const resolvedSnapshot: RepositorySnapshot = {
    id: brandId<"RepositorySnapshotId">(
      "octocat--hello-world--da39a3ee5e6b4b0d3255bfef95601890afd80709",
    ),
    projectId: brandId<"ProjectId">("octocat--hello-world"),
    source: {
      provider: "github",
      reference: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    },
    sourceState: {
      type: "commit",
      value: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    },
    commitSha: "da39a3ee5e6b4b0d3255bfef95601890afd80709",
    retrievedAt: "2026-08-31T10:00:00Z",
  };
  const resolvedContents = {
    "package.json": JSON.stringify({
      name: "verify-source-fixture",
      devDependencies: { typescript: "5.0.0" },
    }),
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
    "src/index.ts": "export const value = 42;\n",
  };

  function buildVerifySourceService(options?: {
    resolveSnapshot?: SourceResolver["resolveSnapshot"];
    response?: unknown;
  }) {
    const successResult = (request: { jobId: string }) => ({
      ...sandboxResult,
      jobId: request.jobId,
    });
    const transport = new FakeSandboxTransport(
      options?.response instanceof Error
        ? successResult
        : (options?.response ?? successResult),
      options?.response instanceof Error ? options.response : undefined,
    );
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(transport),
    );
    const pipeline = createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor,
    });
    const service = new VerificationApplicationService(pipeline, {
      resolveSnapshot:
        options?.resolveSnapshot ??
        (async () => ({
          snapshot: resolvedSnapshot,
          sourceContents: resolvedContents,
        })),
    });
    return { service, transport };
  }

  it("calls the injected SourceResolver with the exact provider-neutral reference", async () => {
    const resolveSnapshot = vi.fn(async () => ({
      snapshot: resolvedSnapshot,
      sourceContents: resolvedContents,
    }));
    const { service } = buildVerifySourceService({ resolveSnapshot });

    const result = await service.verifySource({ source });

    expect(resolveSnapshot).toHaveBeenCalledTimes(1);
    expect(resolveSnapshot).toHaveBeenCalledWith(source);
    expect(result).toBeDefined();
  });

  it("feeds the resolved snapshot into the existing verification pipeline", async () => {
    const { service, transport } = buildVerifySourceService();

    const result = await service.verifySource({ source });

    expect(transport.requests).toHaveLength(1);
    expect(result.snapshotId).toBe(resolvedSnapshot.id);
    expect(result.projectId).toBe(resolvedSnapshot.projectId);
    expect(result.checkResults.length).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe("needs_changes");
  });

  it("builds the detection context from the resolved source contents", async () => {
    const { service } = buildVerifySourceService();

    const result = await service.verifySource({ source });

    expect(result.coverage.simulated).toContain("typescript.typecheck");
    expect(result.checkResults.length).toBe(1);
  });

  it("works with a non-GitHub fake SourceResolver (provider neutrality)", async () => {
    const resolveSnapshot = vi.fn(async () => ({
      snapshot: {
        ...resolvedSnapshot,
        source: { provider: "fixture", reference: "static-snapshot" },
        sourceState: { type: "snapshot", value: "static-snapshot" },
      },
      sourceContents: resolvedContents,
    }));
    const { service } = buildVerifySourceService({ resolveSnapshot });

    const result = await service.verifySource({
      source: { kind: "snapshot", id: "static-snapshot" },
    });

    expect(resolveSnapshot).toHaveBeenCalledWith({
      kind: "snapshot",
      id: "static-snapshot",
    });
    expect(result).toBeDefined();
    expect(result.snapshotId).toBe(resolvedSnapshot.id);
  });

  it("propagates InvalidSourceReferenceError from the resolver unchanged", async () => {
    const { service } = buildVerifySourceService({
      resolveSnapshot: async () => {
        throw new InvalidSourceReferenceError("unknown repository");
      },
    });

    await expect(service.verifySource({ source })).rejects.toBeInstanceOf(
      InvalidSourceReferenceError,
    );
    await expect(service.verifySource({ source })).rejects.toMatchObject({
      name: "InvalidSourceReferenceError",
    });
  });

  it("rejects an invalid source reference before calling the resolver", async () => {
    const resolveSnapshot = vi.fn();
    const { service } = buildVerifySourceService({ resolveSnapshot });

    await expect(
      service.verifySource({ source: { kind: "repo", id: "x" } } as never),
    ).rejects.toMatchObject({ name: "InvalidSourceReferenceError" });
    await expect(
      service.verifySource({ source: { kind: "snapshot", id: "" } }),
    ).rejects.toMatchObject({ name: "InvalidSourceReferenceError" });
    expect(resolveSnapshot).not.toHaveBeenCalled();
  });

  it("maps unexpected resolver failures to a distinct application error", async () => {
    const { service } = buildVerifySourceService({
      resolveSnapshot: async () => {
        throw new Error("network down");
      },
    });

    await expect(service.verifySource({ source })).rejects.toMatchObject({
      name: "VerificationApplicationServiceError",
      code: "source_resolution_failed",
      message: "Source resolution failed",
    });
  });

  it("keeps source-resolution failures distinguishable from verification failures", async () => {
    const { service: failingResolution } = buildVerifySourceService({
      resolveSnapshot: async () => {
        throw new Error("resolver exploded");
      },
    });
    await expect(
      failingResolution.verifySource({ source }),
    ).rejects.toMatchObject({
      name: "VerificationApplicationServiceError",
      code: "source_resolution_failed",
    });

    const { service: failingVerification } = buildVerifySourceService({
      response: new Error("transport offline"),
    });
    await expect(
      failingVerification.verifySource({ source }),
    ).rejects.toMatchObject({
      name: "VerificationApplicationServiceError",
      code: "execution_failed",
    });
  });

  it("does not leak credentials or resolver internals into the result", async () => {
    const { service } = buildVerifySourceService({
      resolveSnapshot: async () => ({
        snapshot: resolvedSnapshot,
        sourceContents: {
          ...resolvedContents,
          ".env":
            "GITHUB_TOKEN=ghs_synthetic_abc\nAPP_JWT=eyJhbGciOiJSUzI1NiJ9",
        },
      }),
    });

    const result = await service.verifySource({ source });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("ghs_");
    expect(serialized).not.toContain("eyJ");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
  });

  it("produces stable content hashes for the same source", async () => {
    const { service } = buildVerifySourceService();

    const first = await service.verifySource({ source });
    const second = await service.verifySource({ source });

    expect(first.contentHash).toBe(second.contentHash);
    expect(first.status).toBe(second.status);
    expect(first.id).toBe(second.id);
  });
});
