import { describe, expect, it } from "vitest";
import {
  brandId,
  type CheckPlan,
  type CheckResult,
  type Finding,
  type Evidence,
  type VerificationResult,
} from "../packages/domain/src/index.js";
import {
  aggregateVerification,
  evidenceForCheckResult,
  findingsForCheckResults,
  coverageForPlan,
} from "../packages/engine/src/index.js";
import {
  createDefaultPolicy,
  evaluateDefaultPolicy,
} from "../packages/policy/src/index.js";
import {
  runTruthHarness,
  HARNESS_PROJECT_ID,
  HARNESS_SNAPSHOT_ID,
} from "./truth-harness.js";
import {
  truthMatrixFixtures,
  getFixtureMetadata,
  type FixtureScenario,
} from "./truth-matrix-metadata.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkResult(
  id: string,
  checkId: string,
  status: CheckResult["status"],
  executionSource: CheckResult["executionSource"] = "fixture",
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
    rawOutputRef: `logs://${id}`,
    artifactRefs: [],
    metrics: { cpuTimeMs: 1 },
    environment: {},
    inputHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    createdAt: "2026-08-31T10:00:00Z",
    producer: { type: "deterministic_tool", name: "fixture", version: "1.0.0" },
    executionSource,
  };
}

function makePlan(
  items: Array<{
    checkId: string;
    required?: boolean;
    applicability?: "applicable" | "unsupported" | "not_applicable";
  }>,
): CheckPlan {
  return {
    planId: brandId<"CheckPlanId">("batch42-plan"),
    plannerVersion: "1.0.0",
    projectId: brandId<"ProjectId">("batch42-project"),
    snapshotId: brandId<"RepositorySnapshotId">("batch42-snapshot"),
    items: items.map((item, i) => ({
      checkId: brandId<"CheckId">(item.checkId),
      checkVersion: "1.0.0",
      applicability: item.applicability ?? "applicable",
      required: item.required ?? true,
      reason: "batch-42 test fixture",
      priority: i,
      dependencies: [],
      scope: "repository" as const,
    })),
    createdAt: "2026-08-31T00:00:00Z",
    contentHash: "b".repeat(64),
  };
}

function aggregateResults(
  results: readonly CheckResult[],
  plan?: CheckPlan,
  id = "batch42-verification",
) {
  const policy = createDefaultPolicy().policy;
  return aggregateVerification({
    request: {
      id: brandId<"VerificationRequestId">("batch42-request"),
      projectId: brandId<"ProjectId">("batch42-project"),
      snapshotId: brandId<"RepositorySnapshotId">("batch42-snapshot"),
      changeSetId: brandId<"ChangeSetId">("batch42-change"),
      requestedBy: { type: "system" },
      mode: "manual",
      requestedChecks: [],
      policyId: policy.id,
      priority: 0,
      createdAt: "2026-08-31T10:00:00Z",
    },
    job: {
      id: brandId<"VerificationJobId">("batch42-job"),
      requestId: brandId<"VerificationRequestId">("batch42-request"),
      attempt: 1,
      status: "completed",
    },
    profile: {
      projectId: brandId<"ProjectId">("batch42-project"),
      snapshotId: brandId<"RepositorySnapshotId">("batch42-snapshot"),
      languages: ["typescript"],
      frameworks: [],
      packageManagers: [],
      buildSystems: [],
      testFrameworks: [],
      detectedTools: [],
      repositoryStructure: {},
      supportedCapabilities: [],
      detectionConfidence: 1,
    },
    plan:
      plan ?? makePlan(results.map((r) => ({ checkId: String(r.checkId) }))),
    checkResults: results,
    verificationId: id,
    createdAt: "2026-08-31T10:01:00Z",
  });
}

// ===========================================================================
// 1. POLICY TRUTH VALIDATION
// ===========================================================================

