import type {
  Evidence,
  Finding,
  VerificationResult,
} from "@verify-agent/domain";

export type ReasoningTask =
  | "issue-alignment"
  | "semantic-scope"
  | "architecture-analysis"
  | "finding-triage"
  | "summary";

export interface ReasoningRequest {
  task: ReasoningTask;
  evidence: Evidence[];
  findings: Finding[];
  traceId?: string;
}

export interface ReasoningResult {
  task: ReasoningTask;
  summary: string;
  notes: string[];
}

export interface ReasoningProvider {
  reason(request: ReasoningRequest): Promise<ReasoningResult>;
}

export interface ReasoningContext {
  result: VerificationResult;
  request: ReasoningRequest;
}
