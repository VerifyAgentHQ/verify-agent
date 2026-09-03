import { createHash } from "node:crypto";
import {
  brandId,
  validateEvidence,
  validateFinding,
  validateVerificationResult,
  type CheckPlan,
  type CheckResult,
  type Evidence,
  type EvidenceId,
  type Finding,
  type FindingSeverity,
  type Policy,
  type ProjectProfile,
  type VerificationCoverage,
  type VerificationResult,
  type VerificationRequest,
  type VerificationJob,
} from "@verify-agent/domain";
import {
  createDefaultPolicy,
  evaluateDefaultPolicy,
} from "@verify-agent/policy";
import type { CheckExecutionOutcome } from "./interfaces.js";

const RESULT_VERSION = "1.0.0";
const evidenceProducer = {
  type: "system" as const,
  name: "verify-agent-evidence",
  version: "0.1.0-phase0",
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function evidenceForCheckResult(result: CheckResult): Evidence {
  const content = {
    type: "check.result",
    checkResultId: result.id,
    checkExecutionId: result.checkExecutionId,
    checkId: result.checkId,
    checkVersion: result.checkVersion,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    summary: result.summary,
    rawOutputRef: result.rawOutputRef,
    artifactRefs: [...result.artifactRefs],
    metrics: { ...result.metrics },
    inputHash: result.inputHash,
    executionSource: result.executionSource,
  };
  const contentHash = hash(content);
  const evidence: Evidence = {
    id: brandId<"EvidenceId">(`evidence-${contentHash.slice(0, 24)}`),
    type: "check.result",
    summary: result.summary,
    value: Object.freeze(content),
    sourceReferences: Object.freeze([
      String(result.id),
      String(result.checkExecutionId),
    ]),
    producer: result.producer ?? evidenceProducer,
    createdAt: result.createdAt,
    contentHash,
    executionSource: result.executionSource,
  };
  validateEvidence(evidence);
  return evidence;
}

function findingDetails(result: CheckResult):
  | {
      severity: FindingSeverity;
      title: string;
      description: string;
    }
  | undefined {
  if (result.status === "failed")
    return {
      severity: "high",
      title: `${String(result.checkId)} failed`,
      description: result.summary,
    };
  if (result.status === "timed_out")
    return {
      severity: "high",
      title: `${String(result.checkId)} timed out`,
      description: result.summary,
    };
  if (result.status === "error")
    return {
      severity: "high",
      title: `${String(result.checkId)} encountered an execution error`,
      description: result.summary,
    };
  if (result.status === "cancelled")
    return {
      severity: "high",
      title: `${String(result.checkId)} was cancelled`,
      description:
        "The check did not complete, so its capability could not be verified.",
    };
  return undefined;
}

export function findingsForCheckResults(
  results: readonly CheckResult[],
  evidence: readonly Evidence[],
): Finding[] {
  const evidenceByResult = new Map(
    evidence.map((item) => [String(item.sourceReferences[0]), item]),
  );
  return results.flatMap((result) => {
    const details = findingDetails(result);
    const source = evidenceByResult.get(String(result.id));
    if (!details || !source) return [];
    const content = {
      category: "check",
      checkId: result.checkId,
      status: result.status,
      severity: details.severity,
      title: details.title,
      description: details.description,
      evidenceReferences: [source.id],
    };
    const finding: Finding = {
      id: brandId<"FindingId">(`finding-${hash(content).slice(0, 24)}`),
      ...content,
      status: "open",
      locations: [],
      producer: result.producer,
      confidence: 1,
    };
    validateFinding(finding);
    return [finding];
  });
}

export function coverageForPlan(
  plan: CheckPlan,
  results: readonly CheckResult[],
): VerificationCoverage {
  const resultByCheck = new Map(
    results.map((result) => [String(result.checkId), result]),
  );
  const coverage: {
    verified: string[];
    partial: string[];
    unsupported: string[];
    notApplicable: string[];
    simulated: string[];
    fixture: string[];
  } = {
    verified: [],
    partial: [],
    unsupported: [],
    notApplicable: [],
    simulated: [],
    fixture: [],
  };
  for (const item of plan.items) {
    const capability = String(item.checkId);
    if (item.applicability === "unsupported")
      coverage.unsupported.push(capability);
    else if (item.applicability === "not_applicable")
      coverage.notApplicable.push(capability);
    else {
      const result = resultByCheck.get(capability);
      if (result?.status === "passed" && result.executionSource === "real")
        coverage.verified.push(capability);
      else if (
        result?.status === "passed" &&
        result.executionSource === "simulated"
      )
        coverage.simulated.push(capability);
      else if (
        result?.status === "passed" &&
        result.executionSource === "fixture"
      )
        coverage.fixture.push(capability);
      else coverage.partial.push(capability);
    }
  }
  return {
    verified: sortedUnique(coverage.verified),
    partial: sortedUnique(coverage.partial),
    unsupported: sortedUnique(coverage.unsupported),
    notApplicable: sortedUnique(coverage.notApplicable),
    simulated: sortedUnique(coverage.simulated),
    fixture: sortedUnique(coverage.fixture),
  };
}

export interface VerificationAggregationInput {
  readonly request: VerificationRequest;
  readonly job: VerificationJob;
  readonly profile: ProjectProfile;
  readonly plan: CheckPlan;
  readonly checkResults: readonly CheckResult[];
  readonly policy?: Policy;
  readonly verificationId: string;
  readonly createdAt: string;
  readonly previousVerificationId?: string;
}

export interface VerificationAggregationOutput {
  readonly evidence: readonly Evidence[];
  readonly findings: readonly Finding[];
  readonly policyDecision: import("@verify-agent/domain").PolicyDecision;
  readonly result: VerificationResult;
}

function statusFor(
  outcome: import("@verify-agent/domain").PolicyOutcome,
  coverage: VerificationCoverage,
  results: readonly CheckResult[],
): VerificationResult["status"] {
  if (results.some((result) => result.status === "error")) return "error";
  if (outcome === "block") return "blocked";
  if (outcome === "needs_changes") return "needs_changes";
  if (outcome === "needs_review") return "needs_review";
  return coverage.partial.length > 0 ||
    coverage.unsupported.length > 0 ||
    coverage.simulated.length > 0 ||
    coverage.fixture.length > 0
    ? "partial"
    : "pass";
}

export function aggregateVerification(
  input: VerificationAggregationInput,
): VerificationAggregationOutput {
  const evidence = input.checkResults.map(evidenceForCheckResult);
  const findings = findingsForCheckResults(input.checkResults, evidence);
  const coverage = coverageForPlan(input.plan, input.checkResults);
  const requiredCheckIds = input.plan.items
    .filter((item) => item.required && item.applicability === "applicable")
    .map((item) => item.checkId);
  const unsupportedRequiredCapabilities = input.plan.items
    .filter((item) => item.required && item.applicability === "unsupported")
    .map((item) => String(item.checkId));
  const nonRealRequiredCheckIds = input.plan.items
    .filter((item) => item.required && item.applicability === "applicable")
    .map((item) => item.checkId)
    .filter((checkId) => {
      const result = input.checkResults.find(
        (candidate) => candidate.checkId === checkId,
      );
      return result !== undefined && result.executionSource !== "real";
    });
  const policy = input.policy ?? createDefaultPolicy().policy;
  const policyDecision = evaluateDefaultPolicy({
    results: input.checkResults,
    evidence,
    findings,
    policy,
    requiredCheckIds,
    unsupportedRequiredCapabilities,
    nonRealRequiredCheckIds,
    createdAt: input.createdAt,
  });
  const status = statusFor(
    policyDecision.outcome,
    coverage,
    input.checkResults,
  );
  const summary = `${status}: ${input.checkResults.filter((result) => result.status === "passed").length}/${input.checkResults.length} checks passed.`;
  const content = {
    requestId: input.request.id,
    jobId: input.job.id,
    projectId: input.request.projectId,
    snapshotId: input.request.snapshotId,
    changeSetId: input.request.changeSetId,
    status,
    coverage,
    checkResults: sortedUnique(
      input.checkResults.map((result) => String(result.id)),
    ).map((id) => brandId<"CheckResultId">(id)),
    evidenceReferences: sortedUnique(
      evidence.map((item) => String(item.id)),
    ).map((id) => brandId<"EvidenceId">(id)),
    findingReferences: sortedUnique(
      findings.map((item) => String(item.id)),
    ).map((id) => brandId<"FindingId">(id)),
    policyDecision: policyDecision.id,
    policyDecisionHash: policyDecision.contentHash,
    summary,
    resultVersion: RESULT_VERSION,
  };
  const result: VerificationResult = {
    id: brandId<"VerificationId">(input.verificationId),
    ...content,
    ...(input.previousVerificationId === undefined
      ? {}
      : {
          previousVerificationId: brandId<"VerificationId">(
            input.previousVerificationId,
          ),
        }),
    contentHash: hash(content),
    createdAt: input.createdAt,
  };
  validateVerificationResult(result);
  return { evidence, findings, policyDecision, result };
}

export function aggregationInputFromPipeline(
  output: import("./pipeline.js").VerificationPipelineOutput,
  request: VerificationRequest,
  job: VerificationJob,
  options: Omit<
    VerificationAggregationInput,
    "request" | "job" | "profile" | "plan" | "checkResults"
  > & {
    readonly additionalCheckResults?: readonly CheckResult[];
  },
): VerificationAggregationInput {
  const { additionalCheckResults, ...stableOptions } = options;
  return {
    request,
    job,
    profile: output.profile,
    plan: output.plan,
    checkResults: [
      ...output.checkResults,
      ...(additionalCheckResults ?? []),
    ],
    ...stableOptions,
  };
}