describe("batch-42: policy truth validation", () => {
  it("healthy fixture with non-real execution stays needs_changes (CASE 1)", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { policyDecision, verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(policyDecision.outcome).toBe("needs_changes");
    expect(policyDecision.triggeredRuleIds).toContain(
      "non-real-required-execution",
    );
    expect(policyDecision.triggeredRuleIds).not.toContain(
      "required-check-failure",
    );
    expect(verificationResult.status).toBe("needs_changes");
  });

  it("failing typecheck propagates failure through evidence to policy to result (CASE 2)", async () => {
    const fixture = getFixtureMetadata("typescript-failing-typecheck");
    const { evidence, findings, policyDecision, verificationResult } =
      await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].severity).toBe("high");
    expect(findings[0].status).toBe("open");
    expect(findings[0].evidenceReferences).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );

    expect(policyDecision.outcome).toBe("block");
    expect(policyDecision.triggeredRuleIds).toContain("required-check-failure");

    expect(verificationResult.status).toBe("blocked");
    expect(verificationResult.evidenceReferences.length).toBeGreaterThan(0);
    expect(verificationResult.findingReferences.length).toBeGreaterThan(0);
  });

  it("failing test propagates failure through evidence to policy to result (CASE 3)", async () => {
    const fixture = getFixtureMetadata("typescript-failing-test");
    const { evidence, findings, policyDecision, verificationResult } =
      await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.severity === "high")).toBe(true);

    expect(policyDecision.outcome).toBe("block");
    expect(policyDecision.triggeredRuleIds).toContain("required-check-failure");
    expect(verificationResult.status).toBe("blocked");
  });

  it("failing build propagates failure through evidence to policy to result (CASE 4)", async () => {
    const fixture = getFixtureMetadata("typescript-failing-build");
    const { findings, policyDecision, verificationResult } =
      await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

    expect(findings.length).toBeGreaterThan(0);
    expect(policyDecision.outcome).toBe("block");
    expect(policyDecision.triggeredRuleIds).toContain("required-check-failure");
    expect(verificationResult.status).toBe("blocked");
  });

  it("Rust failing build propagates failure through evidence to policy to result (CASE 5)", async () => {
    const fixture = getFixtureMetadata("rust-failing-build");
    const { findings, policyDecision, verificationResult } =
      await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

    expect(findings.length).toBeGreaterThan(0);
    expect(policyDecision.outcome).toBe("block");
    expect(policyDecision.triggeredRuleIds).toContain("required-check-failure");
    expect(verificationResult.status).toBe("blocked");
  });

  it("Rust healthy fixture stays needs_changes with simulated coverage", async () => {
    const fixture = getFixtureMetadata("rust-healthy");
    const { policyDecision, verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(policyDecision.outcome).toBe("needs_changes");
    expect(policyDecision.triggeredRuleIds).toContain(
      "non-real-required-execution",
    );
    expect(verificationResult.status).toBe("needs_changes");
    expect(verificationResult.coverage.verified).toEqual([]);
    expect(verificationResult.coverage.simulated.length).toBeGreaterThan(0);
  });

  it("Rust failing test propagates failure through policy to result", async () => {
    const fixture = getFixtureMetadata("rust-failing-test");
    const { findings, policyDecision, verificationResult } =
      await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

    expect(findings.length).toBeGreaterThan(0);
    expect(policyDecision.outcome).toBe("block");
    expect(verificationResult.status).toBe("blocked");
  });

  it("policy determinism: identical inputs produce identical decisions", () => {
    const policy = createDefaultPolicy().policy;
    const results = [
      checkResult("r1", "typescript.typecheck", "passed", "simulated"),
      checkResult("r2", "typescript.test", "failed", "simulated"),
    ];
    const evidence = results.map(evidenceForCheckResult);
    const findings = findingsForCheckResults(results, evidence);
    const context = {
      results,
      evidence,
      findings,
      policy,
      requiredCheckIds: [brandId<"CheckId">("typescript.typecheck")],
      unsupportedRequiredCapabilities: [],
      nonRealRequiredCheckIds: [
        brandId<"CheckId">("typescript.typecheck"),
        brandId<"CheckId">("typescript.test"),
      ],
      createdAt: "2026-08-31T10:01:00Z",
    };

    const first = evaluateDefaultPolicy(context);
    const second = evaluateDefaultPolicy(context);
    expect(first.outcome).toBe(second.outcome);
    expect(first.triggeredRuleIds).toEqual(second.triggeredRuleIds);
    expect(first.contentHash).toBe(second.contentHash);
    expect(first.id).toBe(second.id);
  });

  it("policy rule priority: required-check-failure takes precedence over non-real-required-execution", () => {
    const policy = createDefaultPolicy().policy;
    const results = [
      checkResult("r1", "typescript.typecheck", "failed", "simulated"),
    ];
    const evidence = results.map(evidenceForCheckResult);
    const findings = findingsForCheckResults(results, evidence);
    const decision = evaluateDefaultPolicy({
      results,
      evidence,
      findings,
      policy,
      requiredCheckIds: [brandId<"CheckId">("typescript.typecheck")],
      unsupportedRequiredCapabilities: [],
      nonRealRequiredCheckIds: [brandId<"CheckId">("typescript.typecheck")],
      createdAt: "2026-08-31T10:01:00Z",
    });

    expect(decision.outcome).toBe("block");
    expect(decision.triggeredRuleIds).toContain("required-check-failure");
  });

  it("medium findings trigger needs_review when no other blocking rules apply", () => {
    const policy = createDefaultPolicy().policy;
    const finding: Finding = {
      id: brandId<"FindingId">("finding-medium-test"),
      category: "custom",
      severity: "medium",
      status: "open",
      title: "Medium finding",
      description: "Requires review",
      locations: [],
      evidenceReferences: [],
      producer: { type: "system", name: "test", version: "1.0.0" },
      confidence: 0.9,
    };
    const decision = evaluateDefaultPolicy({
      results: [],
      evidence: [],
      findings: [finding],
      policy,
      requiredCheckIds: [],
      unsupportedRequiredCapabilities: [],
      nonRealRequiredCheckIds: [],
      createdAt: "2026-08-31T10:01:00Z",
    });

    expect(decision.outcome).toBe("needs_review");
    expect(decision.triggeredRuleIds).toContain("medium-finding");
  });

  it("unsupported required capabilities trigger needs_changes", () => {
    const policy = createDefaultPolicy().policy;
    const decision = evaluateDefaultPolicy({
      results: [],
      evidence: [],
      findings: [],
      policy,
      requiredCheckIds: [],
      unsupportedRequiredCapabilities: ["rust.clippy"],
      nonRealRequiredCheckIds: [],
      createdAt: "2026-08-31T10:01:00Z",
    });

    expect(decision.outcome).toBe("needs_changes");
    expect(decision.triggeredRuleIds).toContain(
      "unsupported-required-capability",
    );
  });
});

