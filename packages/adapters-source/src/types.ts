import type {
  ChangeSet,
  RepositorySnapshot,
  SourceReference,
  VerificationRequest,
} from "@verify-agent/domain";

export interface RepositoryMetadata {
  repositoryId: string;
  name: string;
  defaultBranch?: string;
}

export interface SourceState {
  snapshot: RepositorySnapshot;
  sourceReference: SourceReference;
}

export interface ChangeSetLike extends ChangeSet {}

export interface SourceContext {
  metadata: RepositoryMetadata;
  state: SourceState;
  changeSet: ChangeSetLike;
  request?: VerificationRequest;
}

export interface SourceProvider {
  fetchMetadata(repositoryId: string): Promise<RepositoryMetadata>;
  fetchSourceState(repositoryId: string, ref: string): Promise<SourceState>;
  fetchChangeSet(
    repositoryId: string,
    baseRef: string,
    headRef: string,
  ): Promise<ChangeSetLike>;
  fetchPullRequestMetadata(
    repositoryId: string,
    pullRequestId: string,
  ): Promise<Record<string, unknown>>;
}
