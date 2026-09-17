/**
 * Batch 44 — Host-subprocess Rust/Soroban E2E verification
 *
 * This test suite proves HOST-SUBPROCESS execution: real Rust/Cargo commands
 * executed by a local harness on the host machine. It does NOT prove sandbox
 * isolation.
 *
 * Execution path:
 *   truth fixture
 *   → source/project detection
 *   → check planning
 *   → host-subprocess execution (sandbox-real-execution-harness.mjs)
 *   → execution result
 *   → evidence
 *   → policy
 *   → VerificationResult
 *
 * The harness (sandbox-real-execution-harness.mjs) runs directly on the host,
 * NOT inside a Docker container or any isolated sandbox. This proves:
 *   - Real Rust toolchain execution (cargo check, cargo test, cargo clippy)
 *   - Correct status mapping and exit code propagation
 *   - Evidence and policy integration with real execution
 *
 * This does NOT prove:
 *   - Sandbox isolation (no Docker, no network restriction)
 *   - Snapshot materialization by the sandbox
 *   - Source identity preservation through the sandbox boundary
 *
 * For real verify-sandbox E2E tests, see batch-43-real-sandbox.test.ts.
 *
 * Gate: VERIFY_REAL_SANDBOX=1 (required for host-subprocess tests)
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  brandId,
  type CheckId,
  type RepositorySnapshot,
} from "../packages/domain/src/index.js";
import {
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
  aggregateVerification,
  aggregationInputFromPipeline,
  SubprocessSandboxTransport,
  type VerificationPipelineOutput,
} from "../packages/engine/src/index.js";
import {
  createFileSystemDetectionContext,
  createProjectDetectionService,
} from "../packages/adapters-lang/src/index.js";
import { createCheckPlanner } from "../packages/checks/src/index.js";
import {
  type VerificationRequest,
  type VerificationJob,
  type ChangeSet,
  type Project,
} from "../packages/domain/src/index.js";

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

const realSandboxEnabled = process.env.VERIFY_REAL_SANDBOX === "1";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRUTH_ROOT = resolve("fixtures", "truth-matrix");
const HARNESS_PATH = resolve(
  import.meta.dirname,
  "fixtures/sandbox-real-execution-harness.mjs",
);

const RUST_FIXTURES = [
  {
    scenario: "rust-healthy" as const,
    fixturePath: resolve(TRUTH_ROOT, "rust", "healthy"),
    expectedCheckOutcomes: {
      "rust.check": "passed" as const,
      "rust.test": "passed" as const,
      "rust.clippy": "passed" as const,
    },
  },
  {
    scenario: "rust-failing-test" as const,
    fixturePath: resolve(TRUTH_ROOT, "rust", "failing-test"),
    expectedCheckOutcomes: {
      "rust.check": "passed" as const,
      "rust.test": "failed" as const,
      "rust.clippy": "passed" as const,
    },
  },
  {
    scenario: "rust-failing-build" as const,
    fixturePath: resolve(TRUTH_ROOT, "rust", "failing-build"),
    expectedCheckOutcomes: {
      "rust.check": "failed" as const,
      "rust.test": "failed" as const,
      "rust.clippy": "failed" as const,
    },
  },
] as const;

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

function getNodeExecutable(): string {
  return process.execPath;
}

function getSystemPath(): string {
  if (process.platform === "win32") {
    const paths: string[] = [];
    const systemRoot = process.env.SYSTEMROOT ?? "C:\\Windows";
    paths.push(join(systemRoot, "System32"));
    const nodeDir = resolve(process.execPath, "..");
    paths.push(nodeDir);
    const npmGlobal = resolve(process.env.APPDATA ?? "", "npm");
    if (existsSync(npmGlobal)) paths.push(npmGlobal);
    const userLocal = resolve(process.env.USERPROFILE ?? "", ".local", "bin");
    if (existsSync(userLocal)) paths.push(userLocal);
    // Add Rust/Cargo bin directory
    const cargoHome =
      process.env.CARGO_HOME ?? join(process.env.USERPROFILE ?? "", ".cargo");
    const cargoBin = join(cargoHome, "bin");
    if (existsSync(cargoBin)) paths.push(cargoBin);
    return paths.join(";");
  }
  // On Unix (Linux, macOS), preserve the runner's normal PATH so child
  // processes can find standard system utilities (node, cargo, tsc, etc.).
  return process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
}

function cargoIsAvailable(): boolean {
  try {
    execSync("cargo --version", {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
      env: { PATH: getSystemPath() },
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Transport factory
// ---------------------------------------------------------------------------

function createRealExecutionTransport(fixturePath: string) {
  return new SubprocessSandboxTransport({
    executable: getNodeExecutable(),
    args: [HARNESS_PATH],
    workingDirectory: fixturePath,
    environment: {
      PATH: getSystemPath(),
      VERIFY_SANDBOX_WORKING_DIRECTORY: fixturePath,
      VERIFY_SANDBOX_TIMEOUT_MS: "120000",
    },
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 180_000,
    maxMessageBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
}

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

interface PipelineResult {
  readonly pipelineOutput: VerificationPipelineOutput;
  readonly verificationResult: import("../packages/domain/src/index.js").VerificationResult;
  readonly evidence: readonly import("../packages/domain/src/index.js").Evidence[];
  readonly findings: readonly import("../packages/domain/src/index.js").Finding[];
  readonly policyDecision: import("../packages/domain/src/index.js").PolicyDecision;
}

async function runRealPipeline(
  fixturePath: string,
  scenario: string,
  selectedCheckIds: readonly CheckId[],
): Promise<PipelineResult> {
  const projectId = brandId<"ProjectId">(`batch44-${scenario}`);
  const snapshotId = brandId<"RepositorySnapshotId">(
    `batch44-${scenario}-snapshot`,
  );

  const project: Project = {
    id: projectId,
    name: `batch44-${scenario}`,
    root: ".",
  };

  const snapshot: RepositorySnapshot = {
    id: snapshotId,
    projectId,
    source: { provider: "fixture", reference: `batch-44-${scenario}` },
    sourceState: { type: "snapshot", value: snapshotId },
    retrievedAt: new Date().toISOString(),
  };

  const changeSet: ChangeSet = {
    id: brandId<"ChangeSetId">(`batch44-${scenario}-change`),
    baseSourceState: snapshot.sourceState,
    headSourceState: snapshot.sourceState,
    changedFiles: [],
    additions: 0,
    deletions: 0,
    changeHash: "a".repeat(64),
    issueReferences: [],
  };

  const request: VerificationRequest = {
    id: brandId<"VerificationRequestId">(`batch44-${scenario}-request`),
    projectId,
    snapshotId,
    changeSetId: changeSet.id,
    requestedBy: { type: "system" },
    mode: "manual",
    requestedChecks: [],
    policyId: brandId<"PolicyId">("policy.default"),
    priority: 0,
    createdAt: new Date().toISOString(),
  };

  const job: VerificationJob = {
    id: brandId<"VerificationJobId">(`batch44-${scenario}-job`),
    requestId: request.id,
    attempt: 1,
    status: "completed",
  };

  const detectionContext = createFileSystemDetectionContext(fixturePath);
  const detectionService = createProjectDetectionService();
  const planner = createCheckPlanner();

  // Detect and plan
  const detected = detectionService.detect(project, snapshot, detectionContext);
  const plan = planner.plan(detected.profile);

  // If no specific check IDs provided, use all applicable
  const effectiveCheckIds =
    selectedCheckIds.length > 0
      ? selectedCheckIds
      : plan.items
          .filter((item) => item.applicability === "applicable")
          .map((item) => item.checkId);

  // Create real execution transport
  const transport = createRealExecutionTransport(fixturePath);
  const executor = createCheckExecutor(
    createSandboxExecutorFromTransport(transport),
  );

  const pipeline = createVerificationPipeline({
    detector: {
      detect() {
        return detected;
      },
    },
    planner,
    executor,
  });

  const pipelineOutput = await pipeline.verify({
    project,
    snapshot,
    changeSet,
    detectionContext,
    selectedCheckIds: effectiveCheckIds,
    jobId: String(job.id),
    executionId: `batch44-${scenario}-execution`,
    resultId: `batch44-${scenario}-result`,
    createdAt: request.createdAt,
  });

  const aggregationInput = aggregationInputFromPipeline(
    pipelineOutput,
    request,
    job,
    {
      verificationId: `batch44-${scenario}-verification`,
      createdAt: request.createdAt,
    },
  );

  const aggregationOutput = aggregateVerification(aggregationInput);

  return {
    pipelineOutput,
    verificationResult: aggregationOutput.result,
    evidence: aggregationOutput.evidence,
    findings: aggregationOutput.findings,
    policyDecision: aggregationOutput.policyDecision,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  if (!realSandboxEnabled) return;

  // Verify cargo is available
  if (!cargoIsAvailable()) {
    console.warn(
      "WARNING: cargo is not available on PATH. Rust E2E tests will fail.",
    );
  }

  // Verify fixtures exist
  for (const fixture of RUST_FIXTURES) {
    if (!existsSync(fixture.fixturePath)) {
      console.warn(`WARNING: Rust fixture not found: ${fixture.fixturePath}`);
    }
  }
}, 30_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Batch 44 — Host-subprocess Rust E2E (NOT sandbox-isolated)", () => {
  // -----------------------------------------------------------------------
  // 1. Healthy Rust fixture
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "healthy: host-subprocess cargo check, test, and clippy execute successfully"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = RUST_FIXTURES.find((f) => f.scenario === "rust-healthy")!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("rust.check"),
          brandId<"CheckId">("rust.test"),
          brandId<"CheckId">("rust.clippy"),
        ],
      );

      // Host-subprocess execution provenance
      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      // All checks pass
      expect(result.pipelineOutput.checkResults).toHaveLength(3);
      for (const cr of result.pipelineOutput.checkResults) {
        expect(cr.status).toBe("passed");
        expect(cr.executionSource).toBe("real");
      }

      // Policy allows (all required checks pass with real execution)
      expect(result.policyDecision.outcome).not.toBe("block");

      // VerificationResult reflects real execution
      expect(result.verificationResult.status).not.toBe("blocked");
      expect(result.verificationResult.coverage.verified).toEqual(
        expect.arrayContaining(["rust.check", "rust.test", "rust.clippy"]),
      );
    },
    300_000,
  );

  // -----------------------------------------------------------------------
  // 2. Failing test fixture
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "failing-test: host-subprocess cargo test fails and blocks verification"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = RUST_FIXTURES.find(
        (f) => f.scenario === "rust-failing-test",
      )!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("rust.check"),
          brandId<"CheckId">("rust.test"),
          brandId<"CheckId">("rust.clippy"),
        ],
      );

      // Host-subprocess execution provenance
      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      // check passes, test fails, clippy passes
      const checkResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "rust.check",
      );
      const testResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "rust.test",
      );
      const clippyResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "rust.clippy",
      );
      expect(checkResult?.status).toBe("passed");
      expect(testResult?.status).toBe("failed");
      expect(clippyResult?.status).toBe("passed");

      // Findings from failed test
      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      expect(result.findings.some((f) => f.severity === "high")).toBe(true);

      // Policy blocks
      expect(result.policyDecision.outcome).toBe("block");
      expect(result.policyDecision.triggeredRuleIds).toContain(
        "required-check-failure",
      );

      // VerificationResult is blocked
      expect(result.verificationResult.status).toBe("blocked");
    },
    300_000,
  );

  // -----------------------------------------------------------------------
  // 3. Failing build fixture
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "failing-build: host-subprocess cargo check/build fails and blocks verification"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = RUST_FIXTURES.find(
        (f) => f.scenario === "rust-failing-build",
      )!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("rust.check"),
          brandId<"CheckId">("rust.test"),
          brandId<"CheckId">("rust.clippy"),
        ],
      );

      // Host-subprocess execution provenance
      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      // All checks fail (type error in source code)
      for (const cr of result.pipelineOutput.checkResults) {
        expect(cr.status).toBe("failed");
      }

      // Findings from failed build
      expect(result.findings.length).toBeGreaterThanOrEqual(1);

      // Policy blocks
      expect(result.policyDecision.outcome).toBe("block");

      // VerificationResult is blocked
      expect(result.verificationResult.status).toBe("blocked");
    },
    300_000,
  );

  // -----------------------------------------------------------------------
  // 4. Real execution uses sandbox transport boundary
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "execution goes through SubprocessSandboxTransport (host harness)"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = RUST_FIXTURES.find((f) => f.scenario === "rust-healthy")!;
      const transport = createRealExecutionTransport(fixture.fixturePath);

      expect(transport.executionSource).toBe("real");

      // Send a minimal valid request
      const result = await transport.execute({
        schemaVersion: "1.0.0",
        jobId: "batch44-transport-verify",
        source: { provider: "fixture", reference: "batch44-transport" },
        snapshot: "test",
        commands: [
          JSON.stringify({
            executable: "cargo",
            args: ["check"],
            workingDirectory: ".",
            environment: {},
          }),
        ],
        resourceLimits: {
          timeoutMs: 60_000,
          memoryLimitBytes: 256 * 1024 * 1024,
        },
        networkPolicy: "none",
        artifactPolicy: "none",
      });

      expect(result).toMatchObject({
        schemaVersion: "1.0.0",
        jobId: "batch44-transport-verify",
        status: "completed",
        exitCode: 0,
      });
    },
    120_000,
  );

  // -----------------------------------------------------------------------
  // 5. Host-subprocess execution evidence is never simulated
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "host-subprocess execution evidence is never labeled simulated"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = RUST_FIXTURES.find((f) => f.scenario === "rust-healthy")!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("rust.check")],
      );

      // All evidence must be real, never simulated
      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
        expect(e.executionSource).not.toBe("simulated");
        expect(e.executionSource).not.toBe("fixture");
      }

      // All check results must be real
      for (const cr of result.pipelineOutput.checkResults) {
        expect(cr.executionSource).toBe("real");
      }
    },
    300_000,
  );

  // -----------------------------------------------------------------------
  // 6. Host-subprocess evidence preserves provenance
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "host-subprocess evidence preserves execution provenance and traceability"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = RUST_FIXTURES.find((f) => f.scenario === "rust-healthy")!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("rust.check"), brandId<"CheckId">("rust.test")],
      );

      // Evidence has correct type and traceability
      for (const e of result.evidence) {
        expect(e.type).toBe("check.result");
        expect(e.sourceReferences.length).toBeGreaterThan(0);
        expect(e.contentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(e.executionSource).toBe("real");
      }

      // Findings reference evidence
      for (const f of result.findings) {
        expect(f.evidenceReferences.length).toBeGreaterThan(0);
      }

      // VerificationResult links to evidence and findings
      expect(result.verificationResult.evidenceReferences.length).toBe(
        result.evidence.length,
      );
      expect(result.verificationResult.findingReferences.length).toBe(
        result.findings.length,
      );

      // Policy decision links to evidence and findings
      expect(result.policyDecision.evidenceReferences.length).toBe(
        result.evidence.length,
      );
    },
    300_000,
  );

  // -----------------------------------------------------------------------
  // 7. Policy/result reflects host-subprocess execution
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "policy and VerificationResult reflect host-subprocess Rust command execution outcomes"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      // Run healthy fixture
      const healthyFixture = RUST_FIXTURES.find(
        (f) => f.scenario === "rust-healthy",
      )!;
      const healthyResult = await runRealPipeline(
        healthyFixture.fixturePath,
        healthyFixture.scenario,
        [brandId<"CheckId">("rust.check"), brandId<"CheckId">("rust.test")],
      );

      // Healthy: no block, verified coverage
      expect(healthyResult.policyDecision.outcome).not.toBe("block");
      expect(healthyResult.verificationResult.coverage.verified.length).toBe(2);

      // Run failing test fixture
      const failingFixture = RUST_FIXTURES.find(
        (f) => f.scenario === "rust-failing-test",
      )!;
      const failingResult = await runRealPipeline(
        failingFixture.fixturePath,
        failingFixture.scenario,
        [brandId<"CheckId">("rust.test")],
      );

      // Failing: blocks, partial coverage
      expect(failingResult.policyDecision.outcome).toBe("block");
      expect(failingResult.verificationResult.status).toBe("blocked");
      expect(failingResult.verificationResult.coverage.partial).toContain(
        "rust.test",
      );
    },
    600_000,
  );

  // -----------------------------------------------------------------------
  // 8. Unavailable host-subprocess environment causes explicit skip
  // -----------------------------------------------------------------------
  it("explicitly skips when host-subprocess environment is not configured", () => {
    if (realSandboxEnabled) {
      // When enabled, just verify the environment is sane
      expect(existsSync(HARNESS_PATH)).toBe(true);
      for (const fixture of RUST_FIXTURES) {
        expect(existsSync(fixture.fixturePath)).toBe(true);
      }
    } else {
      // When disabled, this test passes as a no-op — the skip messages
      // on the other tests make the gating obvious.
      expect(true).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // 9. Determinism across repeated host-subprocess runs
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "repeated host-subprocess runs produce semantically identical outcomes"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = RUST_FIXTURES.find((f) => f.scenario === "rust-healthy")!;
      const first = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("rust.check")],
      );
      const second = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("rust.check")],
      );

      // Semantically identical outcomes
      expect(first.verificationResult.status).toBe(
        second.verificationResult.status,
      );
      expect(first.policyDecision.outcome).toBe(second.policyDecision.outcome);
      expect(first.evidence.length).toBe(second.evidence.length);
      expect(first.findings.length).toBe(second.findings.length);

      // Real execution timing (durationMs) is non-deterministic, so content
      // hashes will differ between runs. Semantic equivalence is captured by
      // the status, outcome, and structural assertions above.
    },
    600_000,
  );

  // -----------------------------------------------------------------------
  // 10. Detection proves Rust project recognized
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "Rust project detection identifies cargo manifests and Rust capabilities"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = RUST_FIXTURES.find((f) => f.scenario === "rust-healthy")!;

      const projectId = brandId<"ProjectId">("batch44-detection");
      const snapshotId = brandId<"RepositorySnapshotId">(
        "batch44-detection-snapshot",
      );
      const project: Project = {
        id: projectId,
        name: "batch44-detection",
        root: ".",
      };
      const snapshot: RepositorySnapshot = {
        id: snapshotId,
        projectId,
        source: { provider: "fixture", reference: "batch44-detection" },
        sourceState: { type: "snapshot", value: snapshotId },
        retrievedAt: new Date().toISOString(),
      };

      const detectionContext = createFileSystemDetectionContext(
        fixture.fixturePath,
      );
      const detectionService = createProjectDetectionService();
      const detected = detectionService.detect(
        project,
        snapshot,
        detectionContext,
      );

      // Rust is detected
      expect(detected.profile.languages).toContain("rust");

      // Rust capabilities are present
      expect(detected.profile.supportedCapabilities).toEqual(
        expect.arrayContaining(["rust.check", "rust.test", "rust.clippy"]),
      );

      // Cargo is detected as package manager
      expect(detected.profile.packageManagers).toContain("cargo");

      // Cargo is detected as build system
      expect(detected.profile.buildSystems).toContain("cargo");

      // Observations include cargo manifest
      expect(
        detected.observations.some(
          (o) => o.signal === "cargo-manifest-present",
        ),
      ).toBe(true);
    },
    30_000,
  );
});
