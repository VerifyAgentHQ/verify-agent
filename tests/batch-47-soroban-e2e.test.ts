/**
 * Batch 47 — Real verify-sandbox Soroban E2E verification
 *
 * This test suite proves REAL SANDBOX execution: real Soroban contract tests
 * executed by the external verify-sandbox process inside an isolated Docker
 * container with the Soroban toolchain.
 *
 * Execution path:
 *   truth fixture
 *   → clean snapshot provisioning (test host — allowlist-based)
 *   → source/project detection
 *   → check planning
 *   → real verify-sandbox process (Docker-isolated)
 *   → execution result
 *   → evidence
 *   → policy
 *   → VerificationResult
 *
 * Dependency strategy (Batch 47 — image-provisioned Soroban toolchain):
 *   The sandbox image pre-fetches soroban-sdk@21.0.0 and its transitive
 *   dependencies into the cargo registry. The snapshot includes only the
 *   source files (Cargo.toml, src/lib.rs). Cargo resolves dependencies
 *   from the pre-populated registry using --offline flag.
 *
 *   The sandbox image provisions:
 *   - Rust 1.98.0 with wasm32-unknown-unknown target
 *   - Soroban SDK 21.0.0 (pre-fetched registry)
 *   - cargo test --offline for network-disabled execution
 *
 *   This strategy is:
 *   - Image-provisioned: soroban-sdk installed at Docker build time
 *   - Explicit: allowlist enumerates exactly what the snapshot contains
 *   - Bounded: only source files, no toolchain artifacts
 *   - Offline: no network required at runtime
 *   - No host installation: soroban-sdk comes from the Docker image
 *
 * Gate: VERIFY_SANDBOX_PROCESS, VERIFY_SANDBOX_IDENTITY, and all required
 *       env vars must be set. When unavailable, tests skip explicitly.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
// Snapshot allowlists — deterministic enumeration of approved fixture contents
// ---------------------------------------------------------------------------

const SNAPSHOT_ALLOWLISTS: Record<string, readonly string[]> = {
  "soroban-healthy": ["Cargo.toml", "Cargo.lock", "src/lib.rs"],
  "soroban-failing-test": ["Cargo.toml", "Cargo.lock", "src/lib.rs"],
  "soroban-failing-build": ["Cargo.toml", "Cargo.lock", "src/lib.rs"],
};

// ---------------------------------------------------------------------------
// Directories/files explicitly excluded from snapshots
// ---------------------------------------------------------------------------

const SNAPSHOT_EXCLUSIONS = ["target"];

// ---------------------------------------------------------------------------
// Expected sandbox identity value
// ---------------------------------------------------------------------------

const EXPECTED_SANDBOX_IDENTITY = "verify-sandbox-process-0.1.0";

// ---------------------------------------------------------------------------
// Gating — requires actual external verify-sandbox process + identity
// ---------------------------------------------------------------------------

const requiredEnvVars = [
  "VERIFY_SANDBOX_PROCESS",
  "VERIFY_SANDBOX_SNAPSHOT_ROOT",
  "VERIFY_SANDBOX_DOCKER_EXECUTABLE",
  "VERIFY_SANDBOX_DOCKER_HOST",
  "VERIFY_SANDBOX_SYSTEM_ROOT",
  "VERIFY_SANDBOX_TEMP_ROOT",
  "VERIFY_SANDBOX_IDENTITY",
] as const;

const envVarsPresent =
  process.env.VERIFY_SANDBOX_PROCESS !== undefined &&
  requiredEnvVars.every((name) => Boolean(process.env[name]));

const identityVerified =
  process.env.VERIFY_SANDBOX_IDENTITY === EXPECTED_SANDBOX_IDENTITY;

const sandboxAvailable = envVarsPresent && identityVerified;

const skipReason = !envVarsPresent
  ? "SKIPPED — real verify-sandbox is not configured (requires VERIFY_SANDBOX_PROCESS and all related env vars)"
  : !identityVerified
    ? `SKIPPED — VERIFY_SANDBOX_IDENTITY does not match expected value (expected "${EXPECTED_SANDBOX_IDENTITY}", got "${process.env.VERIFY_SANDBOX_IDENTITY}")`
    : undefined;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TRUTH_ROOT = join("fixtures", "truth-matrix");

// ---------------------------------------------------------------------------
// Soroban fixture definitions
// ---------------------------------------------------------------------------

interface SorobanFixture {
  readonly scenario: string;
  readonly fixturePath: string;
}

const SOROBAN_FIXTURES: readonly SorobanFixture[] = [
  {
    scenario: "soroban-healthy",
    fixturePath: join(TRUTH_ROOT, "soroban", "healthy"),
  },
  {
    scenario: "soroban-failing-test",
    fixturePath: join(TRUTH_ROOT, "soroban", "failing-test"),
  },
  {
    scenario: "soroban-failing-build",
    fixturePath: join(TRUTH_ROOT, "soroban", "failing-build"),
  },
];

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) =>
        import("node:fs/promises").then((fs) =>
          fs.rm(root, { recursive: true, force: true }),
        ),
      ),
  );
});

// ---------------------------------------------------------------------------
// Clean snapshot provisioning — allowlist-based
// ---------------------------------------------------------------------------

async function copyDirectoryRecursive(
  srcDir: string,
  destDir: string,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isFile()) {
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
    } else if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    }
  }
}

async function verifySnapshotCleanliness(
  snapshotDest: string,
  scenario: string,
): Promise<void> {
  const entries = await readdir(snapshotDest, { withFileTypes: true });
  for (const entry of entries) {
    if (SNAPSHOT_EXCLUSIONS.includes(entry.name)) {
      throw new Error(
        `Snapshot for "${scenario}" contains excluded entry: ${entry.name}. ` +
          `This should never happen with allowlist-based provisioning.`,
      );
    }
  }
}

async function provisionCleanSnapshot(
  fixturePath: string,
  scenario: string,
  snapshotRoot: string,
  snapshotId: string,
): Promise<string> {
  const allowlist = SNAPSHOT_ALLOWLISTS[scenario];
  if (!allowlist) {
    throw new Error(
      `No snapshot allowlist defined for scenario "${scenario}". ` +
        `Add it to SNAPSHOT_ALLOWLISTS in the test file.`,
    );
  }

  const snapshotDest = join(snapshotRoot, snapshotId);

  await import("node:fs/promises").then((fs) =>
    fs.rm(snapshotDest, { recursive: true, force: true }).catch(() => {}),
  );
  await mkdir(snapshotDest, { recursive: true });

  const copiedEntries: string[] = [];
  const missingEntries: string[] = [];

  for (const relativePath of allowlist) {
    const srcPath = join(fixturePath, relativePath);
    const destPath = join(snapshotDest, relativePath);

    if (!existsSync(srcPath)) {
      missingEntries.push(relativePath);
      continue;
    }

    const srcStat = await stat(srcPath);
    if (srcStat.isFile()) {
      const destDir = join(destPath, "..");
      await mkdir(destDir, { recursive: true });
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
      copiedEntries.push(relativePath);
    } else if (srcStat.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
      copiedEntries.push(`${relativePath}/`);
    } else {
      missingEntries.push(`${relativePath} (unsupported file type)`);
    }
  }

  if (missingEntries.length > 0) {
    throw new Error(
      `Allowlisted entries missing from fixture "${scenario}": ${missingEntries.join(", ")}. ` +
        `Update SNAPSHOT_ALLOWLISTS if fixture structure changed.`,
    );
  }

  await verifySnapshotCleanliness(snapshotDest, scenario);

  return snapshotDest;
}

// ---------------------------------------------------------------------------
// Transport factory — real verify-sandbox process
// ---------------------------------------------------------------------------

function createRealSandboxTransport(): SubprocessSandboxTransport {
  return new SubprocessSandboxTransport({
    executable: process.env.VERIFY_SANDBOX_PROCESS!,
    environment: {
      VERIFY_SANDBOX_SNAPSHOT_ROOT: process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!,
      VERIFY_SANDBOX_DOCKER_EXECUTABLE:
        process.env.VERIFY_SANDBOX_DOCKER_EXECUTABLE!,
      VERIFY_SANDBOX_DOCKER_HOST: process.env.VERIFY_SANDBOX_DOCKER_HOST!,
      VERIFY_SANDBOX_SYSTEM_ROOT: process.env.VERIFY_SANDBOX_SYSTEM_ROOT!,
      VERIFY_SANDBOX_TEMP_ROOT: process.env.VERIFY_SANDBOX_TEMP_ROOT!,
    },
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 300_000,
    maxMessageBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
    observe: (event) =>
      process.stderr.write(`[SANDBOX] ${JSON.stringify(event)}\n`),
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

async function runRealSandboxPipeline(
  fixturePath: string,
  scenario: string,
  selectedCheckIds: readonly CheckId[],
): Promise<PipelineResult> {
  const snapshotId = brandId<"RepositorySnapshotId">(
    `batch47-soroban-${scenario}-snapshot`,
  );

  const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
  await provisionCleanSnapshot(fixturePath, scenario, snapshotRoot, snapshotId);

  const projectId = brandId<"ProjectId">(`batch47-soroban-${scenario}`);
  const project: Project = {
    id: projectId,
    name: `batch47-soroban-${scenario}`,
    root: ".",
  };

  const snapshot: RepositorySnapshot = {
    id: snapshotId,
    projectId,
    source: {
      provider: "fixture",
      reference: `batch-47-soroban-${scenario}`,
    },
    sourceState: { type: "snapshot", value: snapshotId },
    retrievedAt: new Date().toISOString(),
  };

  const changeSet: ChangeSet = {
    id: brandId<"ChangeSetId">(`batch47-soroban-${scenario}-change`),
    baseSourceState: snapshot.sourceState,
    headSourceState: snapshot.sourceState,
    changedFiles: [],
    additions: 0,
    deletions: 0,
    changeHash: "a".repeat(64),
    issueReferences: [],
  };

  const request: VerificationRequest = {
    id: brandId<"VerificationRequestId">(`batch47-soroban-${scenario}-request`),
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
    id: brandId<"VerificationJobId">(`batch47-soroban-${scenario}-job`),
    requestId: request.id,
    attempt: 1,
    status: "completed",
  };

  const detectionContext = createFileSystemDetectionContext(
    join(snapshotRoot, snapshotId),
  );
  const detectionService = createProjectDetectionService();
  const planner = createCheckPlanner();

  const detected = detectionService.detect(project, snapshot, detectionContext);
  const plan = planner.plan(detected.profile);

  const effectiveCheckIds =
    selectedCheckIds.length > 0
      ? selectedCheckIds
      : plan.items
          .filter((item) => item.applicability === "applicable")
          .map((item) => item.checkId);

  const transport = createRealSandboxTransport();
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
    executionId: `batch47-soroban-${scenario}-execution`,
    resultId: `batch47-soroban-${scenario}-result`,
    createdAt: request.createdAt,
  });

  const aggregationInput = aggregationInputFromPipeline(
    pipelineOutput,
    request,
    job,
    {
      verificationId: `batch47-soroban-${scenario}-verification`,
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
// Tests — real verify-sandbox Soroban E2E
// ---------------------------------------------------------------------------

describe("Batch 47 — Real verify-sandbox Soroban E2E (Docker-isolated)", () => {
  // -----------------------------------------------------------------------
  // 1. Snapshot provisioning creates correct structure
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "snapshot provisioning creates allowlisted structure for all Soroban fixtures"
      : skipReason,
    async () => {
      const snapshotRoot = join(
        process.env.TEMP ?? "/tmp",
        "batch47-snapshot-provision-test",
      );
      await import("node:fs/promises").then((fs) =>
        fs.mkdir(snapshotRoot, { recursive: true }),
      );
      tempRoots.push(snapshotRoot);

      try {
        for (const fixture of SOROBAN_FIXTURES) {
          const snapshotId = brandId<"RepositorySnapshotId">(
            `batch47-provision-${fixture.scenario}`,
          );

          const snapshotPath = await provisionCleanSnapshot(
            fixture.fixturePath,
            fixture.scenario,
            snapshotRoot,
            snapshotId,
          );

          expect(existsSync(join(snapshotPath, "Cargo.toml"))).toBe(true);
          expect(existsSync(join(snapshotPath, "Cargo.lock"))).toBe(true);
          expect(existsSync(join(snapshotPath, "src", "lib.rs"))).toBe(true);

          expect(
            existsSync(join(snapshotPath, "target")),
            `Snapshot for ${fixture.scenario} should not contain target/`,
          ).toBe(false);

          const topEntries = await readdir(snapshotPath, {
            withFileTypes: true,
          });
          const topLevelNames = topEntries.map((e) => e.name).sort();
          expect(topLevelNames).toEqual(["Cargo.lock", "Cargo.toml", "src"]);
        }
      } finally {
        await import("node:fs/promises").then((fs) =>
          fs.rm(snapshotRoot, { recursive: true, force: true }),
        );
      }
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 2. Snapshot excludes target and generated files
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "snapshot excludes target and generated files for all Soroban fixtures"
      : skipReason,
    async () => {
      const snapshotRoot = join(
        process.env.TEMP ?? "/tmp",
        "batch47-snapshot-exclusion-test",
      );
      await import("node:fs/promises").then((fs) =>
        fs.mkdir(snapshotRoot, { recursive: true }),
      );
      tempRoots.push(snapshotRoot);

      try {
        for (const fixture of SOROBAN_FIXTURES) {
          const snapshotId = brandId<"RepositorySnapshotId">(
            `batch47-exclusion-${fixture.scenario}`,
          );

          const snapshotPath = await provisionCleanSnapshot(
            fixture.fixturePath,
            fixture.scenario,
            snapshotRoot,
            snapshotId,
          );

          for (const excluded of SNAPSHOT_EXCLUSIONS) {
            expect(
              existsSync(join(snapshotPath, excluded)),
              `Snapshot for ${fixture.scenario} should not contain ${excluded}`,
            ).toBe(false);
          }
        }
      } finally {
        await import("node:fs/promises").then((fs) =>
          fs.rm(snapshotRoot, { recursive: true, force: true }),
        );
      }
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 3. Healthy Soroban fixture through real sandbox
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "healthy: real sandbox soroban.contract-test executes successfully"
      : skipReason,
    async () => {
      const fixture = SOROBAN_FIXTURES.find(
        (f) => f.scenario === "soroban-healthy",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("soroban.contract-test")],
      );

      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      expect(result.pipelineOutput.checkResults.length).toBeGreaterThanOrEqual(
        1,
      );

      const contractTestResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "soroban.contract-test",
      );
      expect(contractTestResult?.status).toBe("passed");
      expect(contractTestResult?.executionSource).toBe("real");

      expect(result.findings).toEqual([]);

      expect(result.policyDecision.outcome).toBe("allow");
      expect(result.policyDecision.triggeredRuleIds).toEqual([]);
      expect(result.verificationResult.status).toBe("partial");
      expect(result.verificationResult.coverage.verified).toContain(
        "soroban.contract-test",
      );
    },
    600_000,
  );

  // -----------------------------------------------------------------------
  // 4. Failing-test Soroban fixture through real sandbox
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "failing-test: real sandbox soroban.contract-test fails and blocks verification"
      : skipReason,
    async () => {
      const fixture = SOROBAN_FIXTURES.find(
        (f) => f.scenario === "soroban-failing-test",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("soroban.contract-test")],
      );

      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      const contractTestResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "soroban.contract-test",
      );
      expect(contractTestResult?.status).toBe("failed");
      expect(contractTestResult?.executionSource).toBe("real");

      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      expect(result.findings.some((f) => f.severity === "high")).toBe(true);

      expect(result.policyDecision.outcome).toBe("block");
      expect(result.policyDecision.triggeredRuleIds).toContain(
        "required-check-failure",
      );
      expect(result.verificationResult.status).toBe("blocked");
    },
    300_000,
  );

  // -----------------------------------------------------------------------
  // 5. Failing-build Soroban fixture through real sandbox
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "failing-build: real sandbox soroban.contract-test compilation error"
      : skipReason,
    async () => {
      const fixture = SOROBAN_FIXTURES.find(
        (f) => f.scenario === "soroban-failing-build",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("soroban.contract-test")],
      );

      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      const contractTestResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "soroban.contract-test",
      );
      expect(contractTestResult?.status).toBe("failed");
      expect(contractTestResult?.executionSource).toBe("real");

      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      expect(result.findings.some((f) => f.severity === "high")).toBe(true);

      expect(result.policyDecision.outcome).toBe("block");
      expect(result.verificationResult.status).toBe("blocked");
    },
    300_000,
  );

  // -----------------------------------------------------------------------
  // 6. Soroban detection produces correct profile
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "detection identifies soroban project and plans soroban.contract-test"
      : skipReason,
    async () => {
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const fixture = SOROBAN_FIXTURES.find(
        (f) => f.scenario === "soroban-healthy",
      )!;

      const snapshotId = brandId<"RepositorySnapshotId">(
        `batch47-detection-soroban-healthy-snapshot`,
      );
      await provisionCleanSnapshot(
        fixture.fixturePath,
        fixture.scenario,
        snapshotRoot,
        snapshotId,
      );

      const projectId = brandId<"ProjectId">("batch47-detection-soroban");
      const project: Project = {
        id: projectId,
        name: "batch47-detection-soroban",
        root: ".",
      };

      const snapshot: RepositorySnapshot = {
        id: snapshotId,
        projectId,
        source: { provider: "fixture", reference: "batch-47-detection" },
        sourceState: { type: "snapshot", value: snapshotId },
        retrievedAt: new Date().toISOString(),
      };

      const detectionContext = createFileSystemDetectionContext(
        join(snapshotRoot, snapshotId),
      );
      const detectionService = createProjectDetectionService();
      const planner = createCheckPlanner();

      const detected = detectionService.detect(
        project,
        snapshot,
        detectionContext,
      );

      expect(detected.profile.languages).toEqual(
        expect.arrayContaining(["rust"]),
      );

      if (detected.profile.extensions) {
        const hasSoroban = detected.profile.extensions.some(
          (ext) =>
            String(ext).includes("soroban") || String(ext).includes("stellar"),
        );
        expect(hasSoroban).toBe(true);
      }

      const plan = planner.plan(detected.profile);
      const applicableCheckIds = plan.items
        .filter((item) => item.applicability === "applicable")
        .map((item) => String(item.checkId));

      expect(applicableCheckIds).toContain("soroban.contract-test");
    },
    60_000,
  );
});
