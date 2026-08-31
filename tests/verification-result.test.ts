import { describe, expect, it } from "vitest";
import {
  aggregateVerification,
  coverageForPlan,
  evidenceForCheckResult,
} from "../packages/engine/src/index.js";
import {
  brandId,
  type CheckPlan,
  type CheckResult,
  type ProjectProfile,
  type VerificationJob,
  type VerificationRequest,
} from "../packages/domain/src/index.js";
import { createDefaultPolicy } from "../packages/policy/src/index.js";

const policy = createDefaultPolicy().policy;
const projectId = brandId<"ProjectId">("aggregate-project");
const snapshotId = brandId<"RepositorySnapshotId">("aggregate-snapshot");
const changeSetId = brandId<"ChangeSetId">("aggregate-change");
const request: VerificationRequest = {
  id: brandId<"VerificationRequestId">("aggregate-request"),
  projectId,
  snapshotId,
  changeSetId,
  requestedBy: { type: "system" },
  mode: "manual",
  requestedChecks: [],
  policyId: policy.id,
  priority: 1,
  createdAt: "2026-08-31T10:00:00Z",
};
const job: VerificationJob = {
  id: brandId<"VerificationJobId">("aggregate-job"),
  requestId: request.id,
  attempt: 1,
  status: "completed",
};
const profile: ProjectProfile = {
  projectId,
  snapshotId,
  languages: ["typescript", "rust"],
  frameworks: [],
  packageManagers: ["pnpm", "cargo"],
  buildSystems: [],
  testFrameworks: [],
  detectedTools: [],
  repositoryStructure: {},
  supportedCapabilities: [
    "typescript.typecheck",
    "typescript.lint",
    "rust.test",
  ],
  detectionConfidence: 1,
};
const plan: CheckPlan = {
  planId: brandId<"CheckPlanId">("aggregate-plan"),
  plannerVersion: "1.0.0",
  projectId,
  snapshotId,
  items: [
    {
      checkId: brandId<"CheckId">("typescript.typecheck"),
      checkVersion: "1.0.0",
      applicability: "applicable",
      required: true,
      reason: "fixture",
      priority: 10,
      dependencies: [],
      scope: "repository",
    },
    {
      checkId: brandId<"CheckId">("typescript.lint"),
      checkVersion: "1.0.0",
      applicability: "applicable",
      required: true,
      reason: "fixture",
      priority: 20,
      dependencies: [],
      scope: "repository",
    },
    {
      checkId: brandId<"CheckId">("rust.test"),
      checkVersion: "1.0.0",
      applicability: "applicable",
      required: true,
      reason: "fixture",
      priority: 30,
      dependencies: [],
      scope: "repository",
    },
  ],
  createdAt: "1970-01-01T00:00:00.000Z",
  contentHash: "c".repeat(64),
};

function result(
  id: string,
  checkId: string,
  status: CheckResult["status"],
): CheckResult {
  return {
    id: brandId<"CheckResultId">(id),
    checkExecutionId: brandId<"CheckExecutionId">(`execution-${id}`),
    checkId: brandId<"CheckId">(checkId),
    checkVersion: "1.0.0",
    status,
    ...(status === "passed" ? { exitCode: 0 } : { exitCode: 1 }),
    durationMs: 10,
    summary: `${checkId} ${status}`,
    artifactRefs: [],
    metrics: {},
    environment: {},
    inputHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    createdAt: "2026-08-31T10:00:00Z",
    producer: { type: "deterministic_tool", name: "fixture", version: "1.0.0" },
    executionSource: "fixture",
  };
}

function aggregate(results: readonly CheckResult[], id = "verification-1") {
  return aggregateVerification({
    request,
    job,
    profile,
    plan,
    checkResults: results,
    verificationId: id,
    createdAt: "2026-08-31T10:02:00Z",
  });
}

describe("deterministic verification result aggregation", () => {
  it("preserves mixed TypeScript and Rust traceability", () => {
    const results = [
      result("result-ts", "typescript.typecheck", "passed"),
      result("result-lint", "typescript.lint", "passed"),
      result("result-rust", "rust.test", "failed"),
    ];
    const output = aggregate(results);
    expect(output.evidence).toHaveLength(3);
    expect(output.findings).toHaveLength(1);
    expect(output.policyDecision.outcome).toBe("block");
    expect(output.result.status).toBe("blocked");
    expect(output.result.snapshotId).toBe(snapshotId);
    expect(output.result.checkResults).toHaveLength(3);
    expect(output.result.evidenceReferences).toContain(output.evidence[0].id);
    expect(output.result.findingReferences).toEqual([output.findings[0].id]);
    expect(output.result.policyDecision).toBe(output.policyDecision.id);
  });

  it("represents skipped or unavailable applicable checks as partial coverage", () => {
    const output = aggregate([
      result("result-ts", "typescript.typecheck", "passed"),
    ]);
    expect(output.result.status).toBe("needs_changes");
    expect(output.result.coverage.verified).toEqual([]);
    expect(output.result.coverage.fixture).toEqual(["typescript.typecheck"]);
    expect(output.result.coverage.partial).toEqual([
      "rust.test",
      "typescript.lint",
    ]);
    const coverage = coverageForPlan(plan, []);
    expect(coverage.partial).toHaveLength(3);
  });

  it("does not mutate prior results and excludes timestamps from result identity", () => {
    const check = result("result-ts", "typescript.typecheck", "passed");
    const first = aggregate([check], "verification-1");
    const second = aggregate([check], "verification-2");
    expect(first.result.id).not.toBe(second.result.id);
    expect(first.result.contentHash).toBe(second.result.contentHash);
    expect(check.status).toBe("passed");
    expect(evidenceForCheckResult(check).contentHash).toBe(
      evidenceForCheckResult(check).contentHash,
    );
  });

  it("keeps required unsupported capabilities from becoming pass", () => {
    const unsupportedPlan: CheckPlan = {
      ...plan,
      items: [
        {
          ...plan.items[0],
          checkId: brandId<"CheckId">("security.analysis"),
          applicability: "unsupported",
          required: true,
        },
      ],
    };
    const output = aggregateVerification({
      request,
      job,
      profile,
      plan: unsupportedPlan,
      checkResults: [],
      verificationId: "verification-unsupported",
      createdAt: "2026-08-31T10:02:00Z",
    });
    expect(output.result.status).toBe("needs_changes");
    expect(output.result.coverage.unsupported).toEqual(["security.analysis"]);
  });

  it("preserves infrastructure errors above policy blocking", () => {
    const output = aggregate([
      result("result-error", "typescript.typecheck", "error"),
    ]);
    expect(output.policyDecision.outcome).toBe("block");
    expect(output.result.status).toBe("error");
  });

  it("does not treat simulated required success as production verification", () => {
    const simulated = {
      ...result("result-simulated", "typescript.typecheck", "passed"),
      executionSource: "simulated" as const,
    };
    const output = aggregate([simulated]);
    expect(output.result.coverage.verified).toEqual([]);
    expect(output.result.coverage.simulated).toEqual(["typescript.typecheck"]);
    expect(output.policyDecision.outcome).toBe("needs_changes");
    expect(output.result.status).toBe("needs_changes");
    expect(output.policyDecision.triggeredRuleIds).toContain(
      "non-real-required-execution",
    );
  });

  it("allows only real successful execution into verified coverage", () => {
    const real = {
      ...result("result-real", "typescript.typecheck", "passed"),
      executionSource: "real" as const,
    };
    const output = aggregate([real]);
    expect(output.result.coverage.verified).toEqual(["typescript.typecheck"]);
    expect(output.result.status).toBe("partial");
  });
});
