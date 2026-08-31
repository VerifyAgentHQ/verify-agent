import type {
  CheckId,
  CheckPlanId,
  ProjectId,
  RepositorySnapshotId,
} from "./identifiers.js";

export type PlanApplicability = "applicable" | "not_applicable" | "unsupported";
export type CheckScope =
  "repository" | "workspace" | "project" | "package" | "language";

export interface CheckPlanItem {
  readonly checkId: CheckId;
  readonly checkVersion: string;
  readonly applicability: PlanApplicability;
  readonly required: boolean;
  readonly reason: string;
  readonly priority: number;
  readonly dependencies: readonly CheckId[];
  readonly scope: CheckScope;
}

export interface CheckPlan {
  readonly planId: CheckPlanId;
  readonly plannerVersion: string;
  readonly projectId: ProjectId;
  readonly snapshotId: RepositorySnapshotId;
  readonly items: readonly CheckPlanItem[];
  readonly createdAt: string;
  readonly contentHash: string;
}
