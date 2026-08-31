import type {
  CheckId,
  CheckResultId,
  EvidenceId,
  FindingId,
  PolicyDecisionId,
  PolicyId,
  ProjectId,
  RepositorySnapshotId,
  VerificationId,
  VerificationJobId,
  VerificationRequestId,
} from "./identifiers.js";
import type { ChangeSetId } from "./changes-internal.js";
import type { RepositorySnapshot, SourceReference } from "./source.js";

export type RequestActor = "human" | "system" | "agent" | "source-platform";
export type VerificationMode =
  "pull_request" | "commit" | "repository" | "manual" | "agent";

export interface VerificationRequest {
  readonly id: VerificationRequestId;
  readonly projectId: ProjectId;
  readonly snapshotId: RepositorySnapshotId;
  readonly changeSetId: ChangeSetId;
  readonly requestedBy: Readonly<{ type: RequestActor; id?: string }>;
  readonly mode: VerificationMode;
  readonly requestedChecks: readonly CheckId[];
  readonly policyId: PolicyId;
  readonly priority: number;
  readonly createdAt: string;
}

export type VerificationJobStatus =
  "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";

export interface VerificationJob {
  readonly id: VerificationJobId;
  readonly requestId: VerificationRequestId;
  readonly attempt: number;
  readonly status: VerificationJobStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failureReason?: string;
}

export type VerificationStatus =
  "pass" | "needs_review" | "needs_changes" | "blocked" | "partial" | "error";

export interface VerificationResult {
  readonly id: VerificationId;
  readonly requestId: VerificationRequestId;
  readonly jobId: VerificationJobId;
  readonly projectId: ProjectId;
  readonly snapshotId: RepositorySnapshotId;
  readonly changeSetId: ChangeSetId;
  readonly status: VerificationStatus;
  readonly coverage: VerificationCoverage;
  readonly checkResults: readonly CheckResultId[];
  readonly evidenceReferences: readonly EvidenceId[];
  readonly findingReferences: readonly FindingId[];
  readonly policyDecision: PolicyDecisionId;
  readonly summary: string;
  readonly previousVerificationId?: VerificationId;
  readonly resultVersion: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface PublicVerificationTarget {
  readonly source: SourceReference;
  readonly sourceState: RepositorySnapshot["sourceState"];
}

export interface VerificationCoverage {
  readonly verified: readonly string[];
  readonly partial: readonly string[];
  readonly unsupported: readonly string[];
  readonly notApplicable: readonly string[];
  /** Internal categories only; synthetic results never count as verified. */
  readonly simulated: readonly string[];
  readonly fixture: readonly string[];
}
