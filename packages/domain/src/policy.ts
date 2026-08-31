import type {
  EvidenceId,
  FindingId,
  PolicyDecisionId,
  PolicyId,
} from "./identifiers.js";

export interface PolicyRule {
  readonly ruleId: string;
  readonly condition: string;
  readonly action: string;
  readonly priority: number;
  readonly description: string;
}

export interface Policy {
  readonly id: PolicyId;
  readonly name: string;
  readonly version: string;
  readonly rules: readonly PolicyRule[];
  readonly createdAt: string;
}

export type PolicyOutcome =
  "allow" | "needs_review" | "needs_changes" | "block";

export interface PolicyDecision {
  readonly id: PolicyDecisionId;
  readonly policyId: PolicyId;
  readonly policyVersion: string;
  readonly outcome: PolicyOutcome;
  readonly triggeredRuleIds: readonly string[];
  readonly evidenceReferences: readonly EvidenceId[];
  readonly findingReferences: readonly FindingId[];
  readonly createdAt: string;
  readonly contentHash: string;
}
