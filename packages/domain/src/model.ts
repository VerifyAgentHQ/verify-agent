export type Ecosystem =
  | "typescript"
  | "rust"
  | "python"
  | "go"
  | "solidity"
  | "java"
  | "kotlin"
  | "csharp"
  | "cpp"
  | "other";

export interface Project {
  id: string;
  name: string;
  path: string;
  ecosystem: Ecosystem;
  root: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface SourceReference {
  kind: "git" | "archive" | "file";
  ref: string;
  uri?: string;
  commit?: string;
}

export interface RepositorySnapshot {
  repositoryId: string;
  source: SourceReference;
  project: Project;
  capturedAt: string;
  revision: string;
}

export interface ChangeSet {
  id: string;
  repositoryId: string;
  baseRevision: string;
  headRevision: string;
  files: readonly string[];
  summary?: string;
}

export interface ProjectProfile {
  projectId: string;
  ecosystem: Ecosystem;
  detectedBy: string;
  capabilities: readonly string[];
  configHints?: Readonly<Record<string, unknown>>;
}

export interface VerificationRequest {
  id: string;
  repositoryId: string;
  source: SourceReference;
  changeSet: ChangeSet;
  requestedBy?: string;
  createdAt: string;
}

export interface VerificationJob {
  id: string;
  requestId: string;
  project: Project;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
}

export interface CheckDefinition {
  id: string;
  kind: string;
  description: string;
  version: string;
  input?: Readonly<Record<string, unknown>>;
}

export interface CheckExecution {
  id: string;
  jobId: string;
  checkId: string;
  startedAt: string;
  finishedAt?: string;
  status: "pending" | "running" | "passed" | "failed" | "skipped";
}

export interface Evidence {
  id: string;
  kind: string;
  provider: string;
  recordedAt: string;
  payload: Readonly<Record<string, unknown>>;
}

export interface Finding {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  description: string;
  evidenceIds: readonly string[];
  sourceCheckId?: string;
}

export interface Policy {
  id: string;
  name: string;
  version: string;
  description: string;
  rules: readonly string[];
}

export interface PolicyDecision {
  id: string;
  verificationId: string;
  policyId: string;
  outcome: "pass" | "fail" | "needs-review";
  rationale: readonly string[];
  decidedAt: string;
}

export interface VerificationResult {
  id: string;
  requestId: string;
  jobId: string;
  status: "pass" | "fail" | "needs-review" | "error";
  createdAt: string;
  producedAt: string;
  findings: readonly Finding[];
  evidence: readonly Evidence[];
  summary: string;
}

export interface VerificationCoverage {
  projectId: string;
  ecosystems: readonly Ecosystem[];
  supportedChecks: readonly string[];
  coverage: Readonly<Record<string, number>>;
}

export interface Provenance {
  source: "verify-agent" | "verify-contracts" | "verify-sandbox" | "external";
  traceId?: string;
  createdAt: string;
  version?: string;
}

export interface CheckResult {
  id: string;
  checkId: string;
  jobId: string;
  status: "pass" | "fail" | "skipped" | "error";
  evidence: readonly Evidence[];
  summary: string;
  recordedAt: string;
}
