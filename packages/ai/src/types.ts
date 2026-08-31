import type {
  ChangeSet,
  Evidence,
  EvidenceId,
  Finding,
  Project,
  ProjectProfile,
  Provenance,
} from "@verify-agent/domain";

export type ReasoningTask =
  | "scope_alignment"
  | "failure_relevance"
  | "architecture_consistency"
  | "finding_prioritization"
  | "summary";

export interface AiReasoningInput {
  readonly task: ReasoningTask;
  readonly project?: Project;
  readonly profile?: ProjectProfile;
  readonly change?: ChangeSet;
  readonly issueContext?: string;
  readonly evidence: readonly Evidence[];
  readonly findings: readonly Finding[];
  readonly sourceExcerpts?: readonly string[];
  readonly architectureRules?: readonly string[];
}

export interface AiProviderRequest {
  readonly input: AiReasoningInput;
  readonly prompt: string;
}

export interface AiReasoningOutput {
  readonly task: ReasoningTask;
  readonly conclusion: string;
  readonly confidence: number;
  readonly rationale: string;
  readonly evidenceReferences: readonly EvidenceId[];
  readonly uncertainties: readonly string[];
  readonly producer: Provenance;
}

export interface AiConflict {
  readonly type: "deterministic_ai_conflict";
  readonly evidenceReferences: readonly EvidenceId[];
  readonly deterministicFact: string;
  readonly aiInterpretation: string;
}

export interface AiReasoningResponse {
  readonly output: AiReasoningOutput;
  readonly conflicts: readonly AiConflict[];
  readonly cacheHit: boolean;
  readonly prompt: string;
}

export interface AiReasoningProvider {
  reason(request: AiProviderRequest): Promise<unknown>;
}

export interface AiReasoningCache {
  get(key: string): AiReasoningOutput | undefined;
  set(key: string, value: AiReasoningOutput): void;
}

export interface AiServiceConfig {
  readonly producer: Provenance;
  readonly promptVersion: string;
  readonly cache?: AiReasoningCache;
}

export type ReasoningProvider = AiReasoningProvider;
export type ReasoningRequest = AiProviderRequest;
export type ReasoningResult = AiReasoningOutput;
