import type { Brand } from "./identifiers.js";

export type RequirementEvidenceId = Brand<string, "RequirementEvidenceId">;

export type RequirementEvidenceSource = {
  readonly kind: "pull_request" | "issue";
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly field: "title" | "body";
  /** Immutable GitHub URL for the source text, when known. */
  readonly url?: string;
};

export type RequirementEvidenceRule =
  | "github-action-pinned"
  | "checkout-persist-credentials-disabled"
  | "required-file-changed";

export type RequirementEvidenceStatus = "passed" | "failed" | "unknown";

export type RequirementEvidenceLocation = {
  readonly file: string;
  readonly patchHunk?: string;
  readonly side?: "LEFT" | "RIGHT";
  readonly startLine?: number;
  readonly endLine?: number;
  /** Immutable commit URL for this file/line, when known. */
  readonly url?: string;
};

export type RequirementEvidence = {
  readonly id: RequirementEvidenceId;
  readonly source: RequirementEvidenceSource;
  readonly requirementText: string;
  /** Stable identifier for the normalized requirement candidate. */
  readonly requirementId?: string;
  readonly sourceText?: string;
  readonly rule: RequirementEvidenceRule;
  readonly status: RequirementEvidenceStatus;
  readonly explanation: string;
  readonly matchedFiles: readonly string[];
  readonly locations: readonly RequirementEvidenceLocation[];
  readonly observedText: readonly string[];
  readonly evidenceHash: string;
  /** Exact commit whose PR evidence was inspected. */
  readonly commitSha?: string;
  /** Time at which this evidence was collected. */
  readonly collectedAt?: string;
};
