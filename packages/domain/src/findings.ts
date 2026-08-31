import type { EvidenceId, FindingId } from "./identifiers.js";
import type { Provenance } from "./provenance.js";

export type FindingStatus = "open" | "resolved" | "dismissed" | "superseded";
export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export interface FindingLocation {
  readonly path: string;
  readonly startLine: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

export interface Finding {
  readonly id: FindingId;
  readonly category: string;
  readonly severity: FindingSeverity;
  readonly status: FindingStatus;
  readonly title: string;
  readonly description: string;
  readonly locations: readonly FindingLocation[];
  readonly evidenceReferences: readonly EvidenceId[];
  readonly producer: Provenance;
  readonly confidence?: number;
}
