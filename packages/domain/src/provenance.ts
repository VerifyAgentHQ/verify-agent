export type ProvenanceType =
  "deterministic_tool" | "ai" | "system" | (string & {});

export interface Provenance {
  readonly type: ProvenanceType;
  readonly name: string;
  readonly version?: string;
}
