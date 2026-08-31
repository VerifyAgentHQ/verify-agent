import type {
  CheckExecutionId,
  CheckResultId,
  CheckId,
  VerificationJobId,
} from "./identifiers.js";
import type { Provenance } from "./provenance.js";

export type CheckDeterminism = "deterministic" | "probabilistic" | "hybrid";

export interface CheckDefinition {
  readonly id: CheckId;
  readonly name: string;
  readonly version: string;
  readonly category: string;
  readonly description: string;
  readonly determinism: CheckDeterminism;
  readonly supportedLanguages: readonly string[];
  readonly supportedFrameworks: readonly string[];
  readonly requirements: readonly string[];
}

export type CheckExecutionStatus =
  "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";

export interface CheckExecution {
  readonly id: CheckExecutionId;
  readonly checkDefinitionId: CheckId;
  readonly jobId: VerificationJobId;
  readonly inputsHash: string;
  readonly sandboxExecutionId?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly status: CheckExecutionStatus;
}

export type CheckStatus =
  "passed" | "failed" | "error" | "timed_out" | "cancelled" | "skipped";

export interface CheckResult {
  readonly id: CheckResultId;
  readonly checkExecutionId: CheckExecutionId;
  readonly checkId: CheckId;
  readonly checkVersion: string;
  readonly status: CheckStatus;
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly summary: string;
  readonly rawOutputRef?: string;
  readonly artifactRefs: readonly string[];
  readonly metrics: Readonly<Record<string, number>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly inputHash: string;
  readonly contentHash: string;
  readonly createdAt: string;
  readonly producer: Provenance;
}
