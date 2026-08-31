export interface VerificationConfig {
  maxConcurrency: number;
  allowNetwork: boolean;
  executionTimeoutMs: number;
  evidenceRetentionDays: number;
}

export interface AppConfig {
  environment: "development" | "test" | "production";
  verification: VerificationConfig;
  enabledEcosystems: string[];
}
