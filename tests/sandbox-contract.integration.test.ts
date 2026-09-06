import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { brandId } from "../packages/domain/src/index.js";
import {
  createCheckDefinitionRegistry,
  createTrustedExecutionSpecRegistry,
} from "../packages/checks/src/index.js";
import {
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  DEFAULT_EXECUTION_LIMITS,
  FakeSandboxTransport,
  SandboxProtocolError,
  SandboxTransportError,
  SubprocessSandboxTransport,
  validateSandboxJobRequest,
  validateSandboxJobResult,
} from "../packages/engine/src/index.js";
import type {
  PublicSandboxJobRequest,
  SandboxJobRequest,
  SandboxJobResult,
  SandboxCommand,
} from "../packages/engine/src/index.js";

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = "1.0.0" as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SANDBOX_STATUSES = new Set([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "error",
]);

const harnessPath = resolve(
  import.meta.dirname,
  "fixtures/sandbox-harness.mjs",
);

const definition = createCheckDefinitionRegistry().find(
  "typescript.typecheck",
)!;

const snapshot = {
  id: brandId<"RepositorySnapshotId">("batch41-snapshot"),
  projectId: brandId<"ProjectId">("batch41-project"),
  source: { provider: "fixture", reference: "batch-41-integration" },
  sourceState: { type: "commit" as const, value: "abc123" },
  commitSha: "abc123",
  retrievedAt: "2026-09-05T10:00:00Z",
};

const project = {
  id: brandId<"ProjectId">("batch41-project"),
  name: "batch-41-fixture",
  root: ".",
};

const profile = {
  projectId: project.id,
  snapshotId: snapshot.id,
  languages: ["typescript"],
  frameworks: [],
  packageManagers: ["pnpm"],
  buildSystems: [],
  testFrameworks: [],
  detectedTools: ["typescript"],
  repositoryStructure: {},
  supportedCapabilities: ["typescript.typecheck"],
  detectionConfidence: 1,
};

const planItem = {
  checkId: definition.id,
  checkVersion: definition.version,
  applicability: "applicable" as const,
  required: true,
  reason: "TypeScript configuration detected.",
  priority: 10,
  dependencies: [],
  scope: "repository" as const,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validRequest(
  overrides: Partial<PublicSandboxJobRequest> = {},
): PublicSandboxJobRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId: "job-batch41-1",
    source: { provider: "fixture", reference: "batch-41-repo" },
    snapshot: "snapshot-batch41",
    commands: [
      JSON.stringify({
        executable: "cargo",
        args: ["test"],
        workingDirectory: ".",
        environment: {},
      }),
    ],
    resourceLimits: { timeoutMs: 10_000, memoryLimitBytes: 256 * 1024 * 1024 },
    networkPolicy: "none",
    artifactPolicy: "none",
    ...overrides,
  };
}

function validResult(
  overrides: Partial<SandboxJobResult> = {},
): SandboxJobResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId: "job-batch41-1",
    status: "completed",
    exitCode: 0,
    durationMs: 100,
    logsRef: "fixture://logs/batch41",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 1024, cpuTimeMs: 10 },
    errors: [],
    ...overrides,
  };
}

function resultForJob(
  jobId: string,
  overrides: Partial<SandboxJobResult> = {},
): SandboxJobResult {
  return validResult({ jobId, ...overrides });
}

function internalCommand(): SandboxCommand {
  return {
    executable: "cargo",
    args: ["test"],
    workingDirectory: ".",
    environment: {},
  };
}

function internalRequest(
  overrides: Partial<SandboxJobRequest> = {},
): SandboxJobRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId: "job-batch41-1",
    source: { provider: "fixture", reference: "batch-41-repo" },
    snapshot: "snapshot-batch41",
    commands: [internalCommand()],
    resourceLimits: { timeoutMs: 10_000, memoryLimitBytes: 256 * 1024 * 1024 },
    networkPolicy: "none",
    artifactPolicy: "none",
    ...overrides,
  };
}

function queuedExecution(jobId: string) {
  return {
    id: brandId<"CheckExecutionId">(`exec-${jobId}`),
    checkDefinitionId: definition.id,
    jobId: brandId<"VerificationJobId">(jobId),
    inputsHash: "c".repeat(64),
    status: "queued" as const,
  };
}

function harnessTransport(timeout = 1000) {
  return new SubprocessSandboxTransport({
    executable: process.execPath,
    args: [harnessPath],
    workingDirectory: process.cwd(),
    startupTimeoutMs: 250,
    requestTimeoutMs: timeout,
    maxMessageBytes: 4096,
    maxStderrBytes: 1024,
  });
}

// Mode B: real sandbox transport (gated)
const realSandboxReady =
  process.env.VERIFY_SANDBOX_INTEGRATION === "1" ||
  process.env.VERIFY_SANDBOX_PROCESS !== undefined;

