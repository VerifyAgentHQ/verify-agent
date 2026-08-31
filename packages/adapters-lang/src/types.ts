import type { Project, ProjectProfile } from "@verify-agent/domain";

export type SupportedLanguage =
  | "typescript"
  | "rust"
  | "python"
  | "go"
  | "solidity"
  | "java"
  | "csharp"
  | "cpp"
  | "other";

export interface LanguageDetectionResult {
  ecosystem: SupportedLanguage;
  confidence: number;
  detectionNotes: string[];
}

export interface ProjectDetectionContext {
  root: string;
  project: Project;
}

export interface LanguageAdapter {
  detect(context: ProjectDetectionContext): Promise<LanguageDetectionResult>;
  profile(context: ProjectDetectionContext): Promise<ProjectProfile>;
}
