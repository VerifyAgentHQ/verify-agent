import type { EvidenceId } from "./identifiers.js";
import type { Provenance } from "./provenance.js";

export interface Evidence {
  readonly id: EvidenceId;
  readonly type: string;
  readonly summary: string;
  readonly value: unknown;
  readonly sourceReferences: readonly string[];
  readonly producer: Provenance;
  readonly createdAt: string;
  readonly contentHash: string;
}
