import { createHash } from "node:crypto";
import {
  brandId,
  toPublicSourceReference,
  validateCheckExecution,
  validateCheckResult,
} from "@verify-agent/domain";
import type {
  CheckExecution,
  CheckResult,
  CheckStatus,
  Provenance,
} from "@verify-agent/domain";
import {
  createTrustedExecutionSpecRegistry,
  type CheckExecutionSpec,
} from "@verify-agent/checks";
import type {
  CheckExecutionOutcome,
  CheckExecutionRequest,
  CheckExecutor,
  ExecutionLimits,
  PublicSandboxJobRequest,
  SandboxCommand,
  SandboxExecutor,
  SandboxJobRequest,
  SandboxJobResult,
} from "./interfaces.js";
import { DEFAULT_EXECUTION_LIMITS } from "./interfaces.js";

const systemProducer: Provenance = {
  type: "system",
  name: "verify-agent",
  version: "0.1.0-phase0",
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function assertLimits(limits: ExecutionLimits): ExecutionLimits {
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1)
    throw new Error("timeoutMs must be a positive integer");
  if (!Number.isInteger(limits.memoryLimitBytes) || limits.memoryLimitBytes < 1)
    throw new Error("memoryLimitBytes must be a positive integer");
  return Object.freeze({ ...limits });
}

function commandFromSpec(spec: CheckExecutionSpec): SandboxCommand {
  return Object.freeze({
    executable: spec.executable,
    args: Object.freeze([...spec.args]),
    workingDirectory: spec.workingDirectory,
    environment: Object.freeze({ ...spec.environment }),
  });
}

export function createExecutionInputHash(
  request: Pick<CheckExecutionRequest, "snapshot" | "definition" | "planItem">,
  spec: CheckExecutionSpec,
): string {
  return sha256({
    source: request.snapshot.source,
    sourceState: request.snapshot.sourceState,
    checkId: request.definition.id,
    checkVersion: request.definition.version,
    planItem: request.planItem,
    spec,
  });
}

export function mapCheckExecutionToSandboxJobRequest(
  request: CheckExecutionRequest,
  specRegistry = createTrustedExecutionSpecRegistry(),
  limits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS,
): SandboxJobRequest {
  if (request.execution.status !== "queued")
    throw new Error("check execution must be queued before mapping");
  if (request.execution.checkDefinitionId !== request.definition.id)
    throw new Error("check execution definition does not match request");
  if (request.planItem.checkId !== request.definition.id)
    throw new Error("plan item definition does not match request");
  const spec = specRegistry.find(request.definition.id);
  if (!spec)
    throw new Error(
      `No trusted execution specification: ${String(request.definition.id)}`,
    );
  const safeLimits = assertLimits(limits);
  return Object.freeze({
    schemaVersion: "1.0.0",
    jobId: request.execution.jobId,
    source: toPublicSourceReference(request.snapshot.source),
    snapshot: request.snapshot.sourceState.value,
    commands: Object.freeze([commandFromSpec(spec)]),
    resourceLimits: safeLimits,
    networkPolicy: "none",
    artifactPolicy: "none",
  });
}

export function toPublicSandboxJobRequest(
  request: SandboxJobRequest,
): PublicSandboxJobRequest {
  return {
    schemaVersion: request.schemaVersion,
    jobId: request.jobId,
    source: request.source,
    snapshot: request.snapshot,
    // The public contract currently carries command entries as strings. JSON
    // preserves argv structure without introducing shell interpretation.
    commands: request.commands.map((command) => JSON.stringify(command)),
    resourceLimits: request.resourceLimits,
    networkPolicy: request.networkPolicy,
    artifactPolicy: request.artifactPolicy,
  };
}

export function transitionCheckExecution(
  execution: CheckExecution,
  nextStatus: CheckExecution["status"],
  times: { readonly startedAt?: string; readonly completedAt?: string } = {},
): CheckExecution {
  const allowed: Record<CheckExecution["status"], readonly string[]> = {
    queued: ["running", "cancelled"],
    running: ["completed", "failed", "timed_out", "cancelled"],
    completed: [],
    failed: [],
    timed_out: [],
    cancelled: [],
  };
  if (!allowed[execution.status].includes(nextStatus))
    throw new Error(
      `Invalid check execution transition: ${execution.status} -> ${nextStatus}`,
    );
  const next: CheckExecution = {
    ...execution,
    status: nextStatus,
    ...(nextStatus === "running" && times.startedAt
      ? { startedAt: times.startedAt }
      : {}),
    ...(nextStatus !== "running" && times.completedAt
      ? { completedAt: times.completedAt }
      : {}),
  };
  validateCheckExecution(next);
  return next;
}

