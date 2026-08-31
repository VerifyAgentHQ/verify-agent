import type { ChangeSetId } from "./changes-internal.js";
import type { SourceState } from "./source.js";

export type FileChangeStatus =
  "added" | "modified" | "deleted" | "renamed" | "copied";

export interface ChangedFile {
  readonly path: string;
  readonly status: FileChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly previousPath?: string;
}

export interface ChangeSet {
  readonly id: ChangeSetId;
  readonly baseSourceState: SourceState;
  readonly headSourceState: SourceState;
  readonly changedFiles: readonly ChangedFile[];
  readonly additions: number;
  readonly deletions: number;
  readonly changeHash: string;
  readonly description?: string;
  readonly issueReferences: readonly string[];
}
