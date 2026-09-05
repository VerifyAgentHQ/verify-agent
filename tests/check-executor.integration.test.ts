import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  brandId,
  type CheckExecution,
  type CheckPlanItem,
  type RepositorySnapshot,
} from "../packages/domain/src/index.js";
import {
  createCheckDefinitionRegistry,
  createTrustedExecutionSpecRegistry,
} from "../packages/checks/src/index.js";
import {
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  SubprocessSandboxTransport,
} from "../packages/engine/src/index.js";

const integrationReady =
  process.env.VERIFY_SANDBOX_INTEGRATION === "1" ||
  process.env.VERIFY_SANDBOX_PROCESS !== undefined;

const harnessPath = resolve(
  import.meta.dirname,
  "fixtures/sandbox-harness.mjs",
);
const definition = createCheckDefinitionRegistry().find(
  "typescript.typecheck",
)!;

const snapshot: RepositorySnapshot = {
  id: brandId<"RepositorySnapshotId">("integration-snapshot"),
  projectId: brandId<"ProjectId">("integration-project"),
  source: { provider: "fixture", reference: "batch-40-integration" },
  sourceState: { type: "commit", value: "abc123" },
  commitSha: "abc123",
  retrievedAt: "2026-09-01T10:00:00Z",
};

const project = {
  id: brandId<"ProjectId">("integration-project"),
  name: "integration-fixture",
  root: ".",
};

const profile = {
  projectId: project.id,
  snapshotId: snapshot.id,
  languages: ["typescript"],
  frameworks: [],
  packageManagers: ["pnpm"],
  buildSystems: [],
  testFrameworks: [],
  detectedTools: ["typescript"],
  repositoryStructure: {},
  supportedCapabilities: ["typescript.typecheck"],
  detectionConfidence: 1,
};

const planItem: CheckPlanItem = {
  checkId: definition.id,
  checkVersion: definition.version,
  applicability: "applicable",
  required: true,
  reason: "TypeScript configuration detected.",
  priority: 10,
  dependencies: [],
  scope: "repository",
};

function queuedExecution(
  jobId: string,
  snapshotValue?: string,
): CheckExecution {
  return {
    id: brandId<"CheckExecutionId">(`exec-${jobId}`),
    checkDefinitionId: definition.id,
    jobId: brandId<"VerificationJobId">(jobId),
    inputsHash: "b".repeat(64),
    status: "queued",
    ...(snapshotValue === undefined ? {} : {}),
  };
}

describe("CheckExecutor through SubprocessSandboxTransport", () => {
  it.skipIf(!integrationReady)(
    integrationReady
      ? "executes a check through the real subprocess transport and returns passed"
      : "SKIPPED — VERIFY_SANDBOX_INTEGRATION=1 or VERIFY_SANDBOX_PROCESS is required",
    async () => {
      const transport = new SubprocessSandboxTransport({
        executable: process.env.VERIFY_SANDBOX_PROCESS ?? "node",
        args: process.env.VERIFY_SANDBOX_PROCESS ? undefined : [harnessPath],
        environment: {},
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 15_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const executor = createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      );
      const execution = queuedExecution("batch-40-pass");
      const outcome = await executor.execute({
        project,
        profile,
        snapshot,
        planItem,
        definition,
        execution,
        resultId: "result-batch-40-pass",
        createdAt: "2026-09-01T10:01:00Z",
      });
      expect(transport.executionSource).toBe("real");
      expect(outcome.execution.status).toBe("completed");
      expect(outcome.result.status).toBe("passed");
      expect(outcome.result.executionSource).toBe("real");
      expect(outcome.request.schemaVersion).toBe("1.0.0");
      expect(outcome.request.networkPolicy).toBe("none");
      expect(outcome.request.commands).toHaveLength(1);
    },
  );

  it.skipIf(!integrationReady)(
    integrationReady
      ? "propagates a non-zero exit code as a failed check through the subprocess transport"
      : "SKIPPED — VERIFY_SANDBOX_INTEGRATION=1 or VERIFY_SANDBOX_PROCESS is required",
    async () => {
      const transport = new SubprocessSandboxTransport({
        executable: process.env.VERIFY_SANDBOX_PROCESS ?? "node",
        args: process.env.VERIFY_SANDBOX_PROCESS ? undefined : [harnessPath],
        environment: {},
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 15_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const executor = createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      );
      const execution = queuedExecution("batch-40-fail");
      const snapshotForFail: RepositorySnapshot = {
        ...snapshot,
        sourceState: { type: "snapshot", value: "failed" },
      };
      const outcome = await executor.execute({
        project,
        profile,
        snapshot: snapshotForFail,
        planItem,
        definition,
        execution,
        resultId: "result-batch-40-fail",
        createdAt: "2026-09-01T10:01:00Z",
      });
      expect(transport.executionSource).toBe("real");
      expect(outcome.execution.status).toBe("failed");
      expect(outcome.result.status).toBe("failed");
      expect(outcome.result.executionSource).toBe("real");
    },
  );

  it.skipIf(!integrationReady)(
    integrationReady
      ? "preserves execution provenance through the full CheckExecutor pipeline"
      : "SKIPPED — VERIFY_SANDBOX_INTEGRATION=1 or VERIFY_SANDBOX_PROCESS is required",
    async () => {
      const transport = new SubprocessSandboxTransport({
        executable: process.env.VERIFY_SANDBOX_PROCESS ?? "node",
        args: process.env.VERIFY_SANDBOX_PROCESS ? undefined : [harnessPath],
        environment: {},
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 15_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const executor = createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      );
      const execution = queuedExecution("batch-40-provenance");
      const outcome = await executor.execute({
        project,
        profile,
        snapshot,
        planItem,
        definition,
        execution,
        resultId: "result-batch-40-provenance",
        createdAt: "2026-09-01T10:01:00Z",
      });
      expect(outcome.result.executionSource).toBe("real");
      expect(outcome.execution.executionSource).toBe("real");
      expect(outcome.result.producer).toMatchObject({
        type: "system",
        name: "verify-agent",
      });
    },
  );
});