function checkStatus(result: SandboxJobResult): CheckStatus {
  if (result.status === "timed_out") return "timed_out";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "error" || result.status === "failed") return "error";
  return result.exitCode === 0 ? "passed" : "failed";
}

export function mapSandboxJobResultToCheckResult(
  request: CheckExecutionRequest,
  execution: CheckExecution,
  sandboxResult: SandboxJobResult,
): CheckResult {
  if (!execution.executionSource)
    throw new Error(
      "check execution provenance is required before result mapping",
    );
  if (sandboxResult.jobId !== execution.jobId)
    throw new Error("sandbox result job does not match check execution");
  if (
    !["completed", "failed", "timed_out", "cancelled"].includes(
      execution.status,
    )
  )
    throw new Error("check execution must be terminal before result mapping");
  const status = checkStatus(sandboxResult);
  const resultContent = {
    checkExecutionId: execution.id,
    checkId: request.definition.id,
    checkVersion: request.definition.version,
    status,
    exitCode: sandboxResult.exitCode,
    durationMs: sandboxResult.durationMs,
    summary:
      sandboxResult.errors.join("; ") ||
      `${request.definition.name}: ${status}`,
    rawOutputRef: sandboxResult.logsRef,
    artifactRefs: sandboxResult.artifactRefs,
    inputHash: execution.inputsHash,
    executionSource: execution.executionSource,
  };
  const result: CheckResult = {
    id: brandId<"CheckResultId">(request.resultId),
    ...resultContent,
    metrics: {
      memoryBytes: sandboxResult.resourceUsage.memoryBytes,
      cpuTimeMs: sandboxResult.resourceUsage.cpuTimeMs,
    },
    environment: {},
    contentHash: sha256(resultContent),
    createdAt: request.createdAt,
    producer: systemProducer,
  };
  validateCheckResult(result);
  return result;
}

export function createFakeSandboxExecutor(
  result: SandboxJobResult | ((request: SandboxJobRequest) => SandboxJobResult),
): SandboxExecutor & { readonly requests: readonly SandboxJobRequest[] } {
  const requests: SandboxJobRequest[] = [];
  return {
    executionSource: "simulated" as const,
    requests,
    async execute(request) {
      requests.push(request);
      return typeof result === "function" ? result(request) : result;
    },
  };
}

export function createCheckExecutor(
  sandbox: SandboxExecutor,
  specRegistry = createTrustedExecutionSpecRegistry(),
): CheckExecutor {
  return {
    async execute(request): Promise<CheckExecutionOutcome> {
      const spec = specRegistry.find(request.definition.id);
      if (!spec)
        throw new Error(
          `No trusted execution specification: ${String(request.definition.id)}`,
        );
      const inputHash = createExecutionInputHash(request, spec);
      const queued = {
        ...request.execution,
        inputsHash: inputHash,
        executionSource: sandbox.executionSource,
      };
      validateCheckExecution(queued);
      const sandboxRequest = mapCheckExecutionToSandboxJobRequest(
        { ...request, execution: queued },
        specRegistry,
        request.limits,
      );
      const running = transitionCheckExecution(queued, "running");
      const sandboxResult = await sandbox.execute(sandboxRequest);
      const terminalStatus =
        sandboxResult.status === "completed"
          ? sandboxResult.exitCode === 0
            ? "completed"
            : "failed"
          : sandboxResult.status === "error"
            ? "failed"
            : sandboxResult.status;
      const terminal = transitionCheckExecution(running, terminalStatus);
      return {
        request: sandboxRequest,
        execution: terminal,
        result: mapSandboxJobResultToCheckResult(
          { ...request, execution: terminal },
          terminal,
          sandboxResult,
        ),
      };
    },
  };
}
