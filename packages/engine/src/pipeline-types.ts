export interface DetectionContext {
  exists(path: string): boolean;
  readFile(path: string): string | undefined;
  listDirectory(path?: string): readonly string[];
}

export interface DetectionObservation {
  readonly detectorId: string;
  readonly signal: string;
  readonly value: string | boolean;
  readonly evidence: readonly string[];
  readonly confidence: "high" | "medium" | "low";
}

export interface ProjectDetectionResult {
  readonly profile: import("@verify-agent/domain").ProjectProfile;
  readonly observations: readonly DetectionObservation[];
}
