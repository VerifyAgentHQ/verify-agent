import type {
  Project,
  ProjectProfile,
  RepositorySnapshot,
} from "@verify-agent/domain";

export type DetectionConfidence = "high" | "medium" | "low";

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
  readonly confidence: DetectionConfidence;
}

export interface LanguageDetector {
  readonly id: string;
  detect(context: DetectionContext): readonly DetectionObservation[];
}

export interface ProjectDetectionResult {
  readonly profile: ProjectProfile;
  readonly observations: readonly DetectionObservation[];
}

export interface ProjectDetectionService {
  detect(
    project: Project,
    snapshot: RepositorySnapshot,
    context: DetectionContext,
  ): ProjectDetectionResult;
}

export interface LanguageAdapter {
  detect(context: DetectionContext): Promise<readonly DetectionObservation[]>;
}

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "rust"
  | "soroban"
  | "python"
  | "go"
  | "solidity"
  | "java"
  | "csharp"
  | "cpp"
  | "other";
