import type { Brand } from "./identifiers.js";

export type RequirementEvidenceId = Brand<string, "RequirementEvidenceId">;

export type RequirementEvidenceSource = {
  readonly kind: "pull_request" | "issue";
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
  readonly field: "title" | "body";
};

export type RequirementEvidenceRule =
  "github-action-pinned" | "checkout-persist-credentials-disabled";

export type RequirementEvidenceStatus = "passed" | "failed" | "unknown";

export type RequirementEvidenceLocation = {
  readonly file: string;
  readonly patchHunk?: string;
  readonly startLine?: number;
  readonly endLine?: number;
};

export type RequirementEvidence = {
  readonly id: RequirementEvidenceId;
  readonly source: RequirementEvidenceSource;
  readonly requirementText: string;
  readonly rule: RequirementEvidenceRule;
  readonly status: RequirementEvidenceStatus;
  readonly explanation: string;
  readonly matchedFiles: readonly string[];
  readonly locations: readonly RequirementEvidenceLocation[];
  readonly observedText: readonly string[];
  readonly evidenceHash: string;
};
