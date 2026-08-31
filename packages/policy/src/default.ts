import { createHash } from "node:crypto";
import {
  brandId,
  validatePolicy,
  validatePolicyDecision,
  type Evidence,
  type Finding,
  type Policy,
  type PolicyDecision,
  type CheckResult,
} from "@verify-agent/domain";
import type {
  DefaultPolicy,
  PolicyDecisionContext,
  PolicyEvaluator,
} from "./types.js";

const POLICY_ID = brandId<"PolicyId">("policy.default");
const POLICY_VERSION = "1.0.0";

const policy: Policy = {
  id: POLICY_ID,
  name: "Default deterministic verification policy",
  version: POLICY_VERSION,
  rules: [
    {
      ruleId: "required-check-failure",
      condition:
        "required check status is failed, timed_out, error, or cancelled",
      action: "block",
      priority: 10,
      description: "A required check did not establish a successful fact.",
    },
    {
      ruleId: "high-finding",
      condition: "deterministic finding severity is high or critical",
      action: "block",
      priority: 20,
      description: "A high-impact deterministic finding blocks verification.",
    },
    {
      ruleId: "unsupported-required-capability",
      condition: "a required capability is unsupported",
      action: "needs_changes",
      priority: 30,
      description:
        "Required coverage cannot be established for an unsupported capability.",
    },
    {
      ruleId: "medium-finding",
      condition: "deterministic finding severity is medium",
      action: "needs_review",
      priority: 40,
      description: "A medium-impact finding requires review.",
    },
  ],
  createdAt: "2026-08-31T00:00:00Z",
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function failedRequiredChecks(
  results: readonly CheckResult[],
  required: ReadonlySet<string>,
): readonly CheckResult[] {
  return results.filter(
    (result) =>
      required.has(String(result.checkId)) &&
      ["failed", "timed_out", "error", "cancelled"].includes(result.status),
  );
}

export class DeterministicPolicyEvaluator implements PolicyEvaluator {
  decide(context: PolicyDecisionContext): Promise<PolicyDecision> {
    return Promise.resolve(evaluateDefaultPolicy(context));
  }
}

export function evaluateDefaultPolicy(
  context: PolicyDecisionContext,
): PolicyDecision {
  validatePolicy(context.policy);
  const required = new Set(context.requiredCheckIds.map(String));
  const failedRequired = failedRequiredChecks(context.results, required);
  const severeFindings = context.findings.filter((finding) =>
    ["high", "critical"].includes(finding.severity),
  );
  const mediumFindings = context.findings.filter(
    (finding) => finding.severity === "medium",
  );
  const triggeredRuleIds: string[] = [];
  let outcome: PolicyDecision["outcome"] = "allow";
  if (failedRequired.length > 0) {
    outcome = "block";
    triggeredRuleIds.push("required-check-failure");
  }
  if (severeFindings.length > 0) {
    outcome = "block";
    triggeredRuleIds.push("high-finding");
  }
  if (
    outcome !== "block" &&
    context.unsupportedRequiredCapabilities.length > 0
  ) {
    outcome = "needs_changes";
    triggeredRuleIds.push("unsupported-required-capability");
  }
  if (outcome === "allow" && mediumFindings.length > 0) {
    outcome = "needs_review";
    triggeredRuleIds.push("medium-finding");
  }
  const evidenceReferences = uniqueSorted(
    context.evidence.map((evidence) => String(evidence.id)),
  ).map((id) => brandId<"EvidenceId">(id));
  const findingReferences = uniqueSorted(
    context.findings.map((finding) => String(finding.id)),
  ).map((id) => brandId<"FindingId">(id));
  const content = {
    policyId: context.policy.id,
    policyVersion: context.policy.version,
    outcome,
    triggeredRuleIds: uniqueSorted(triggeredRuleIds),
    evidenceReferences,
    findingReferences,
  };
  const decision: PolicyDecision = {
    id: brandId<"PolicyDecisionId">(`decision-${hash(content).slice(0, 24)}`),
    ...content,
    createdAt: context.createdAt,
    contentHash: hash(content),
  };
  validatePolicyDecision(decision);
  return decision;
}

export function createDefaultPolicy(): DefaultPolicy {
  return { policy, evaluator: new DeterministicPolicyEvaluator() };
}
