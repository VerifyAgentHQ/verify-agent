import type { CheckExecutionSpec } from "@verify-agent/checks";
import type {
  ChangeSet,
  CheckDefinition,
  CheckExecution,
  CheckPlanItem,
  CheckResult,
  Evidence,
  Project,
  ProjectProfile,
  PublicSourceReference,
  RepositorySnapshot,
  ExecutionSource,
  VerificationRequest,
  VerificationResult,
} from "@verify-agent/domain";
import { publicContract } from "@verify-agent/domain";

export type SandboxStatus =
  "completed" | "failed" | "timed_out" | "cancelled" | "error";

export interface SandboxCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: ".";
  readonly environment: Readonly<Record<string, string>>;
}

export interface ExecutionLimits {
  readonly timeoutMs: number;
  readonly memoryLimitBytes: number;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = Object.freeze({
  timeoutMs: 120_000,
  memoryLimitBytes: 512 * 1024 * 1024,
});

export interface SandboxJobRequest {
  readonly schemaVersion: typeof publicContract.schemaVersion;
  readonly jobId: string;
  readonly source: PublicSourceReference;
  readonly snapshot: string;
  readonly commands: readonly SandboxCommand[];
  readonly resourceLimits: ExecutionLimits;
  readonly networkPolicy: "none" | "restricted" | "allowlist";
  readonly artifactPolicy: "none" | "declared";
}

/** Wire shape kept separate because verify-contracts currently uses strings. */
export interface PublicSandboxJobRequest {
  readonly schemaVersion: typeof publicContract.schemaVersion;
  readonly jobId: string;
  readonly source: PublicSourceReference;
  readonly snapshot: string;
  readonly commands: readonly string[];
  readonly resourceLimits: ExecutionLimits;
  readonly networkPolicy: "none" | "restricted" | "allowlist";
  readonly artifactPolicy: "none" | "declared";
}

export type PublicSandboxJobResult = SandboxJobResult;

export interface SandboxTransport {
  readonly executionSource: ExecutionSource;
  execute(
    request: PublicSandboxJobRequest,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export type SandboxTransportEvent =
  | { readonly type: "request_started"; readonly jobId: string }
  | { readonly type: "response_received"; readonly jobId: string }
  | { readonly type: "transport_failure"; readonly jobId: string }
  | { readonly type: "timeout"; readonly jobId: string }
  | { readonly type: "cancelled"; readonly jobId: string };

export type SandboxTransportObserver = (event: SandboxTransportEvent) => void;

export interface SandboxJobResult {
  readonly schemaVersion: typeof publicContract.schemaVersion;
  readonly jobId: string;
  readonly status: SandboxStatus;
  readonly durationMs: number;
  readonly logsRef: string;
  readonly artifactRefs: readonly string[];
  readonly resourceUsage: Readonly<{
    memoryBytes: number;
    cpuTimeMs: number;
  }>;
  readonly errors: readonly string[];
  readonly exitCode?: number;
}

export interface CheckExecutionRequest {
  readonly project: Project;
  readonly profile: ProjectProfile;
  readonly snapshot: RepositorySnapshot;
  readonly planItem: CheckPlanItem;
  readonly definition: CheckDefinition;
  readonly execution: CheckExecution;
  readonly resultId: string;
  readonly createdAt: string;
  readonly limits?: ExecutionLimits;
}

export interface CheckExecutionOutcome {
  readonly request: SandboxJobRequest;
  readonly execution: CheckExecution;
  readonly result: CheckResult;
}

export interface SandboxExecutor {
  readonly executionSource: ExecutionSource;
  execute(request: SandboxJobRequest): Promise<SandboxJobResult>;
}

export interface CheckExecutor {
  execute(request: CheckExecutionRequest): Promise<CheckExecutionOutcome>;
}

export type { ExecutionSource };

export interface EngineContext {
  project: Project;
  profile: ProjectProfile;
  request: VerificationRequest;
  changeSet: ChangeSet;
}

export interface ProjectDetector {
  detect(project: Project): Promise<ProjectProfile>;
}

export interface CheckPlanner {
  plan(context: EngineContext): Promise<CheckDefinition[]>;
}

export interface ResultAssembler {
  assemble(
    context: EngineContext,
    evidence: readonly Evidence[],
  ): Promise<VerificationResult>;
}

export interface VerificationOrchestrator {
  run(request: VerificationRequest): Promise<VerificationResult>;
}

export type { CheckExecutionSpec };
