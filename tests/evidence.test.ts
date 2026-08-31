import { describe, expect, it } from "vitest";
import {
  brandId,
  type CheckResult,
  type Evidence,
} from "../packages/domain/src/index.js";
import {
  evidenceForCheckResult,
  findingsForCheckResults,
} from "../packages/engine/src/index.js";
import {
  createDefaultPolicy,
  evaluateDefaultPolicy,
} from "../packages/policy/src/index.js";

function checkResult(
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
    rawOutputRef: `logs://${id}`,
    artifactRefs: [],
    metrics: { cpuTimeMs: 1 },
    environment: {},
    inputHash: "a".repeat(64),
    contentHash: "b".repeat(64),
    createdAt: "2026-08-31T10:00:00Z",
    producer: { type: "deterministic_tool", name: "fixture", version: "1.0.0" },
    executionSource: "fixture",
  };
}

describe("deterministic evidence and findings", () => {
  it("normalizes a check result into traceable deterministic evidence", () => {
    const result = checkResult("result-pass", "typescript.typecheck", "passed");
    const first = evidenceForCheckResult(result);
    const second = evidenceForCheckResult(result);
    expect(first).toEqual(second);
    expect(first.sourceReferences).toEqual([
      result.id,
      result.checkExecutionId,
    ]);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.value).not.toHaveProperty("createdAt");
    expect(first.executionSource).toBe("fixture");
    expect(first.value).toMatchObject({ executionSource: "fixture" });
  });

  it.each([
    ["failed", "high"],
    ["timed_out", "high"],
    ["error", "high"],
    ["cancelled", "high"],
  ] as const)(
    "creates an evidence-backed finding for %s",
    (status, severity) => {
      const result = checkResult(`result-${status}`, `rust.${status}`, status);
      const evidence = evidenceForCheckResult(result);
      const findings = findingsForCheckResults([result], [evidence]);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity, status: "open" });
      expect(findings[0].evidenceReferences).toEqual([evidence.id]);
      expect(evidence.executionSource).toBe("fixture");
    },
  );

  it("does not create findings for passed or skipped checks", () => {
    const results = [
      checkResult("result-pass", "typescript.typecheck", "passed"),
      checkResult("result-skip", "typescript.test", "skipped"),
    ];
    const evidence = results.map(evidenceForCheckResult);
    expect(findingsForCheckResults(results, evidence)).toEqual([]);
  });

  it("applies the default policy deterministically", () => {
    const result = checkResult("result-fail", "rust.test", "failed");
    const evidence: Evidence[] = [evidenceForCheckResult(result)];
    const findings = findingsForCheckResults([result], evidence);
    const policy = createDefaultPolicy().policy;
    const context = {
      results: [result],
      evidence,
      findings,
      policy,
      requiredCheckIds: [result.checkId],
      unsupportedRequiredCapabilities: [],
      nonRealRequiredCheckIds: [],
      createdAt: "2026-08-31T10:01:00Z",
    };
    const first = evaluateDefaultPolicy(context);
    const second = evaluateDefaultPolicy(context);
    expect(first.outcome).toBe("block");
    expect(first.triggeredRuleIds).toContain("required-check-failure");
    expect(first).toEqual(second);
    expect(first.contentHash).not.toContain("10:01");
  });

  it("maps unsupported required capabilities to needs_changes", () => {
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
  });
});
