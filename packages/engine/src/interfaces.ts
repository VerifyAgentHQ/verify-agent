import type {
  ChangeSet,
  CheckDefinition,
  Evidence,
  Project,
  ProjectProfile,
  PublicSourceReference,
  VerificationRequest,
  VerificationResult,
} from "@verify-agent/domain";
import { publicContract } from "@verify-agent/domain";

export interface SandboxJobRequest {
  readonly schemaVersion: typeof publicContract.schemaVersion;
  readonly jobId: string;
  readonly source: PublicSourceReference;
  readonly snapshot: string;
  readonly commands: readonly string[];
  readonly resourceLimits: Readonly<{
    timeoutMs: number;
    memoryLimitBytes: number;
  }>;
  readonly networkPolicy: "none" | "restricted" | "allowlist";
  readonly artifactPolicy: "none" | "declared";
}

export interface SandboxJobResult {
  readonly schemaVersion: typeof publicContract.schemaVersion;
  readonly jobId: string;
  readonly status: "completed" | "failed" | "timed_out" | "cancelled" | "error";
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

export interface SandboxExecutor {
  execute(request: SandboxJobRequest): Promise<SandboxJobResult>;
}

export interface ResultAssembler {
  assemble(
    context: EngineContext,
    evidence: Evidence[],
  ): Promise<VerificationResult>;
}

export interface VerificationOrchestrator {
  run(request: VerificationRequest): Promise<VerificationResult>;
}