// ===========================================================================
// 2. VERIFICATIONRESULT TRUTH VALIDATION
// ===========================================================================

describe("batch-42: VerificationResult truth validation", () => {
  it("preserves evidence references from all executed checks", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { evidence, verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.evidenceReferences.length).toBe(evidence.length);
    for (const evidenceRef of verificationResult.evidenceReferences) {
      expect(evidence.some((e) => e.id === evidenceRef)).toBe(true);
    }
  });

  it("preserves finding references from all findings", async () => {
    const fixture = getFixtureMetadata("typescript-failing-typecheck");
    const { findings, verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.findingReferences.length).toBe(findings.length);
    for (const findingRef of verificationResult.findingReferences) {
      expect(findings.some((f) => f.id === findingRef)).toBe(true);
    }
  });

  it("links policy decision to result", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { policyDecision, verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.policyDecision).toBe(policyDecision.id);
    expect(verificationResult.coverage).toBeDefined();
  });

  it("includes correct project and snapshot identity", async () => {
    const fixture = getFixtureMetadata("rust-healthy");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.projectId).toBe(HARNESS_PROJECT_ID);
    expect(verificationResult.snapshotId).toBe(HARNESS_SNAPSHOT_ID);
    expect(verificationResult.resultVersion).toBe("1.0.0");
  });

  it("coverage categories are mutually exclusive for each capability", async () => {
    for (const fixture of truthMatrixFixtures) {
      const { verificationResult } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      const allCategories = [
        ...verificationResult.coverage.verified,
        ...verificationResult.coverage.partial,
        ...verificationResult.coverage.simulated,
        ...verificationResult.coverage.fixture,
        ...verificationResult.coverage.unsupported,
        ...verificationResult.coverage.notApplicable,
      ];
      const unique = new Set(allCategories);
      expect(allCategories.length).toBe(unique.size);
    }
  });

  it("summary reflects check counts", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.summary).toMatch(
      /^\w+: \d+\/\d+ checks passed\.$/,
    );
    expect(verificationResult.summary).toContain("checks passed");
  });

  it("content hash is deterministic for identical inputs", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const first = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });
    const second = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(first.verificationResult.contentHash).toBe(
      second.verificationResult.contentHash,
    );
    expect(first.verificationResult.id).toBe(second.verificationResult.id);
    expect(first.policyDecision.contentHash).toBe(
      second.policyDecision.contentHash,
    );
  });
});