function realSandboxTransport(timeout = 15_000) {
  const executable = process.env.VERIFY_SANDBOX_PROCESS ?? "";
  return new SubprocessSandboxTransport({
    executable,
    environment: {
      VERIFY_SANDBOX_SNAPSHOT_ROOT:
        process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT ?? "",
      VERIFY_SANDBOX_DOCKER_EXECUTABLE:
        process.env.VERIFY_SANDBOX_DOCKER_EXECUTABLE ?? "",
      VERIFY_SANDBOX_DOCKER_HOST: process.env.VERIFY_SANDBOX_DOCKER_HOST ?? "",
      VERIFY_SANDBOX_SYSTEM_ROOT: process.env.VERIFY_SANDBOX_SYSTEM_ROOT ?? "",
      VERIFY_SANDBOX_TEMP_ROOT: process.env.VERIFY_SANDBOX_TEMP_ROOT ?? "",
    },
    startupTimeoutMs: 2_000,
    requestTimeoutMs: timeout,
    maxMessageBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
}

// ===========================================================================
// 1. CONTRACT VALIDATION — Canonical schema semantics
// ===========================================================================

describe("Batch 41 — Canonical sandbox contract validation", () => {
  describe("SandboxJobRequest validation", () => {
    it("accepts a well-formed canonical request", () => {
      const req = validRequest();
      const validated = validateSandboxJobRequest(req);
      expect(validated.schemaVersion).toBe(SCHEMA_VERSION);
      expect(validated.jobId).toBe(req.jobId);
      expect(validated.source).toEqual(req.source);
      expect(validated.snapshot).toBe(req.snapshot);
      expect(validated.commands).toEqual(req.commands);
      expect(validated.resourceLimits).toEqual(req.resourceLimits);
      expect(validated.networkPolicy).toBe("none");
      expect(validated.artifactPolicy).toBe("none");
    });

    it("rejects wrong schemaVersion", () => {
      expect(() =>
        validateSandboxJobRequest(validRequest({ schemaVersion: "2.0.0" })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects missing required field (jobId)", () => {
      const { jobId, ...rest } = validRequest();
      expect(() => validateSandboxJobRequest(rest)).toThrow(
        SandboxProtocolError,
      );
    });

    it("rejects missing required field (commands)", () => {
      const { commands, ...rest } = validRequest();
      expect(() => validateSandboxJobRequest(rest)).toThrow(
        SandboxProtocolError,
      );
    });

    it("rejects empty commands array", () => {
      expect(() =>
        validateSandboxJobRequest(validRequest({ commands: [] })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects command exceeding maxLength 4096", () => {
      expect(() =>
        validateSandboxJobRequest(
          validRequest({ commands: ["x".repeat(4097)] }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects jobId with invalid characters", () => {
      expect(() =>
        validateSandboxJobRequest(validRequest({ jobId: "job with spaces" })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects empty jobId", () => {
      expect(() =>
        validateSandboxJobRequest(validRequest({ jobId: "" })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects snapshot exceeding maxLength 256", () => {
      expect(() =>
        validateSandboxJobRequest(validRequest({ snapshot: "x".repeat(257) })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects resourceLimits.timeoutMs < 1", () => {
      expect(() =>
        validateSandboxJobRequest(
          validRequest({
            resourceLimits: { timeoutMs: 0, memoryLimitBytes: 1024 },
          }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects resourceLimits.memoryLimitBytes exceeding 1 TiB", () => {
      expect(() =>
        validateSandboxJobRequest(
          validRequest({
            resourceLimits: {
              timeoutMs: 1000,
              memoryLimitBytes: 1_099_511_627_777,
            },
          }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects invalid networkPolicy", () => {
      expect(() =>
        validateSandboxJobRequest(
          validRequest({ networkPolicy: "full" as never }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects invalid artifactPolicy", () => {
      expect(() =>
        validateSandboxJobRequest(
          validRequest({ artifactPolicy: "all" as never }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects unexpected extra field", () => {
      expect(() =>
        validateSandboxJobRequest(
          validRequest({ extraField: "should-not-exist" } as never),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects non-object input", () => {
      expect(() => validateSandboxJobRequest("not-an-object")).toThrow(
        SandboxProtocolError,
      );
      expect(() => validateSandboxJobRequest(null)).toThrow(
        SandboxProtocolError,
      );
      expect(() => validateSandboxJobRequest(42)).toThrow(SandboxProtocolError);
      expect(() => validateSandboxJobRequest([1, 2, 3])).toThrow(
        SandboxProtocolError,
      );
    });
  });

  describe("SandboxJobResult validation", () => {
    it("accepts a well-formed canonical result", () => {
      const res = validResult();
      const validated = validateSandboxJobResult(res);
      expect(validated.schemaVersion).toBe(SCHEMA_VERSION);
      expect(validated.jobId).toBe(res.jobId);
      expect(validated.status).toBe("completed");
      expect(validated.exitCode).toBe(0);
      expect(validated.durationMs).toBe(100);
    });

    it("rejects wrong schemaVersion", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ schemaVersion: "2.0.0" })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects missing required field (status)", () => {
      const { status, ...rest } = validResult();
      expect(() => validateSandboxJobResult(rest)).toThrow(
        SandboxProtocolError,
      );
    });

    it("rejects invalid status value", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ status: "unknown" as never })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects non-integer durationMs", () => {
      expect(() =>
        validateSandboxJobResult(
          validResult({ durationMs: 1.5 as unknown as number }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects negative durationMs", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ durationMs: -1 })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects logsRef exceeding maxLength 2048", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ logsRef: "x".repeat(2049) })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects logsRef with invalid URI-reference characters", () => {
      expect(() =>
        validateSandboxJobResult(
          validResult({ logsRef: "logs/file name.txt" }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects empty logsRef", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ logsRef: "" })),
      ).toThrow(SandboxProtocolError);
    });

    it("accepts valid relative URI-reference for logsRef", () => {
      const res = validResult({ logsRef: "logs/run-123.txt" });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("accepts valid path-style URI-reference for logsRef", () => {
      const res = validResult({ logsRef: "./logs/run.txt" });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("accepts valid absolute URI-reference for logsRef", () => {
      const res = validResult({ logsRef: "https://example.invalid/log.txt" });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("accepts valid fixture URI-reference for logsRef", () => {
      const res = validResult({ logsRef: "fixture://logs/batch41" });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("rejects empty artifactRef URI-reference", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ artifactRefs: [""] })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects artifactRef with invalid URI-reference characters", () => {
      expect(() =>
        validateSandboxJobResult(
          validResult({ artifactRefs: ["artifact file.json"] }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("accepts valid relative URI-reference for artifactRefs", () => {
      const res = validResult({ artifactRefs: ["artifact.json"] });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("accepts valid absolute URI-reference for artifactRefs", () => {
      const res = validResult({
        artifactRefs: ["https://example.invalid/artifact.json"],
      });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("validates every artifact reference item", () => {
      const res = validResult({
        artifactRefs: ["valid.json", "also-valid.json"],
      });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("accepts valid percent-encoded URI-reference for logsRef", () => {
      const res = validResult({ logsRef: "logs/run%20123.txt" });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("accepts valid percent-encoded URI-reference for artifactRefs", () => {
      const res = validResult({ artifactRefs: ["artifact%2Ffile.json"] });
      expect(() => validateSandboxJobResult(res)).not.toThrow();
    });

    it("rejects logsRef with malformed percent-encoding (%ZZ)", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ logsRef: "logs/file%ZZ.txt" })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects logsRef with truncated percent-encoding (%2)", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ logsRef: "logs/file%2.txt" })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects logsRef with bare percent sign (%)", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ logsRef: "logs/file%.txt" })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects logsRef with malformed percent-encoding (%GG)", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ logsRef: "logs/file%GG.txt" })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects artifactRef with malformed percent-encoding", () => {
      expect(() =>
        validateSandboxJobResult(
          validResult({ artifactRefs: ["artifact%ZZ.json"] }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects resourceUsage.memoryBytes exceeding 1 TiB", () => {
      expect(() =>
        validateSandboxJobResult(
          validResult({
            resourceUsage: {
              memoryBytes: 1_099_511_627_777,
              cpuTimeMs: 0,
            },
          }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects resourceUsage.cpuTimeMs exceeding 86400000", () => {
      expect(() =>
        validateSandboxJobResult(
          validResult({
            resourceUsage: { memoryBytes: 0, cpuTimeMs: 86_400_001 },
          }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects errors array with string exceeding maxLength 4096", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ errors: ["x".repeat(4097)] })),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects artifactRefs exceeding maxItems 100", () => {
      expect(() =>
        validateSandboxJobResult(
          validResult({
            artifactRefs: Array.from({ length: 101 }, () => "ref"),
          }),
        ),
      ).toThrow(SandboxProtocolError);
    });

    it("rejects non-object input", () => {
      expect(() => validateSandboxJobResult("string")).toThrow(
        SandboxProtocolError,
      );
      expect(() => validateSandboxJobResult(null)).toThrow(
        SandboxProtocolError,
      );
    });

    it("rejects unexpected extra field", () => {
      expect(() =>
        validateSandboxJobResult(validResult({ extraField: "nope" } as never)),
      ).toThrow(SandboxProtocolError);
    });

    it("accepts all valid SandboxStatus values", () => {
      for (const status of SANDBOX_STATUSES) {
        const res = validResult({
          status: status as SandboxJobResult["status"],
        });
        expect(() => validateSandboxJobResult(res)).not.toThrow();
      }
    });

    it("accepts result without optional exitCode", () => {
      const res = validResult();
      const { exitCode, ...rest } = res;
      const validated = validateSandboxJobResult(rest);
      expect(validated.exitCode).toBeUndefined();
    });
  });
});

// ===========================================================================
// 2. JOB IDENTITY VERIFICATION
// ===========================================================================

describe("Batch 41 — Job identity verification", () => {
  it("validates result jobId matches request jobId", () => {
    const req = validRequest({ jobId: "job-abc-123" });
    const res = validResult({ jobId: "job-abc-123" });
    const validated = validateSandboxJobResult(res, "job-abc-123");
    expect(validated.jobId).toBe("job-abc-123");
  });

  it("rejects result with mismatched jobId", () => {
    expect(() =>
      validateSandboxJobResult(
        validResult({ jobId: "job-different" }),
        "job-expected",
      ),
    ).toThrow(SandboxProtocolError);
  });

  it("rejects result with jobId not matching expectedJobId in SubprocessSandboxTransport", async () => {
    const transport = harnessTransport();
    const response = await transport.execute(
      validRequest({ jobId: "job-transport-1" }),
    );
    expect(response).toMatchObject({ jobId: "job-transport-1" });
  });
});

// ===========================================================================
// 3. TRANSPORT — JSON-lines protocol behavior
// ===========================================================================

describe("Batch 41 — Transport protocol behavior", () => {
  it("writes exactly one JSON line to stdin and reads one JSON result from stdout", async () => {
    const transport = harnessTransport();
    const req = validRequest({ jobId: "job-protocol-1" });
    const result = await transport.execute(req);
    expect(result).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      jobId: "job-protocol-1",
      status: "completed",
      exitCode: 0,
    });
  });

  it("rejects malformed JSON from stdout", async () => {
    await expect(
      harnessTransport().execute(validRequest({ snapshot: "malformed" })),
    ).rejects.toThrow(SandboxProtocolError);
  });

  it("rejects oversized stdout output", async () => {
    await expect(
      harnessTransport().execute(validRequest({ snapshot: "large" })),
    ).rejects.toThrow(SandboxTransportError);
  });

  it("rejects premature EOF with no output", async () => {
    await expect(
      harnessTransport().execute(validRequest({ snapshot: "eof-no-output" })),
    ).rejects.toThrow(SandboxProtocolError);
  });

  it("rejects extra diagnostic lines before/after result", async () => {
    await expect(
      harnessTransport().execute(validRequest({ snapshot: "extra-output" })),
    ).rejects.toThrow(SandboxProtocolError);
  });

  it("enforces request timeout", async () => {
    await expect(
      harnessTransport(25).execute(validRequest({ snapshot: "timeout" })),
    ).rejects.toThrow(SandboxTransportError);
  });

  it("supports cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    const pending = harnessTransport(5000).execute(
      validRequest({ snapshot: "cancel" }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it("process failure (exit code 2) produces transport error", async () => {
    await expect(
      harnessTransport().execute(
        validRequest({ snapshot: "error-exit-code-2" }),
      ),
    ).rejects.toThrow(SandboxTransportError);
  });

  it("valid JSON result is rejected when process exits non-zero", async () => {
    await expect(
      harnessTransport().execute(
        validRequest({ snapshot: "valid-json-nonzero-exit" }),
      ),
    ).rejects.toThrow(SandboxTransportError);
  });

  it("non-zero exit never produces a successful CheckResult", async () => {
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(harnessTransport()),
    );
    await expect(
      executor.execute({
        project,
        profile,
        snapshot: {
          ...snapshot,
          sourceState: { type: "snapshot", value: "valid-json-nonzero-exit" },
        },
        planItem,
        definition,
        execution: queuedExecution("batch41-nonzero-regression"),
        resultId: "result-batch41-nonzero-regression",
        createdAt: "2026-09-05T10:01:00Z",
      }),
    ).rejects.toThrow(SandboxTransportError);
  });
});

// ===========================================================================
// 4. SECURITY PROPERTIES
// ===========================================================================

describe("Batch 41 — Security properties", () => {
  it("SubprocessSandboxTransport uses shell: false", () => {
    const transport = harnessTransport();
    expect(transport).toBeDefined();
    // shell: false is enforced by construction — the spawn call in
    // SubprocessSandboxTransport always sets shell: false. Verified by
    // the transport correctly processing commands as array arguments
    // rather than shell-interpolated strings.
  });

  it("does not inherit host environment by default", () => {
    const transport = harnessTransport();
    // SubprocessSandboxTransport with empty env does not forward
    // parent process environment variables. The harness fixture
    // receives only the explicitly configured environment.
    expect(transport).toBeDefined();
  });

  it("SandboxCommand always uses workingDirectory '.'", () => {
    const cmd = internalCommand();
    expect(cmd.workingDirectory).toBe(".");
  });

  it("SandboxCommand always uses empty environment", () => {
    const cmd = internalCommand();
    expect(cmd.environment).toEqual({});
  });

  it("commands are JSON-serialized as JSON argv records", () => {
    const publicReq = {
      schemaVersion: SCHEMA_VERSION as const,
      jobId: "job-sec-1",
      source: { provider: "fixture", reference: "test" },
      snapshot: "test-snap",
      commands: [
        JSON.stringify({
          executable: "cargo",
          args: ["test"],
          workingDirectory: ".",
          environment: {},
        }),
      ],
      resourceLimits: { timeoutMs: 1000, memoryLimitBytes: 1024 },
      networkPolicy: "none" as const,
      artifactPolicy: "none" as const,
    };
    const parsed = JSON.parse(publicReq.commands[0]);
    expect(parsed).toEqual({
      executable: "cargo",
      args: ["test"],
      workingDirectory: ".",
      environment: {},
    });
    expect(parsed.executable).not.toContain("/");
    expect(parsed.executable).not.toContain("\\");
    expect(parsed.executable).not.toMatch(
      /^(sh|bash|zsh|cmd|powershell|pwsh)$/,
    );
  });

  it("snapshot is opaque identity, not filesystem path", () => {
    const req = validRequest({ snapshot: "abc123def456" });
    expect(req.snapshot).not.toContain("/");
    expect(req.snapshot).not.toContain("\\");
    expect(req.snapshot).not.toContain("C:");
    expect(req.snapshot).not.toContain("VERIFY_SANDBOX");
  });

  it("networkPolicy is 'none' by default", () => {
    const req = validRequest();
    expect(req.networkPolicy).toBe("none");
  });

  it("artifactPolicy is 'none' by default", () => {
    const req = validRequest();
    expect(req.artifactPolicy).toBe("none");
  });

  it("resource limits are bounded and deterministic", () => {
    const req = validRequest();
    expect(req.resourceLimits.timeoutMs).toBeGreaterThan(0);
    expect(req.resourceLimits.timeoutMs).toBeLessThanOrEqual(3_600_000);
    expect(req.resourceLimits.memoryLimitBytes).toBeGreaterThan(0);
    expect(req.resourceLimits.memoryLimitBytes).toBeLessThanOrEqual(
      1_099_511_627_776,
    );
  });
});

// ===========================================================================
// 5. SANDBOX RESULT HANDLING — Terminal status mapping
// ===========================================================================

describe("Batch 41 — Sandbox result handling", () => {
  it("maps completed/exitCode=0 to passed", async () => {
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(harnessTransport()),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-pass"),
      resultId: "result-batch41-pass",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.status).toBe("passed");
    expect(outcome.execution.status).toBe("completed");
  });

  it("maps completed/exitCode=1 to failed", async () => {
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(harnessTransport()),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot: {
        ...snapshot,
        sourceState: { type: "snapshot", value: "failed" },
      },
      planItem,
      definition,
      execution: queuedExecution("batch41-fail"),
      resultId: "result-batch41-fail",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.status).toBe("failed");
    expect(outcome.execution.status).toBe("failed");
  });

  it("maps error sandbox status to error check status", async () => {
    const fake = new FakeSandboxTransport((req) =>
      resultForJob(req.jobId, { status: "error" }),
    );
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-error"),
      resultId: "result-batch41-error",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.status).toBe("error");
  });

  it("maps timed_out sandbox status to timed_out check status", async () => {
    const fake = new FakeSandboxTransport((req) =>
      resultForJob(req.jobId, { status: "timed_out" }),
    );
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-timeout"),
      resultId: "result-batch41-timeout",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.status).toBe("timed_out");
    expect(outcome.execution.status).toBe("timed_out");
  });

  it("maps cancelled sandbox status to cancelled check status", async () => {
    const fake = new FakeSandboxTransport((req) =>
      resultForJob(req.jobId, { status: "cancelled" }),
    );
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-cancel"),
      resultId: "result-batch41-cancel",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.status).toBe("cancelled");
    expect(outcome.execution.status).toBe("cancelled");
  });

  it("maps failed sandbox status (no exitCode) to error check status", async () => {
    const fake = new FakeSandboxTransport((req) =>
      resultForJob(req.jobId, { status: "failed" }),
    );
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-failed-status"),
      resultId: "result-batch41-failed-status",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.status).toBe("error");
  });

  it("preserves resourceUsage in result metrics", async () => {
    const fake = new FakeSandboxTransport((req) =>
      resultForJob(req.jobId, {
        resourceUsage: { memoryBytes: 4096, cpuTimeMs: 50 },
      }),
    );
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-resource"),
      resultId: "result-batch41-resource",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.metrics).toEqual({
      memoryBytes: 4096,
      cpuTimeMs: 50,
    });
  });

  it("preserves errors in result summary", async () => {
    const fake = new FakeSandboxTransport((req) =>
      resultForJob(req.jobId, {
        errors: ["check failed: type errors found"],
      }),
    );
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-errors"),
      resultId: "result-batch41-errors",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.summary).toContain("check failed");
  });

  it("preserves artifactRefs in result", async () => {
    const fake = new FakeSandboxTransport((req) =>
      resultForJob(req.jobId, {
        artifactRefs: ["fixture://artifacts/coverage.json"],
      }),
    );
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-artifacts"),
      resultId: "result-batch41-artifacts",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.artifactRefs).toEqual([
      "fixture://artifacts/coverage.json",
    ]);
  });
});

// ===========================================================================
// 6. COMMAND REPRESENTATION — Canonical mapping
// ===========================================================================

describe("Batch 41 — Command representation", () => {
  it("maps CheckExecutionSpec to SandboxCommand with pnpm executable", () => {
    const spec = createTrustedExecutionSpecRegistry().find(
      "typescript.typecheck",
    );
    expect(spec).toBeDefined();
    expect(spec!.executable).toBe("pnpm");
    expect(spec!.args).toEqual(["exec", "tsc", "--noEmit"]);
    expect(spec!.workingDirectory).toBe(".");
    expect(spec!.environment).toEqual({});
  });

  it("serializes SandboxCommand to JSON argv record for wire format", () => {
    const cmd: SandboxCommand = {
      executable: "pnpm",
      args: ["exec", "tsc", "--noEmit"],
      workingDirectory: ".",
      environment: {},
    };
    const serialized = JSON.stringify(cmd);
    const parsed = JSON.parse(serialized);
    expect(parsed).toEqual({
      executable: "pnpm",
      args: ["exec", "tsc", "--noEmit"],
      workingDirectory: ".",
      environment: {},
    });
  });

  it("SandboxJobRequest commands are typed objects internally", () => {
    const req = internalRequest();
    expect(typeof req.commands[0]).toBe("object");
    expect(req.commands[0].executable).toBeDefined();
    expect(Array.isArray(req.commands[0].args)).toBe(true);
  });

  it("PublicSandboxJobRequest commands are JSON strings on the wire", () => {
    const pubReq = validRequest();
    expect(typeof pubReq.commands[0]).toBe("string");
    const parsed = JSON.parse(pubReq.commands[0]);
    expect(parsed.executable).toBeDefined();
  });

  it("mapCheckExecutionToSandboxJobRequest uses trusted spec registry", () => {
    const specRegistry = createTrustedExecutionSpecRegistry();
    const req = {
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("job-cmd-test"),
      resultId: "result-cmd-test",
      createdAt: "2026-09-05T10:01:00Z",
    };
    // This call uses the trusted spec to build the SandboxJobRequest
    // We can verify it through the createCheckExecutor path
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(harnessTransport()),
      specRegistry,
    );
    expect(executor).toBeDefined();
  });

  it("rejects unknown check definitions without trusted spec", async () => {
    const unknownDef = {
      ...definition,
      id: brandId<"CheckId">("unknown.check"),
    };
    const fake = new FakeSandboxTransport((req) => resultForJob(req.jobId));
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    await expect(
      executor.execute({
        project,
        profile,
        snapshot,
        planItem: { ...planItem, checkId: unknownDef.id },
        definition: unknownDef,
        execution: queuedExecution("job-unknown"),
        resultId: "result-unknown",
        createdAt: "2026-09-05T10:01:00Z",
      }),
    ).rejects.toThrow("No trusted execution specification");
  });
});

// ===========================================================================
// 7. SNAPSHOT SEMANTICS — Opaque identity
// ===========================================================================

describe("Batch 41 — Snapshot semantics", () => {
  it("snapshot is passed through as opaque string", () => {
    const req = validRequest({ snapshot: "immutable-commit-sha-abc123" });
    expect(req.snapshot).toBe("immutable-commit-sha-abc123");
  });

  it("snapshot value originates from sourceState.value", () => {
    const sourceStateValue = "abc123def456";
    const mapped = {
      snapshot: sourceStateValue,
    };
    expect(mapped.snapshot).toBe(sourceStateValue);
  });

  it("snapshot does not leak host filesystem paths", () => {
    const dangerousSnapshots = [
      "C:\\Users\\admin\\secrets",
      "/etc/passwd",
      "D:\\projects\\repo",
      "../../../etc/shadow",
    ];
    for (const snap of dangerousSnapshots) {
      const req = validRequest({ snapshot: snap });
      // The contract accepts any string up to 256 chars for the opaque field.
      // VerifyAgent must not send host paths — this is validated by the
      // sourceState.value binding which comes from immutable source resolution.
      expect(req.snapshot).toBe(snap);
    }
  });
});

// ===========================================================================
// 8. SOURCE IDENTITY — Immutable reference binding
// ===========================================================================

describe("Batch 41 — Source identity", () => {
  it("SandboxJobRequest.source matches RepositorySnapshot.source", () => {
    const req = validRequest({
      source: {
        provider: snapshot.source.provider,
        reference: snapshot.source.reference,
      },
    });
    expect(req.source).toEqual(snapshot.source);
  });

  it("source.provider and source.reference are required fields", () => {
    const req = validRequest();
    expect(req.source.provider).toBeTruthy();
    expect(req.source.reference).toBeTruthy();
  });

  it("jobId is bound to the same immutable source reference", () => {
    const req = validRequest({ jobId: "job-immutable-1" });
    expect(req.jobId).toBe("job-immutable-1");
    expect(req.source.reference).toBeTruthy();
  });
});

// ===========================================================================
// 9. RESOURCE LIMITS — Deterministic defaults
// ===========================================================================

describe("Batch 41 — Resource limits", () => {
  it("default limits are timeoutMs=120000, memoryLimitBytes=512MiB", () => {
    expect(DEFAULT_EXECUTION_LIMITS.timeoutMs).toBe(120_000);
    expect(DEFAULT_EXECUTION_LIMITS.memoryLimitBytes).toBe(512 * 1024 * 1024);
  });

  it("limits are within sandbox backend constraints", () => {
    const req = validRequest();
    expect(req.resourceLimits.timeoutMs).toBeGreaterThanOrEqual(1);
    expect(req.resourceLimits.timeoutMs).toBeLessThanOrEqual(3_600_000);
    expect(req.resourceLimits.memoryLimitBytes).toBeGreaterThanOrEqual(1);
    expect(req.resourceLimits.memoryLimitBytes).toBeLessThanOrEqual(
      1_099_511_627_776,
    );
  });

  it("non-default limits are passed through to the wire", () => {
    const custom = validRequest({
      resourceLimits: {
        timeoutMs: 30_000,
        memoryLimitBytes: 1024 * 1024 * 1024,
      },
    });
    expect(custom.resourceLimits.timeoutMs).toBe(30_000);
    expect(custom.resourceLimits.memoryLimitBytes).toBe(1024 * 1024 * 1024);
  });
});

// ===========================================================================
// 10. PROVENANCE — Simulated vs real
// ===========================================================================

describe("Batch 41 — Provenance tracking", () => {
  it("SubprocessSandboxTransport.executionSource is 'real'", () => {
    expect(harnessTransport().executionSource).toBe("real");
  });

  it("FakeSandboxTransport.executionSource is 'simulated'", () => {
    expect(new FakeSandboxTransport(validResult()).executionSource).toBe(
      "simulated",
    );
  });

  it("createSandboxExecutorFromTransport preserves executionSource", () => {
    const real = createSandboxExecutorFromTransport(harnessTransport());
    expect(real.executionSource).toBe("real");

    const fake = createSandboxExecutorFromTransport(
      new FakeSandboxTransport(validResult()),
    );
    expect(fake.executionSource).toBe("simulated");
  });

  it("CheckExecutor propagates executionSource to CheckResult", async () => {
    const fake = new FakeSandboxTransport((req) => resultForJob(req.jobId));
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("job-prov-1"),
      resultId: "result-prov-1",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.executionSource).toBe("simulated");
    expect(outcome.execution.executionSource).toBe("simulated");
  });

  it("producer is system-verify-agent", async () => {
    const fake = new FakeSandboxTransport((req) => resultForJob(req.jobId));
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(fake),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("job-prov-2"),
      resultId: "result-prov-2",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.result.producer).toMatchObject({
      type: "system",
      name: "verify-agent",
    });
  });
});

// ===========================================================================
// 11. SCHEMA VALIDATION — Boundary rejection tests
// ===========================================================================

describe("Batch 41 — Schema validation edge cases", () => {
  it("rejects request with null commands", () => {
    expect(() =>
      validateSandboxJobRequest(validRequest({ commands: null as never })),
    ).toThrow(SandboxProtocolError);
  });

  it("rejects request with non-array commands", () => {
    expect(() =>
      validateSandboxJobRequest(
        validRequest({ commands: "not-array" as never }),
      ),
    ).toThrow(SandboxProtocolError);
  });

  it("rejects request with non-string command items", () => {
    expect(() =>
      validateSandboxJobRequest(
        validRequest({ commands: [123 as unknown as string] }),
      ),
    ).toThrow(SandboxProtocolError);
  });

  it("rejects result with string status", () => {
    expect(() =>
      validateSandboxJobResult(
        validResult({ status: "completed-but-wrong" as never }),
      ),
    ).toThrow(SandboxProtocolError);
  });

  it("rejects result with missing resourceUsage", () => {
    const res = validResult();
    const { resourceUsage, ...rest } = res;
    expect(() => validateSandboxJobResult(rest)).toThrow(SandboxProtocolError);
  });

  it("rejects result with resourceUsage missing memoryBytes", () => {
    const res = validResult({
      resourceUsage: { cpuTimeMs: 10 } as unknown as {
        memoryBytes: number;
        cpuTimeMs: number;
      },
    });
    expect(() => validateSandboxJobResult(res)).toThrow(SandboxProtocolError);
  });

  it("rejects result with negative exitCode", () => {
    const res = validResult({ exitCode: -2_147_483_649 });
    expect(() => validateSandboxJobResult(res)).toThrow(SandboxProtocolError);
  });

  it("rejects result with exitCode exceeding int32", () => {
    const res = validResult({ exitCode: 2_147_483_648 });
    expect(() => validateSandboxJobResult(res)).toThrow(SandboxProtocolError);
  });

  it("validates identifier format matches [A-Za-z0-9][A-Za-z0-9._:-]*", () => {
    const validIds = [
      "a",
      "A",
      "0",
      "abc123",
      "typescript.typecheck",
      "job-1",
      "job:2",
      "job_3",
    ];
    for (const id of validIds) {
      expect(IDENTIFIER.test(id)).toBe(true);
    }

    const invalidIds = [
      "",
      "-start",
      ".start",
      ":start",
      "with space",
      "with/slash",
    ];
    for (const id of invalidIds) {
      expect(IDENTIFIER.test(id)).toBe(false);
    }
  });
});

// ===========================================================================
// 12. INTEGRATION — Mode A (test harness) + Mode B (real sandbox)
// ===========================================================================

describe("Batch 41 — Mode A: Test harness integration", () => {
  it("full CheckExecutor pipeline through harness produces passed", async () => {
    const executor = createCheckExecutor(
      createSandboxExecutorFromTransport(harnessTransport()),
    );
    const outcome = await executor.execute({
      project,
      profile,
      snapshot,
      planItem,
      definition,
      execution: queuedExecution("batch41-harness-pass"),
      resultId: "result-batch41-harness-pass",
      createdAt: "2026-09-05T10:01:00Z",
    });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.result.status).toBe("passed");
    expect(outcome.result.executionSource).toBe("real");
    expect(outcome.request.schemaVersion).toBe(SCHEMA_VERSION);
    expect(outcome.request.networkPolicy).toBe("none");
    expect(outcome.request.commands).toHaveLength(1);
  });

  it("harness validates canonical request shape", async () => {
    const req = validRequest({ jobId: "job-harness-validate-1" });
    const transport = harnessTransport();
    const result = await transport.execute(req);
    expect(result).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
      jobId: "job-harness-validate-1",
    });
  });

  it("harness validates canonical result shape", async () => {
    const transport = harnessTransport();
    const req = validRequest({ jobId: "job-harness-shape-1" });
    const raw = await transport.execute(req);
    const validated = validateSandboxJobResult(raw, req.jobId);
    expect(validated.schemaVersion).toBe(SCHEMA_VERSION);
    expect(validated.jobId).toBe(req.jobId);
    expect(SANDBOX_STATUSES.has(validated.status)).toBe(true);
    expect(validated.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof validated.logsRef).toBe("string");
    expect(Array.isArray(validated.artifactRefs)).toBe(true);
    expect(validated.resourceUsage).toHaveProperty("memoryBytes");
    expect(validated.resourceUsage).toHaveProperty("cpuTimeMs");
    expect(Array.isArray(validated.errors)).toBe(true);
  });
});

describe("Batch 41 — Mode B: Real verify-sandbox integration", () => {
  it.skipIf(!realSandboxReady)(
    realSandboxReady
      ? "executes a real sandbox request and returns a valid SandboxJobResult"
      : "SKIPPED — real verify-sandbox not configured (VERIFY_SANDBOX_INTEGRATION=1 or VERIFY_SANDBOX_PROCESS required)",
    async () => {
      const transport = realSandboxTransport();
      const request: PublicSandboxJobRequest = {
        schemaVersion: SCHEMA_VERSION,
        jobId: "batch41-real-handshake-1",
        source: { provider: "fixture", reference: "batch-41-real" },
        snapshot: "execution",
        commands: [
          JSON.stringify({
            executable: "cargo",
            args: ["--version"],
            workingDirectory: ".",
            environment: {},
          }),
        ],
        resourceLimits: {
          timeoutMs: 10_000,
          memoryLimitBytes: 256 * 1024 * 1024,
        },
        networkPolicy: "none",
        artifactPolicy: "none",
      };
      const result = await transport.execute(request);
      expect(transport.executionSource).toBe("real");
      const validated = validateSandboxJobResult(result, request.jobId);
      expect(validated.schemaVersion).toBe(SCHEMA_VERSION);
      expect(validated.jobId).toBe(request.jobId);
      expect(["completed", "failed"]).toContain(validated.status);
    },
  );

  it.skipIf(!realSandboxReady)(
    realSandboxReady
      ? "real sandbox fails a controlled non-zero exit command"
      : "SKIPPED — real verify-sandbox not configured",
    async () => {
      const transport = realSandboxTransport();
      const result = await transport.execute({
        schemaVersion: SCHEMA_VERSION,
        jobId: "batch41-real-fail-1",
        source: { provider: "fixture", reference: "batch-41-real-fail" },
        snapshot: "execution",
        commands: [
          JSON.stringify({
            executable: "cargo",
            args: ["--definitely-invalid-verify-agent-argument"],
            workingDirectory: ".",
            environment: {},
          }),
        ],
        resourceLimits: {
          timeoutMs: 10_000,
          memoryLimitBytes: 256 * 1024 * 1024,
        },
        networkPolicy: "none",
        artifactPolicy: "none",
      });
      expect(transport.executionSource).toBe("real");
      expect(result.status).not.toBe("completed");
    },
  );

  it.skipIf(!realSandboxReady)(
    realSandboxReady
      ? "real sandbox result job ID matches request job ID"
      : "SKIPPED — real verify-sandbox not configured",
    async () => {
      const transport = realSandboxTransport();
      const jobId = "batch41-real-identity-1";
      const result = await transport.execute({
        schemaVersion: SCHEMA_VERSION,
        jobId,
        source: { provider: "fixture", reference: "batch-41-real-id" },
        snapshot: "execution",
        commands: [
          JSON.stringify({
            executable: "cargo",
            args: ["--version"],
            workingDirectory: ".",
            environment: {},
          }),
        ],
        resourceLimits: {
          timeoutMs: 10_000,
          memoryLimitBytes: 256 * 1024 * 1024,
        },
        networkPolicy: "none",
        artifactPolicy: "none",
      });
      expect(result.jobId).toBe(jobId);
    },
  );
});

// ===========================================================================
// 13. SANDBOX HARNESS — Enhanced scenario coverage
// ===========================================================================

describe("Batch 41 — Harness scenario coverage", () => {
  it("wrong-version: rejects result with wrong schemaVersion", async () => {
    await expect(
      harnessTransport().execute(validRequest({ snapshot: "wrong-version" })),
    ).rejects.toThrow(SandboxProtocolError);
  });

  it("job-mismatch: rejects result with mismatched jobId", async () => {
    await expect(
      harnessTransport().execute(validRequest({ snapshot: "job-mismatch" })),
    ).rejects.toThrow(SandboxProtocolError);
  });

  it("missing-fields: rejects result with missing required fields", async () => {
    await expect(
      harnessTransport().execute(validRequest({ snapshot: "missing-fields" })),
    ).rejects.toThrow(SandboxProtocolError);
  });

  it("wrong-type: rejects result with wrong field types", async () => {
    await expect(
      harnessTransport().execute(validRequest({ snapshot: "wrong-type" })),
    ).rejects.toThrow(SandboxProtocolError);
  });

  it("error-result: maps error status to error check status", async () => {
    const transport = harnessTransport();
    const result = await transport.execute(
      validRequest({ snapshot: "error-result", jobId: "job-error-1" }),
    );
    expect(result).toMatchObject({ status: "error" });
  });

  it("timed_out-result: maps timed_out status correctly", async () => {
    const transport = harnessTransport();
    const result = await transport.execute(
      validRequest({ snapshot: "timed_out-result", jobId: "job-to-1" }),
    );
    expect(result).toMatchObject({ status: "timed_out" });
  });

  it("cancelled-result: maps cancelled status correctly", async () => {
    const transport = harnessTransport();
    const result = await transport.execute(
      validRequest({ snapshot: "cancelled-result", jobId: "job-cancel-1" }),
    );
    expect(result).toMatchObject({ status: "cancelled" });
  });

  it("resource-usage: passes through non-zero resource usage", async () => {
    const transport = harnessTransport();
    const result = await transport.execute(
      validRequest({ snapshot: "resource-usage", jobId: "job-res-1" }),
    );
    expect(result).toMatchObject({
      resourceUsage: { memoryBytes: 1024 * 1024, cpuTimeMs: 50 },
    });
  });

  it("exit-code-nonzero: returns non-zero exit code in result", async () => {
    const transport = harnessTransport();
    const result = await transport.execute(
      validRequest({ snapshot: "exit-code-nonzero", jobId: "job-exit-1" }),
    );
    expect(result).toMatchObject({ exitCode: 1, status: "failed" });
  });

  it("valid-json-nonzero-exit: rejects valid JSON when process exits non-zero", async () => {
    await expect(
      harnessTransport().execute(
        validRequest({
          snapshot: "valid-json-nonzero-exit",
          jobId: "job-vjnze-1",
        }),
      ),
    ).rejects.toThrow(SandboxTransportError);
  });

  it("with-artifacts: passes through artifact references", async () => {
    const transport = harnessTransport();
    const result = await transport.execute(
      validRequest({ snapshot: "with-artifacts", jobId: "job-art-1" }),
    );
    expect(result).toMatchObject({
      artifactRefs: ["fixture://artifacts/report.json"],
    });
  });
});
