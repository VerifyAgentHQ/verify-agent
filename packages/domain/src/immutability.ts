export type ImmutableFact =
  | "RepositorySnapshot"
  | "ChangeSet"
  | "CheckResult"
  | "Evidence"
  | "PolicyDecision"
  | "VerificationResult";

export type VersionedDefinition = "CheckDefinition" | "Policy";

export interface ImmutabilityContract {
  readonly immutableFacts: ImmutableFact[];
  readonly versionedDefinitions: VersionedDefinition[];
  readonly rule: string;
}

export const domainImmutability: ImmutabilityContract = {
  immutableFacts: [
    "RepositorySnapshot",
    "ChangeSet",
    "CheckResult",
    "Evidence",
    "PolicyDecision",
    "VerificationResult",
  ],
  versionedDefinitions: ["CheckDefinition", "Policy"],
  rule: "A new commit creates a new VerificationResult; historical verification facts must not be silently mutated.",
};
