export type Brand<T, B extends string> = T & { readonly __brand: B };

export type ProjectId = Brand<string, "ProjectId">;
export type RepositorySnapshotId = Brand<string, "RepositorySnapshotId">;
export type ChangeSetId = Brand<string, "ChangeSetId">;
export type CheckPlanId = Brand<string, "CheckPlanId">;
export type VerificationId = Brand<string, "VerificationId">;
export type VerificationRequestId = Brand<string, "VerificationRequestId">;
export type VerificationJobId = Brand<string, "VerificationJobId">;
export type CheckId = Brand<string, "CheckId">;
export type CheckExecutionId = Brand<string, "CheckExecutionId">;
export type CheckResultId = Brand<string, "CheckResultId">;
export type EvidenceId = Brand<string, "EvidenceId">;
export type FindingId = Brand<string, "FindingId">;
export type PolicyId = Brand<string, "PolicyId">;
export type PolicyDecisionId = Brand<string, "PolicyDecisionId">;

export function brandId<T extends string>(value: string): Brand<string, T> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`Invalid identifier: ${value}`);
  }
  return value as Brand<string, T>;
}
