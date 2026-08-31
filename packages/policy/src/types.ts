import type {
  CheckResult,
  Evidence,
  Finding,
  Policy,
  PolicyDecision,
  CheckId,
} from "@verify-agent/domain";

export interface PolicyDecisionContext {
  readonly results: readonly CheckResult[];
  readonly evidence: readonly Evidence[];
  readonly findings: readonly Finding[];
  policy: Policy;
  readonly requiredCheckIds: readonly CheckId[];
  readonly unsupportedRequiredCapabilities: readonly string[];
  readonly nonRealRequiredCheckIds: readonly CheckId[];
  readonly createdAt: string;
}

export interface PolicyEvaluator {
  decide(context: PolicyDecisionContext): Promise<PolicyDecision>;
}

export interface PolicyGate {
  readonly name: string;
  evaluate(context: PolicyDecisionContext): Promise<PolicyDecision>;
}

export interface DefaultPolicy {
  readonly policy: Policy;
  readonly evaluator: PolicyEvaluator;
}
