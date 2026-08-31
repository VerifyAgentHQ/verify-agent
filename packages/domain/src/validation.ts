import type { ChangeSet } from "./changes.js";
import type { CheckExecution, CheckResult } from "./checks.js";
import type { Evidence } from "./evidence.js";
import type { Finding, FindingLocation } from "./findings.js";
import type { Policy, PolicyDecision } from "./policy.js";
import type { Project, ProjectProfile } from "./project.js";
import type {
  RepositorySnapshot,
  SourceReference,
  SourceState,
} from "./source.js";
import type {
  VerificationCoverage,
  VerificationJob,
  VerificationRequest,
  VerificationResult,
} from "./verification.js";

export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const fail = (message: string): never => {
  throw new DomainValidationError(message);
};
const nonEmpty = (value: string, name: string): void => {
  if (value.trim().length === 0) fail(`${name} must be non-empty`);
};
const identifier = (value: string, name: string): void => {
  nonEmpty(value, name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value))
    fail(`${name} is not a valid identifier`);
};
const integerAtLeast = (value: number, minimum: number, name: string): void => {
  if (!Number.isInteger(value) || value < minimum)
    fail(`${name} must be an integer >= ${minimum}`);
};
const hash = (value: string, name: string): void => {
  if (!/^[A-Fa-f0-9]{64}$/.test(value))
    fail(`${name} must be a 64-character hexadecimal hash`);
};
const isoDate = (value: string, name: string): void => {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    Number.isNaN(Date.parse(value))
  )
    fail(`${name} must be an ISO date-time with timezone`);
};

export function normalizePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  nonEmpty(normalized, "path");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    fail("path must be a normalized repository-relative path");
  }
  return normalized;
}

