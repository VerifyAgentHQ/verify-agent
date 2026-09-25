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

/**
 * Batch 50 — safe public projection for asynchronous result observation.
 *
 * Reuses the same safe field subset as `PublicVerificationResponse`
 * (status, coverage, findings, evidence references, policy decision,
 * summary, version, content hash) plus the three preserved identity
 * domains:
 *
 * - `queueJobId` — the originating `VerificationQueueJob.jobId` lookup
 *   handle echoed from the request path (not source identity itself);
 * - `verificationId` — the native `VerificationResult.id`;
 * - `jobId` — the native `VerificationResult.jobId`;
 * - `snapshotId` — the result source/snapshot identity.
 *
 * No webhook secrets, installation tokens, credentials, filesystem paths,
 * stack traces, request bodies, sandbox commands, or environment variables
 * are exposed.
 */
export interface PublicAsyncVerificationResponse {
  readonly queueJobId: string;
  readonly verificationId: string;
  readonly jobId: string;
  readonly snapshotId: string;
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
}
