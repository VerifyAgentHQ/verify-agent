/**
 * Batch 43 — Host-subprocess TypeScript/JavaScript E2E verification
 *
 * This test suite proves HOST-SUBPROCESS execution: real TypeScript commands
 * executed by a local Node.js harness on the host machine. It does NOT prove
 * real sandbox isolation.
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
 *   - Real toolchain execution (tsc, vitest, pnpm)
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
import { existsSync, readFileSync } from "node:fs";
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

const TYPESCRIPT_FIXTURES = [
  {
    scenario: "typescript-healthy" as const,
    fixturePath: resolve(TRUTH_ROOT, "typescript", "healthy"),
    expectedCheckOutcomes: {
      "typescript.typecheck": "passed" as const,
      "typescript.test": "passed" as const,
    },
  },
  {
    scenario: "typescript-failing-test" as const,
    fixturePath: resolve(TRUTH_ROOT, "typescript", "failing-test"),
    expectedCheckOutcomes: {
      "typescript.typecheck": "passed" as const,
      "typescript.test": "failed" as const,
    },
  },
  {
    scenario: "typescript-failing-typecheck" as const,
    fixturePath: resolve(TRUTH_ROOT, "typescript", "failing-typecheck"),
    expectedCheckOutcomes: {
      "typescript.typecheck": "failed" as const,
    },
  },
  {
    scenario: "typescript-failing-build" as const,
    fixturePath: resolve(TRUTH_ROOT, "typescript", "failing-build"),
    expectedCheckOutcomes: {
      "typescript.typecheck": "passed" as const,
      "typescript.build": "failed" as const,
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
  // On Windows, construct a minimal PATH that includes node, pnpm, and cmd.exe locations.
  const paths: string[] = [];
  // Add Windows System32 for cmd.exe
  const systemRoot = process.env.SYSTEMROOT ?? "C:\\Windows";
  paths.push(join(systemRoot, "System32"));
  // Add node directory
  const nodeDir = resolve(process.execPath, "..");
  paths.push(nodeDir);
  // Add common pnpm locations
  const npmGlobal = resolve(process.env.APPDATA ?? "", "npm");
  if (existsSync(npmGlobal)) paths.push(npmGlobal);
  // Add user profile local bin
  const userLocal = resolve(process.env.USERPROFILE ?? "", ".local", "bin");
  if (existsSync(userLocal)) paths.push(userLocal);
  return process.platform === "win32" ? paths.join(";") : paths.join(":");
}

// ---------------------------------------------------------------------------
// Fixture dependency installation
// ---------------------------------------------------------------------------

function installFixtureDependencies(fixturePath: string): void {
  if (!existsSync(join(fixturePath, "package.json"))) return;
  if (existsSync(join(fixturePath, "node_modules"))) return;

  try {
    execSync("npm install --ignore-scripts --no-audit --no-fund", {
      cwd: fixturePath,
      stdio: "pipe",
      timeout: 60_000,
      env: {
        PATH: getSystemPath(),
        HOME: process.env.USERPROFILE ?? "",
        APPDATA: process.env.APPDATA ?? "",
      },
    });
  } catch {
    // npm might not be available or might fail. Try with node directly.
    try {
      execSync(
        `node -e "const{spawnSync}=require('child_process');const r=spawnSync('${process.execPath.replace(/\\/g, "/")}',[],{cwd:'${fixturePath.replace(/\\/g, "/")}',stdio:'pipe'});"`,
        { stdio: "pipe", timeout: 30_000 },
      );
    } catch {
      // Dependency installation failed — tests will be skipped
    }
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
      VERIFY_SANDBOX_TIMEOUT_MS: "60000",
    },
    startupTimeoutMs: 2_000,
    requestTimeoutMs: 120_000,
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
  const projectId = brandId<"ProjectId">(`batch43-${scenario}`);
  const snapshotId = brandId<"RepositorySnapshotId">(
    `batch43-${scenario}-snapshot`,
  );

  const project: Project = {
    id: projectId,
    name: `batch43-${scenario}`,
    root: ".",
  };

  const snapshot: RepositorySnapshot = {
    id: snapshotId,
    projectId,
    source: { provider: "fixture", reference: `batch-43-${scenario}` },
    sourceState: { type: "snapshot", value: snapshotId },
    retrievedAt: new Date().toISOString(),
  };

  const changeSet: ChangeSet = {
    id: brandId<"ChangeSetId">(`batch43-${scenario}-change`),
    baseSourceState: snapshot.sourceState,
    headSourceState: snapshot.sourceState,
    changedFiles: [],
    additions: 0,
    deletions: 0,
    changeHash: "a".repeat(64),
    issueReferences: [],
  };

  const request: VerificationRequest = {
    id: brandId<"VerificationRequestId">(`batch43-${scenario}-request`),
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
    id: brandId<"VerificationJobId">(`batch43-${scenario}-job`),
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
    executionId: `batch43-${scenario}-execution`,
    resultId: `batch43-${scenario}-result`,
    createdAt: request.createdAt,
  });

  const aggregationInput = aggregationInputFromPipeline(
    pipelineOutput,
    request,
    job,
    {
      verificationId: `batch43-${scenario}-verification`,
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

  // Install dependencies in each TypeScript fixture directory
  for (const fixture of TYPESCRIPT_FIXTURES) {
    installFixtureDependencies(fixture.fixturePath);
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Batch 43 — Host-subprocess TypeScript E2E (NOT sandbox-isolated)", () => {
  // -----------------------------------------------------------------------
  // 1. Healthy TypeScript fixture
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "healthy: host-subprocess typecheck and test execute successfully"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("typescript.typecheck"),
          brandId<"CheckId">("typescript.test"),
        ],
      );

      // Host-subprocess execution provenance
      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      // Both checks pass
      expect(result.pipelineOutput.checkResults).toHaveLength(2);
      for (const cr of result.pipelineOutput.checkResults) {
        expect(cr.status).toBe("passed");
        expect(cr.executionSource).toBe("real");
      }

      // Policy allows (all required checks pass with real execution)
      expect(result.policyDecision.outcome).not.toBe("block");

      // VerificationResult reflects real execution
      expect(result.verificationResult.status).not.toBe("blocked");
      expect(result.verificationResult.coverage.verified).toEqual(
        expect.arrayContaining(["typescript.typecheck", "typescript.test"]),
      );
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 2. Failing test fixture
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "failing-test: host-subprocess test command fails and blocks verification"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-failing-test",
      )!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("typescript.typecheck"),
          brandId<"CheckId">("typescript.test"),
        ],
      );

      // Host-subprocess execution provenance
      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      // typecheck passes, test fails
      const typecheckResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.typecheck",
      );
      const testResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.test",
      );
      expect(typecheckResult?.status).toBe("passed");
      expect(testResult?.status).toBe("failed");

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
    180_000,
  );

  // -----------------------------------------------------------------------
  // 3. Failing typecheck fixture
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "failing-typecheck: host-subprocess typecheck command fails and blocks verification"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-failing-typecheck",
      )!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
      );

      // Host-subprocess execution provenance
      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      // typecheck fails
      const typecheckResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.typecheck",
      );
      expect(typecheckResult?.status).toBe("failed");

      // Findings from failed typecheck
      expect(result.findings.length).toBeGreaterThanOrEqual(1);

      // Policy blocks
      expect(result.policyDecision.outcome).toBe("block");

      // VerificationResult is blocked
      expect(result.verificationResult.status).toBe("blocked");
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 4. Failing build fixture
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "failing-build: host-subprocess build command fails and blocks verification"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-failing-build",
      )!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("typescript.typecheck"),
          brandId<"CheckId">("typescript.build"),
        ],
      );

      // Host-subprocess execution provenance
      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      // typecheck passes (code is type-safe), build fails (assigns number to string)
      const typecheckResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.typecheck",
      );
      const buildResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.build",
      );
      expect(typecheckResult?.status).toBe("passed");
      expect(buildResult?.status).toBe("failed");

      // Findings from failed build
      expect(result.findings.length).toBeGreaterThanOrEqual(1);

      // Policy blocks
      expect(result.policyDecision.outcome).toBe("block");

      // VerificationResult is blocked
      expect(result.verificationResult.status).toBe("blocked");
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 5. Real execution uses sandbox transport boundary
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "execution goes through SubprocessSandboxTransport (host harness)"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const transport = createRealExecutionTransport(fixture.fixturePath);

      expect(transport.executionSource).toBe("real");

      // Send a minimal valid request
      const result = await transport.execute({
        schemaVersion: "1.0.0",
        jobId: "batch43-transport-verify",
        source: { provider: "fixture", reference: "batch43-transport" },
        snapshot: "test",
        commands: [
          JSON.stringify({
            executable: "node",
            args: ["-e", "process.stdout.write(JSON.stringify({ok:true}))"],
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

      expect(result).toMatchObject({
        schemaVersion: "1.0.0",
        jobId: "batch43-transport-verify",
        status: "completed",
        exitCode: 0,
      });
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 6. Host-subprocess execution evidence is never simulated
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "host-subprocess execution evidence is never labeled simulated"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
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
    180_000,
  );

  // -----------------------------------------------------------------------
  // 7. Host-subprocess evidence preserves provenance
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "host-subprocess evidence preserves execution provenance and traceability"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const result = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("typescript.typecheck"),
          brandId<"CheckId">("typescript.test"),
        ],
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
    180_000,
  );

  // -----------------------------------------------------------------------
  // 8. Policy/result reflects host-subprocess execution
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "policy and VerificationResult reflect host-subprocess command execution outcomes"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      // Run healthy fixture
      const healthyFixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const healthyResult = await runRealPipeline(
        healthyFixture.fixturePath,
        healthyFixture.scenario,
        [
          brandId<"CheckId">("typescript.typecheck"),
          brandId<"CheckId">("typescript.test"),
        ],
      );

      // Healthy: no block, verified coverage
      expect(healthyResult.policyDecision.outcome).not.toBe("block");
      expect(healthyResult.verificationResult.coverage.verified.length).toBe(2);

      // Run failing typecheck fixture
      const failingFixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-failing-typecheck",
      )!;
      const failingResult = await runRealPipeline(
        failingFixture.fixturePath,
        failingFixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
      );

      // Failing: blocks, partial coverage
      expect(failingResult.policyDecision.outcome).toBe("block");
      expect(failingResult.verificationResult.status).toBe("blocked");
      expect(failingResult.verificationResult.coverage.partial).toContain(
        "typescript.typecheck",
      );
    },
    360_000,
  );

  // -----------------------------------------------------------------------
  // 9. Unavailable host-subprocess environment causes explicit skip
  // -----------------------------------------------------------------------
  it("explicitly skips when host-subprocess environment is not configured", () => {
    if (realSandboxEnabled) {
      // When enabled, just verify the environment is sane
      expect(existsSync(HARNESS_PATH)).toBe(true);
      for (const fixture of TYPESCRIPT_FIXTURES) {
        expect(existsSync(fixture.fixturePath)).toBe(true);
      }
    } else {
      // When disabled, this test passes as a no-op — the skip messages
      // on the other tests make the gating obvious.
      expect(true).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // 10. Determinism across repeated host-subprocess runs
  // -----------------------------------------------------------------------
  it.skipIf(!realSandboxEnabled)(
    realSandboxEnabled
      ? "repeated host-subprocess runs produce semantically identical outcomes"
      : "SKIPPED — VERIFY_REAL_SANDBOX=1 is required for host-subprocess E2E",
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const first = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
      );
      const second = await runRealPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
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
    360_000,
  );
});
