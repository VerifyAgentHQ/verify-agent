import type { ProjectId, RepositorySnapshotId } from "./identifiers.js";

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
  readonly id: ProjectId;
  readonly name: string;
  readonly root: string;
  readonly primaryEcosystem?: Ecosystem;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProjectProfile {
  readonly projectId: ProjectId;
  readonly snapshotId: RepositorySnapshotId;
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly packageManagers: readonly string[];
  readonly buildSystems: readonly string[];
  readonly testFrameworks: readonly string[];
  readonly detectedTools: readonly string[];
  readonly repositoryStructure: Readonly<Record<string, unknown>>;
  readonly supportedCapabilities: readonly string[];
  readonly detectionConfidence: number;
}