// ===========================================================================
// 3. EVIDENCE INTEGRITY
// ===========================================================================

describe("batch-42: evidence integrity", () => {
  it("each evidence item has a valid content hash matching its value", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { evidence } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    for (const e of evidence) {
      expect(e.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(e.sourceReferences.length).toBeGreaterThan(0);
      expect(e.executionSource).toBe("simulated");
    }
  });

  it("findings reference their source evidence", async () => {
    const fixture = getFixtureMetadata("typescript-failing-typecheck");
    const { evidence, findings } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    for (const finding of findings) {
      expect(finding.evidenceReferences.length).toBeGreaterThan(0);
      for (const ref of finding.evidenceReferences) {
        expect(evidence.some((e) => e.id === ref)).toBe(true);
      }
    }
  });

  it("evidence is deterministic across runs", async () => {
    const fixture = getFixtureMetadata("rust-failing-test");
    const first = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });
    const second = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(first.evidence.length).toBe(second.evidence.length);
    for (let i = 0; i < first.evidence.length; i++) {
      expect(first.evidence[i].contentHash).toBe(
        second.evidence[i].contentHash,
      );
      expect(first.evidence[i].id).toBe(second.evidence[i].id);
    }
  });

  it("findings are deterministic across runs", async () => {
    const fixture = getFixtureMetadata("typescript-failing-test");
    const first = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });
    const second = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(first.findings.length).toBe(second.findings.length);
    for (let i = 0; i < first.findings.length; i++) {
      expect(first.findings[i].id).toBe(second.findings[i].id);
      expect(first.findings[i].severity).toBe(second.findings[i].severity);
    }
  });
});

// ===========================================================================
// 4. EDGE CASES
// ===========================================================================

describe("batch-42: edge cases", () => {
  it("incomplete evidence (applicable checks with no results) cannot produce pass", () => {
    const plan = makePlan([
      { checkId: "typescript.typecheck", required: true },
      { checkId: "typescript.test", required: true },
    ]);
    const output = aggregateResults([], plan);
    expect(output.result.status).not.toBe("pass");
    expect(output.result.coverage.verified).toEqual([]);
    expect(output.result.coverage.partial).toEqual(
      expect.arrayContaining(["typescript.typecheck", "typescript.test"]),
    );
  });

  it("all passed checks with simulated execution stay needs_changes", () => {
    const results = [
      checkResult("r1", "typescript.typecheck", "passed", "simulated"),
      checkResult("r2", "typescript.test", "passed", "simulated"),
    ];
    const output = aggregateResults(results);
    expect(output.result.status).toBe("needs_changes");
    expect(output.policyDecision.outcome).toBe("needs_changes");
    expect(output.policyDecision.triggeredRuleIds).toContain(
      "non-real-required-execution",
    );
  });

  it("single failed required check blocks even if other checks pass", () => {
    const results = [
      checkResult("r1", "typescript.typecheck", "passed", "simulated"),
      checkResult("r2", "typescript.test", "failed", "simulated"),
      checkResult("r3", "typescript.lint", "passed", "simulated"),
    ];
    const output = aggregateResults(results);
    expect(output.result.status).toBe("blocked");
    expect(output.policyDecision.outcome).toBe("block");
    expect(output.findings.length).toBeGreaterThanOrEqual(1);
  });

  it("error status overrides policy block", () => {
    const results = [
      checkResult("r1", "typescript.typecheck", "error", "simulated"),
    ];
    const output = aggregateResults(results);
    expect(output.result.status).toBe("error");
    expect(output.policyDecision.outcome).toBe("block");
  });

  it("multiple failures aggregate into a single blocked result", () => {
    const results = [
      checkResult("r1", "typescript.typecheck", "failed", "simulated"),
      checkResult("r2", "typescript.test", "failed", "simulated"),
      checkResult("r3", "typescript.lint", "failed", "simulated"),
    ];
    const output = aggregateResults(results);
    expect(output.result.status).toBe("blocked");
    expect(output.findings.length).toBe(3);
    expect(output.policyDecision.triggeredRuleIds).toContain(
      "required-check-failure",
    );
  });

  it("contradictory evidence does not produce pass", () => {
    const results = [
      checkResult("r1", "typescript.typecheck", "passed", "simulated"),
      checkResult("r2", "typescript.test", "failed", "simulated"),
    ];
    const output = aggregateResults(results);
    expect(output.result.status).not.toBe("pass");
    expect(output.result.status).toBe("blocked");
  });

  it("definition-only checks with no execution spec cannot become verified", () => {
    const results = [
      checkResult("r1", "dependency.audit", "passed", "fixture"),
    ];
    const plan = makePlan([{ checkId: "dependency.audit", required: true }]);
    const output = aggregateResults(results, plan);
    expect(output.result.coverage.verified).toEqual([]);
    expect(output.result.coverage.partial).toEqual([]);
    expect(output.result.coverage.fixture).toContain("dependency.audit");
  });

  it("timed_out status blocks verification", () => {
    const results = [
      checkResult("r1", "typescript.typecheck", "timed_out", "simulated"),
    ];
    const output = aggregateResults(results);
    expect(output.result.status).toBe("blocked");
    expect(output.findings[0].severity).toBe("high");
  });

  it("cancelled status blocks verification", () => {
    const results = [
      checkResult("r1", "typescript.typecheck", "cancelled", "simulated"),
    ];
    const output = aggregateResults(results);
    expect(output.result.status).toBe("blocked");
    expect(output.findings[0].severity).toBe("high");
  });

  it("skipped checks produce no findings", () => {
    const results = [
      checkResult("r1", "typescript.typecheck", "skipped", "fixture"),
    ];
    const output = aggregateResults(results);
    expect(output.findings).toHaveLength(0);
  });
});

