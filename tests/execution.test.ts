import { describe, expect, it } from "vitest";
import {
  brandId,
  type CheckDefinition,
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
  createExecutionInputHash,
  createFakeSandboxExecutor,
  mapCheckExecutionToSandboxJobRequest,
  toPublicSandboxJobRequest,
  transitionCheckExecution,
  type SandboxJobResult,
} from "../packages/engine/src/index.js";

const definition = createCheckDefinitionRegistry().find(
  "typescript.typecheck",
)!;
const snapshot: RepositorySnapshot = {
  id: brandId<"RepositorySnapshotId">("snapshot-1"),
  projectId: brandId<"ProjectId">("project-1"),
  source: { provider: "local", reference: "repo-1" },
  sourceState: { type: "commit", value: "abc123" },
  commitSha: "abc123",
  retrievedAt: "2026-08-31T10:00:00Z",
};
const project = {
  id: brandId<"ProjectId">("project-1"),
  name: "fixture",
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

function execution(): CheckExecution {
  return {
    id: brandId<"CheckExecutionId">("execution-1"),
    checkDefinitionId: definition.id,
    jobId: brandId<"VerificationJobId">("job-1"),
    inputsHash: "a".repeat(64),
    status: "queued",
  };
}

function request(overrides: Partial<{ definition: CheckDefinition }> = {}) {
  return {
    project,
    profile,
    snapshot,
    planItem,
    definition: overrides.definition ?? definition,
    execution: execution(),
    resultId: "result-1",
    createdAt: "2026-08-31T10:01:00Z",
  };
}

function sandboxResult(
  status: SandboxJobResult["status"],
  exitCode?: number,
): SandboxJobResult {
  return {
    schemaVersion: "1.0.0",
    jobId: brandId<"VerificationJobId">("job-1"),
    status,
    ...(exitCode === undefined ? {} : { exitCode }),
    durationMs: 25,
    logsRef: "logs/job-1",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 1024, cpuTimeMs: 12 },
    errors: status === "error" ? ["sandbox unavailable"] : [],
  };
}

describe("check execution orchestration", () => {
  it("maps a queued check to a safe structured sandbox request", () => {
    const mapped = mapCheckExecutionToSandboxJobRequest(request());
    expect(mapped).toMatchObject({
      schemaVersion: "1.0.0",
      jobId: "job-1",
      source: { provider: "local", reference: "repo-1" },
      snapshot: "abc123",
      networkPolicy: "none",
      artifactPolicy: "none",
      resourceLimits: {
        timeoutMs: 120_000,
        memoryLimitBytes: 512 * 1024 * 1024,
      },
    });
    expect(mapped.commands[0]).toEqual({
      executable: "pnpm",
      args: ["exec", "tsc", "--noEmit"],
      workingDirectory: ".",
      environment: {},
    });
    expect(toPublicSandboxJobRequest(mapped).commands[0]).toContain(
      '"executable":"pnpm"',
    );
  });

  it("uses trusted specs and never executes the command in the fake", async () => {
    const fake = createFakeSandboxExecutor(sandboxResult("completed", 0));
    const outcome = await createCheckExecutor(fake).execute(request());
    expect(fake.requests).toHaveLength(1);
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.result.status).toBe("passed");
    expect(outcome.result.executionSource).toBe("simulated");
    expect(outcome.result.producer.type).toBe("system");
  });

  it.each([
    ["completed", 0, "passed"],
    ["completed", 2, "failed"],
    ["timed_out", undefined, "timed_out"],
    ["cancelled", undefined, "cancelled"],
    ["error", undefined, "error"],
    ["failed", undefined, "error"],
  ] as const)(
    "maps sandbox %s to check status %s",
    async (sandboxStatus, exitCode, expected) => {
      const fake = createFakeSandboxExecutor(
        sandboxResult(sandboxStatus, exitCode),
      );
      const outcome = await createCheckExecutor(fake).execute(request());
      expect(outcome.result.status).toBe(expected);
    },
  );

  it("enforces the queued-running-terminal lifecycle", () => {
    const queued = execution();
    const running = transitionCheckExecution(queued, "running");
    const completed = transitionCheckExecution(running, "completed");
    expect(running.status).toBe("running");
    expect(completed.status).toBe("completed");
    expect(() => transitionCheckExecution(completed, "running")).toThrow();
  });

  it("creates the same input hash for the same execution inputs", () => {
    const spec = createTrustedExecutionSpecRegistry().find(definition.id)!;
    expect(createExecutionInputHash(request(), spec)).toBe(
      createExecutionInputHash(request(), spec),
    );
    expect(createExecutionInputHash(request(), spec)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects missing trusted execution specifications", async () => {
    const fake = createFakeSandboxExecutor(sandboxResult("completed", 0));
    const unknown = {
      ...definition,
      id: brandId<"CheckId">("unknown.check"),
    };
    await expect(
      createCheckExecutor(fake).execute(request({ definition: unknown })),
    ).rejects.toThrow("No trusted execution specification");
    expect(fake.requests).toHaveLength(0);
  });
});
