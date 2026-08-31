import type {
  CheckResult,
  Policy,
  PolicyDecision,
  VerificationResult,
} from "@verify-agent/domain";

export interface PolicyDecisionContext {
  results: CheckResult[];
  policy: Policy;
  verification: VerificationResult;
}

export interface PolicyEvaluator {
  decide(context: PolicyDecisionContext): Promise<PolicyDecision>;
}

export interface PolicyGate {
  readonly name: string;
  evaluate(context: PolicyDecisionContext): Promise<PolicyDecision>;
}
