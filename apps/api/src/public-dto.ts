import type {
  CheckResultId,
  EvidenceId,
  FindingId,
  PolicyDecisionId,
  VerificationStatus,
} from "@verify-agent/domain";

export interface PublicVerifyRequest {
  readonly source: {
    readonly kind: "snapshot";
    readonly id: string;
  };
}

export interface PublicVerificationResponse {
  readonly status: VerificationStatus;
  readonly coverage: {
    readonly verified: readonly string[];
    readonly partial: readonly string[];
    readonly unsupported: readonly string[];
    readonly notApplicable: readonly string[];
  };
  readonly checkResults: readonly CheckResultId[];
  readonly findings: readonly FindingId[];
  readonly evidenceReferences: readonly EvidenceId[];
  readonly policyDecision: PolicyDecisionId;
  readonly summary: string;
  readonly resultVersion: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly source: PublicVerifyRequest["source"];
}
