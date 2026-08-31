/** References to schemas owned by the sibling verify-contracts repository. */
export const publicContract = {
  schemaVersion: "1.0.0",
  verificationRequestSchema:
    "https://contracts.verifyagent.dev/schemas/verification/verification-request.schema.json",
  verificationResultSchema:
    "https://contracts.verifyagent.dev/schemas/verification/verification-result.schema.json",
  sandboxJobRequestSchema:
    "https://contracts.verifyagent.dev/schemas/sandbox/sandbox-job-request.schema.json",
  sandboxJobResultSchema:
    "https://contracts.verifyagent.dev/schemas/sandbox/sandbox-job-result.schema.json",
} as const;

export interface PublicSourceReference {
  readonly provider: string;
  readonly reference: string;
}

export interface PublicSourceState {
  readonly type: "commit" | "snapshot";
  readonly value: string;
}

export function toPublicSourceReference(
  source: import("./source.js").SourceReference,
): PublicSourceReference {
  return { provider: source.provider, reference: source.reference };
}

export function toPublicSourceState(
  snapshot: import("./source.js").RepositorySnapshot,
): PublicSourceState {
  return snapshot.sourceState;
}
