import type { ProjectId, RepositorySnapshotId } from "./identifiers.js";

export interface SourceReference {
  readonly provider: string;
  readonly reference: string;
}

export type SourceState =
  | { readonly type: "commit"; readonly value: string }
  | { readonly type: "snapshot"; readonly value: string };

export interface RepositorySnapshot {
  readonly id: RepositorySnapshotId;
  readonly projectId: ProjectId;
  readonly source: SourceReference;
  readonly sourceState: SourceState;
  readonly commitSha?: string;
  readonly baseCommitSha?: string;
  readonly snapshotHash?: string;
  readonly retrievedAt: string;
}