export function validateSourceReference(value: SourceReference): void {
  nonEmpty(value.provider, "source provider");
  nonEmpty(value.reference, "source reference");
}
export function validateSourceState(value: SourceState): void {
  if (value.type !== "commit" && value.type !== "snapshot")
    fail("invalid source state type");
  nonEmpty(value.value, "source state value");
}
export function validateProject(value: Project): void {
  identifier(value.id, "project id");
  nonEmpty(value.name, "project name");
  normalizePath(value.root);
}
export function validateSnapshot(value: RepositorySnapshot): void {
  identifier(value.id, "snapshot id");
  identifier(value.projectId, "snapshot project id");
  validateSourceReference(value.source);
  validateSourceState(value.sourceState);
  isoDate(value.retrievedAt, "retrievedAt");
  if (value.snapshotHash) hash(value.snapshotHash, "snapshotHash");
  if (value.commitSha && value.commitSha.trim().length === 0)
    fail("commitSha must be non-empty");
}
export function validateChangeSet(value: ChangeSet): void {
  identifier(value.id, "change set id");
  validateSourceState(value.baseSourceState);
  validateSourceState(value.headSourceState);
  hash(value.changeHash, "changeHash");
  integerAtLeast(value.additions, 0, "additions");
  integerAtLeast(value.deletions, 0, "deletions");
  for (const file of value.changedFiles) {
    normalizePath(file.path);
    if (
      !["added", "modified", "deleted", "renamed", "copied"].includes(
        file.status,
      )
    )
      fail("invalid changed-file status");
    integerAtLeast(file.additions, 0, "file additions");
    integerAtLeast(file.deletions, 0, "file deletions");
    if (file.previousPath !== undefined) normalizePath(file.previousPath);
    if (
      ["renamed", "copied"].includes(file.status) &&
      file.previousPath === undefined
    )
      fail(`${file.status} files require previousPath`);
  }
}
export function validateProjectProfile(value: ProjectProfile): void {
  identifier(value.projectId, "profile project id");
  identifier(value.snapshotId, "profile snapshot id");
  if (value.detectionConfidence < 0 || value.detectionConfidence > 1)
    fail("detectionConfidence must be between 0 and 1");
}
export function validateVerificationRequest(value: VerificationRequest): void {
  identifier(value.id, "verification request id");
  identifier(value.projectId, "project id");
  identifier(value.snapshotId, "snapshot id");
  identifier(value.changeSetId, "change set id");
  identifier(value.policyId, "policy id");
  integerAtLeast(value.priority, 0, "priority");
  isoDate(value.createdAt, "createdAt");
}
export function validateVerificationJob(value: VerificationJob): void {
  identifier(value.id, "job id");
  identifier(value.requestId, "request id");
  integerAtLeast(value.attempt, 1, "attempt");
  if (value.startedAt) isoDate(value.startedAt, "startedAt");
  if (value.completedAt) isoDate(value.completedAt, "completedAt");
  if (value.status === "failed" && !value.failureReason)
    fail("failed jobs require a failureReason");
}
export function validateCheckExecution(value: CheckExecution): void {
  identifier(value.id, "check execution id");
  identifier(value.checkDefinitionId, "check definition id");
  identifier(value.jobId, "job id");
  hash(value.inputsHash, "inputsHash");
  if (
    ![
      "queued",
      "running",
      "completed",
      "failed",
      "timed_out",
      "cancelled",
    ].includes(value.status)
  )
    fail("invalid check execution status");
  if (value.startedAt) isoDate(value.startedAt, "startedAt");
  if (value.completedAt) isoDate(value.completedAt, "completedAt");
}
export function validateCheckResult(value: CheckResult): void {
  identifier(value.id, "check result id");
  identifier(value.checkExecutionId, "check execution id");
  identifier(value.checkId, "check id");
  nonEmpty(value.checkVersion, "check version");
  if (
    ![
      "passed",
      "failed",
      "error",
      "timed_out",
      "cancelled",
      "skipped",
    ].includes(value.status)
  )
    fail("invalid check result status");
  nonEmpty(value.summary, "summary");
  integerAtLeast(value.durationMs, 0, "durationMs");
  hash(value.inputHash, "inputHash");
  hash(value.contentHash, "contentHash");
  isoDate(value.createdAt, "createdAt");
  if (!value.producer.type || !value.producer.name)
    fail("check result requires producer provenance");
}
export function validateEvidence(value: Evidence): void {
  identifier(value.id, "evidence id");
  nonEmpty(value.type, "evidence type");
  nonEmpty(value.summary, "evidence summary");
  if (
    value.sourceReferences.length === 0 ||
    value.sourceReferences.some((reference) => reference.trim().length === 0)
  )
    fail("evidence requires a source reference");
  hash(value.contentHash, "contentHash");
  isoDate(value.createdAt, "createdAt");
  if (!value.producer.type || !value.producer.name)
    fail("evidence requires producer provenance");
}
export function validateFindingLocation(value: FindingLocation): void {
  normalizePath(value.path);
  integerAtLeast(value.startLine, 1, "startLine");
  if (value.startColumn !== undefined)
    integerAtLeast(value.startColumn, 1, "startColumn");
  if (value.endLine !== undefined) integerAtLeast(value.endLine, 1, "endLine");
  if (value.endColumn !== undefined)
    integerAtLeast(value.endColumn, 1, "endColumn");
  if (value.endLine !== undefined && value.endLine < value.startLine)
    fail("endLine cannot be less than startLine");
  if (
    value.endLine === value.startLine &&
    value.endColumn !== undefined &&
    value.startColumn !== undefined &&
    value.endColumn < value.startColumn
  )
    fail("endColumn cannot be less than startColumn on the same line");
}
export function validateFinding(value: Finding): void {
  identifier(value.id, "finding id");
  nonEmpty(value.category, "finding category");
  nonEmpty(value.title, "finding title");
  nonEmpty(value.description, "finding description");
  if (value.evidenceReferences.length === 0)
    fail("finding requires at least one evidence reference");
  for (const reference of value.evidenceReferences)
    identifier(reference, "evidence reference");
  for (const location of value.locations) validateFindingLocation(location);
  if (!["info", "low", "medium", "high", "critical"].includes(value.severity))
    fail("invalid finding severity");
  if (!["open", "resolved", "dismissed", "superseded"].includes(value.status))
    fail("invalid finding status");
  if (!value.producer.type || !value.producer.name)
    fail("finding requires producer provenance");
  if (
    value.confidence !== undefined &&
    (value.confidence < 0 || value.confidence > 1)
  )
    fail("confidence must be between 0 and 1");
}
export function validatePolicy(value: Policy): void {
  nonEmpty(value.id, "policy id");
  nonEmpty(value.name, "policy name");
  nonEmpty(value.version, "policy version");
  isoDate(value.createdAt, "createdAt");
}
export function validatePolicyDecision(value: PolicyDecision): void {
  identifier(value.id, "policy decision id");
  identifier(value.policyId, "policy id");
  nonEmpty(value.policyVersion, "policy version");
  nonEmpty(value.contentHash, "contentHash");
  hash(value.contentHash, "contentHash");
  if (
    !["allow", "needs_review", "needs_changes", "block"].includes(value.outcome)
  )
    fail("invalid policy outcome");
  for (const reference of [
    ...value.triggeredRuleIds,
    ...value.evidenceReferences,
    ...value.findingReferences,
  ])
    identifier(reference, "policy reference");
  isoDate(value.createdAt, "createdAt");
}
export function validateCoverage(value: VerificationCoverage): void {
  const groups = [
    value.verified,
    value.partial,
    value.unsupported,
    value.notApplicable,
  ];
  const seen = new Set<string>();
  for (const group of groups)
    for (const capability of group) {
      nonEmpty(capability, "capability");
      if (seen.has(capability))
        fail(
          `capability appears in multiple coverage categories: ${capability}`,
        );
      seen.add(capability);
    }
}
export function validateVerificationResult(value: VerificationResult): void {
  identifier(value.id, "verification id");
  identifier(value.requestId, "request id");
  identifier(value.jobId, "job id");
  identifier(value.projectId, "project id");
  identifier(value.snapshotId, "snapshot id");
  identifier(value.changeSetId, "change set id");
  if (
    ![
      "pass",
      "needs_review",
      "needs_changes",
      "blocked",
      "partial",
      "error",
    ].includes(value.status)
  )
    fail("invalid verification status");
  nonEmpty(value.summary, "summary");
  identifier(value.policyDecision, "policy decision");
  validateCoverage(value.coverage);
  for (const reference of [
    ...value.checkResults,
    ...value.evidenceReferences,
    ...value.findingReferences,
  ])
    identifier(reference, "result reference");
  hash(value.contentHash, "contentHash");
  if (!/^\d+\.\d+\.\d+$/.test(value.resultVersion))
    fail("resultVersion must be semantic version");
  isoDate(value.createdAt, "createdAt");
}