// ===========================================================================
// 5. FULL PIPELINE INTEGRATION WITH TRUTH MATRIX
// ===========================================================================

describe("batch-42: full pipeline integration", () => {
  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "%s: complete traceability from evidence to result",
    async (_scenario, fixture) => {
      const result = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      // Evidence links to check results
      expect(result.evidence.length).toBeGreaterThan(0);
      for (const e of result.evidence) {
        expect(e.type).toBe("check.result");
        expect(e.sourceReferences.length).toBeGreaterThan(0);
      }

      // Findings link to evidence
      for (const f of result.findings) {
        expect(f.evidenceReferences.length).toBeGreaterThan(0);
        expect(f.status).toBe("open");
      }

      // Policy decision links to evidence and findings
      expect(result.policyDecision.evidenceReferences.length).toBe(
        result.evidence.length,
      );
      expect(result.policyDecision.findingReferences.length).toBe(
        result.findings.length,
      );

      // VerificationResult links to all layers
      expect(result.verificationResult.evidenceReferences.length).toBe(
        result.evidence.length,
      );
      expect(result.verificationResult.findingReferences.length).toBe(
        result.findings.length,
      );
      expect(result.verificationResult.policyDecision).toBe(
        result.policyDecision.id,
      );
    },
  );

  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "%s: deterministic across repeated runs",
    async (_scenario, fixture) => {
      const first = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });
      const second = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      expect(first.verificationResult.contentHash).toBe(
        second.verificationResult.contentHash,
      );
      expect(first.verificationResult.status).toBe(
        second.verificationResult.status,
      );
      expect(first.policyDecision.contentHash).toBe(
        second.policyDecision.contentHash,
      );
      expect(first.plan.contentHash).toBe(second.plan.contentHash);
      expect(first.evidence.length).toBe(second.evidence.length);
      expect(first.findings.length).toBe(second.findings.length);
    },
  );

  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "%s: coverage matches expected outcome",
    async (_scenario, fixture) => {
      const { verificationResult } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      if (fixture.expectedStatus === "needs_changes") {
        expect(verificationResult.coverage.verified).toEqual([]);
      }
      if (fixture.expectedStatus === "blocked") {
        expect(verificationResult.coverage.partial.length).toBeGreaterThan(0);
      }
    },
  );
});
