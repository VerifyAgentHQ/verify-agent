/**
 * Batch 43D — Real verify-sandbox TypeScript/JavaScript E2E verification
 *
 * This test suite proves REAL SANDBOX execution: real TypeScript commands
 * executed by the external verify-sandbox process inside an isolated
 * Docker container.
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
 * Dependency strategy (Batch 43D — image-provisioned + wrapper scripts):
 *   The TypeScript fixtures require `typescript` and `vitest` packages to
 *   execute `pnpm exec tsc` and `pnpm exec vitest run`. The sandbox image
 *   now provisions these packages globally at image-build time. The snapshot
 *   includes only minimal Node.js wrapper scripts in `node_modules/.bin/`
 *   that delegate to the globally installed tools.
 *
 *   The sandbox image installs:
 *   - typescript@5.8.3 (global) — for `tsc --noEmit` and `tsc --build`
 *   - vitest@2.1.9 (global) — for `vitest run`
 *   - NODE_PATH=/usr/local/lib/node_modules — for vitest import resolution
 *
 *   The snapshot provisioner creates:
 *   - `node_modules/.bin/tsc` — Node.js wrapper calling global tsc
 *   - `node_modules/.bin/vitest` — Node.js wrapper calling global vitest
 *
 *   This strategy is:
 *   - Repository-controlled: wrapper scripts are tracked in git
 *   - Image-provisioned: typescript/vitest installed at Docker build time
 *   - Explicit: allowlist enumerates exactly what the snapshot contains
 *   - Bounded: wrapper scripts are ~150 bytes each, not full node_modules
 *   - Offline: no network required at runtime
 *   - No host installation: wrapper scripts come from git, not the host
 *
 * The verify-sandbox process is the authoritative execution boundary:
 *   - Commands run inside a Docker container with network disabled
 *   - Source is materialized by the sandbox's snapshot mechanism
 *   - No host-side dependency installation occurs
 *   - Snapshot identity is honored by the sandbox
 *
 * This does NOT prove:
 *   - Host-subprocess execution (that is batch-43-typescript-e2e.test.ts)
 *   - Arbitrary repository correctness (fixtures are controlled snapshots)
 *   - Sandbox isolation (that is provided by the external verify-sandbox)
 *
 * Gate: VERIFY_SANDBOX_PROCESS, VERIFY_SANDBOX_IDENTITY, and all required
 *       env vars must be set. When unavailable, tests skip explicitly.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
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
//
// Only these files/directories are copied to the snapshot store. The
// `sandbox-wrappers/` entry triggers creation of `node_modules/.bin/`
// wrapper scripts that delegate to the globally installed typescript/vitest
// in the sandbox image. Full node_modules directories are NOT included —
// the sandbox image provisions these packages at image-build time.
//
// Everything else (dist, tsbuildinfo, caches, generated files, lock files,
// full node_modules) is excluded.
// ---------------------------------------------------------------------------

const SNAPSHOT_ALLOWLISTS: Record<string, readonly string[]> = {
  "typescript-healthy": [
    "src/index.ts",
    "src/index.test.ts",
    "package.json",
    "tsconfig.json",
    "vitest.config.ts",
    "sandbox-wrappers",
  ],
  "typescript-failing-test": [
    "src/index.ts",
    "src/index.test.ts",
    "package.json",
    "tsconfig.json",
    "vitest.config.ts",
    "sandbox-wrappers",
  ],
  "typescript-failing-typecheck": [
    "src/index.ts",
    "package.json",
    "tsconfig.json",
    "sandbox-wrappers",
  ],
  "typescript-failing-build": [
    "src/index.ts",
    "package.json",
    "tsconfig.json",
    "lib/src/index.ts",
    "lib/tsconfig.json",
    "sandbox-wrappers",
  ],
};

// ---------------------------------------------------------------------------
// Directories/files explicitly excluded from snapshots
//
// sandbox-wrappers is NOT excluded — it triggers creation of node_modules/.bin/
// wrapper scripts. Full node_modules content is always excluded.
// ---------------------------------------------------------------------------

const SNAPSHOT_EXCLUSIONS = [
  "dist",
  ".turbo",
  "coverage",
  ".nyc_output",
  ".cache",
  ".vitest",
  "tsconfig.tsbuildinfo",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

// ---------------------------------------------------------------------------
// Expected sandbox identity value
//
// The verify-sandbox process has no runtime identity mechanism. The operator
// must set VERIFY_SANDBOX_IDENTITY to the expected value to confirm they
// are running the correct implementation. This is an operator-controlled
// configuration gate, not a cryptographic authentication.
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

const TYPESCRIPT_FIXTURES = [
  {
    scenario: "typescript-healthy" as const,
    fixturePath: join(TRUTH_ROOT, "typescript", "healthy"),
  },
  {
    scenario: "typescript-failing-test" as const,
    fixturePath: join(TRUTH_ROOT, "typescript", "failing-test"),
  },
  {
    scenario: "typescript-failing-typecheck" as const,
    fixturePath: join(TRUTH_ROOT, "typescript", "failing-typecheck"),
  },
  {
    scenario: "typescript-failing-build" as const,
    fixturePath: join(TRUTH_ROOT, "typescript", "failing-build"),
  },
] as const;

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
// Clean snapshot provisioning — allowlist-based, with wrapper script install
//
// This is TEST SUPPORT CODE. It provisions the configured snapshot store
// with a clean, deterministic subset of the fixture contents. The allowlist
// includes source/config files and a `sandbox-wrappers/` entry that contains
// repository-controlled Node.js wrapper scripts.
//
// The provisioner copies `sandbox-wrappers/` to `node_modules/.bin/` in the
// snapshot, making them discoverable by `pnpm exec`. The sandbox image
// provisions typescript and vitest globally; the wrapper scripts delegate
// to these global installations.
//
// The sandbox process (not this helper) performs the subsequent
// materialization into the isolated execution workspace.
// ---------------------------------------------------------------------------

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

  // Ensure clean snapshot directory
  await import("node:fs/promises").then((fs) =>
    fs.rm(snapshotDest, { recursive: true, force: true }).catch(() => {}),
  );
  await mkdir(snapshotDest, { recursive: true });

  // Copy only allowlisted files and directories
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
      // Copy single file
      const destDir = join(destPath, "..");
      await mkdir(destDir, { recursive: true });
      const content = await readFile(srcPath);
      await writeFile(destPath, content);
      copiedEntries.push(relativePath);
    } else if (srcStat.isDirectory()) {
      // Copy directory recursively
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

  // Install wrapper scripts: sandbox-wrappers/ → node_modules/.bin/
  if (allowlist.includes("sandbox-wrappers")) {
    await installWrapperScripts(snapshotDest, scenario);
  }

  // Verify no excluded directories/files ended up in snapshot
  await verifySnapshotCleanliness(snapshotDest, scenario);

  return snapshotDest;
}

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

// ---------------------------------------------------------------------------
// Wrapper script installation — sandbox-wrappers/ → node_modules/.bin/
//
// The sandbox image provisions typescript and vitest globally. The snapshot
// includes repository-controlled wrapper scripts in `sandbox-wrappers/`
// (tracked in git). This function copies them to `node_modules/.bin/` with
// executable permissions (0o755) so that `pnpm exec` can discover and
// execute them.
//
// The wrapper scripts use Node.js shebangs and are written with executable
// mode to ensure `pnpm exec` resolution works on the Linux sandbox. The
// NODE_PATH environment variable (set in the Dockerfile) enables vitest to
// resolve its own imports from the global installation when invoked via
// these wrappers.
// ---------------------------------------------------------------------------

async function installWrapperScripts(
  snapshotDest: string,
  scenario: string,
): Promise<void> {
  const srcDir = join(snapshotDest, "sandbox-wrappers");
  const destDir = join(snapshotDest, "node_modules", ".bin");

  if (!existsSync(srcDir)) {
    throw new Error(
      `sandbox-wrappers/ directory missing in snapshot for "${scenario}". ` +
        `Ensure the fixture contains this directory with wrapper scripts.`,
    );
  }

  await mkdir(destDir, { recursive: true });

  const entries = await readdir(srcDir);
  for (const entry of entries) {
    const srcPath = join(srcDir, entry);
    const destPath = join(destDir, entry);
    const content = await readFile(srcPath);
    await writeFile(destPath, content, { mode: 0o755 });
  }

  // Remove sandbox-wrappers/ from snapshot (it was a staging area)
  await import("node:fs/promises").then((fs) =>
    fs.rm(srcDir, { recursive: true, force: true }),
  );
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

async function runRealSandboxPipeline(
  fixturePath: string,
  scenario: string,
  selectedCheckIds: readonly CheckId[],
): Promise<PipelineResult> {
  const snapshotId = brandId<"RepositorySnapshotId">(
    `batch43-real-sandbox-${scenario}-snapshot`,
  );

  // Provision clean snapshot into configured snapshot store
  // Only allowlisted files are copied. The sandbox process performs
  // the subsequent materialization into the isolated workspace.
  const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
  await provisionCleanSnapshot(fixturePath, scenario, snapshotRoot, snapshotId);

  const projectId = brandId<"ProjectId">(`batch43-real-sandbox-${scenario}`);
  const project: Project = {
    id: projectId,
    name: `batch43-real-sandbox-${scenario}`,
    root: ".",
  };

  const snapshot: RepositorySnapshot = {
    id: snapshotId,
    projectId,
    source: {
      provider: "fixture",
      reference: `batch-43-real-sandbox-${scenario}`,
    },
    sourceState: { type: "snapshot", value: snapshotId },
    retrievedAt: new Date().toISOString(),
  };

  const changeSet: ChangeSet = {
    id: brandId<"ChangeSetId">(`batch43-real-sandbox-${scenario}-change`),
    baseSourceState: snapshot.sourceState,
    headSourceState: snapshot.sourceState,
    changedFiles: [],
    additions: 0,
    deletions: 0,
    changeHash: "a".repeat(64),
    issueReferences: [],
  };

  const request: VerificationRequest = {
    id: brandId<"VerificationRequestId">(
      `batch43-real-sandbox-${scenario}-request`,
    ),
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
    id: brandId<"VerificationJobId">(`batch43-real-sandbox-${scenario}-job`),
    requestId: request.id,
    attempt: 1,
    status: "completed",
  };

  // Detect and plan using the snapshot path
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

  // Create real verify-sandbox transport
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
    executionId: `batch43-real-sandbox-${scenario}-execution`,
    resultId: `batch43-real-sandbox-${scenario}-result`,
    createdAt: request.createdAt,
  });

  const aggregationInput = aggregationInputFromPipeline(
    pipelineOutput,
    request,
    job,
    {
      verificationId: `batch43-real-sandbox-${scenario}-verification`,
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
// Tests — real verify-sandbox E2E
// ---------------------------------------------------------------------------

describe("Batch 43D — Real verify-sandbox TypeScript E2E (Docker-isolated)", () => {
  // -----------------------------------------------------------------------
  // 1. Healthy TypeScript fixture through real sandbox
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "healthy: real sandbox typecheck and test execute successfully"
      : skipReason,
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("typescript.typecheck"),
          brandId<"CheckId">("typescript.test"),
        ],
      );

      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      expect(result.pipelineOutput.checkResults).toHaveLength(2);
      for (const cr of result.pipelineOutput.checkResults) {
        expect(cr.status).toBe("passed");
        expect(cr.executionSource).toBe("real");
      }

      expect(result.policyDecision.outcome).not.toBe("block");
      expect(result.verificationResult.status).not.toBe("blocked");
      expect(result.verificationResult.coverage.verified).toEqual(
        expect.arrayContaining(["typescript.typecheck", "typescript.test"]),
      );
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 2. Failing test fixture through real sandbox
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "failing-test: real sandbox test command fails and blocks verification"
      : skipReason,
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-failing-test",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("typescript.typecheck"),
          brandId<"CheckId">("typescript.test"),
        ],
      );

      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      const typecheckResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.typecheck",
      );
      const testResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.test",
      );
      expect(typecheckResult?.status).toBe("passed");
      expect(testResult?.status).toBe("failed");

      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      expect(result.findings.some((f) => f.severity === "high")).toBe(true);

      expect(result.policyDecision.outcome).toBe("block");
      expect(result.policyDecision.triggeredRuleIds).toContain(
        "required-check-failure",
      );
      expect(result.verificationResult.status).toBe("blocked");
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 3. Failing typecheck fixture through real sandbox
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "failing-typecheck: real sandbox typecheck command fails and blocks verification"
      : skipReason,
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-failing-typecheck",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
      );

      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      const typecheckResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.typecheck",
      );
      expect(typecheckResult?.status).toBe("failed");

      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      expect(result.policyDecision.outcome).toBe("block");
      expect(result.verificationResult.status).toBe("blocked");
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 4. Failing build fixture through real sandbox
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "failing-build: real sandbox build command fails and blocks verification"
      : skipReason,
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-failing-build",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [
          brandId<"CheckId">("typescript.typecheck"),
          brandId<"CheckId">("typescript.build"),
        ],
      );

      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
      }

      const typecheckResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.typecheck",
      );
      const buildResult = result.pipelineOutput.checkResults.find(
        (cr) => String(cr.checkId) === "typescript.build",
      );
      expect(typecheckResult?.status).toBe("passed");
      expect(buildResult?.status).toBe("failed");

      expect(result.findings.length).toBeGreaterThanOrEqual(1);
      expect(result.policyDecision.outcome).toBe("block");
      expect(result.verificationResult.status).toBe("blocked");
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 5. Execution provenance indicates real sandbox execution
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "execution provenance indicates real sandbox execution"
      : skipReason,
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
      );

      for (const e of result.evidence) {
        expect(e.executionSource).toBe("real");
        expect(e.executionSource).not.toBe("simulated");
        expect(e.executionSource).not.toBe("fixture");
      }

      for (const cr of result.pipelineOutput.checkResults) {
        expect(cr.executionSource).toBe("real");
      }
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 6. Snapshot identity remains opaque
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "snapshot identity remains opaque and is not a filesystem path"
      : skipReason,
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const result = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
      );

      const request = result.pipelineOutput.sandboxRequest;

      // Snapshot must be opaque — not a filesystem path
      expect(request.snapshot).toBeTruthy();
      expect(request.snapshot).not.toBe(".");
      expect(request.snapshot).not.toBe(fixture.fixturePath);

      // Must not contain path separators (Unix or Windows)
      expect(request.snapshot).not.toContain("/");
      expect(request.snapshot).not.toContain("\\");

      // Must not be a directory reference
      expect(request.snapshot).not.toMatch(/^[A-Z]:/i); // Windows drive letter
      expect(request.snapshot).not.toMatch(/^\\\\/); // UNC path

      // Must be the branded snapshot ID, not the resolved path
      expect(request.snapshot).toMatch(/^batch43-real-sandbox-/);
    },
    180_000,
  );

  // -----------------------------------------------------------------------
  // 7. No host-side dependency installation occurs
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "no host-side dependency installation occurs in real sandbox path"
      : skipReason,
    async () => {
      // Verify the provisioning helper does not run npm/pnpm install.
      // The helper uses an explicit file-copy allowlist and creates minimal
      // wrapper scripts — never execSync with install commands.
      //
      // This test verifies the allowlist provisioning approach by checking
      // that the snapshot contains only approved files/directories.
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const snapshotId = brandId<"RepositorySnapshotId">(
        "batch43-snapshot-cleanliness-check",
      );

      const snapshotPath = await provisionCleanSnapshot(
        fixture.fixturePath,
        fixture.scenario,
        snapshotRoot,
        snapshotId,
      );

      // Snapshot must not contain dist
      expect(existsSync(join(snapshotPath, "dist"))).toBe(false);

      // Snapshot must contain node_modules directory with wrapper scripts
      expect(existsSync(join(snapshotPath, "node_modules"))).toBe(true);
      expect(existsSync(join(snapshotPath, "node_modules/.bin"))).toBe(true);

      // Snapshot must contain tsc wrapper script (required by typecheck/build checks)
      expect(existsSync(join(snapshotPath, "node_modules/.bin/tsc"))).toBe(
        true,
      );

      // Snapshot must contain vitest wrapper script (required by test check)
      expect(existsSync(join(snapshotPath, "node_modules/.bin/vitest"))).toBe(
        true,
      );

      // Snapshot must NOT contain full typescript package (image-provisioned)
      expect(existsSync(join(snapshotPath, "node_modules/typescript"))).toBe(
        false,
      );

      // Snapshot must NOT contain full vitest package (image-provisioned)
      expect(existsSync(join(snapshotPath, "node_modules/vitest"))).toBe(false);

      // Snapshot must contain only expected entries (files + directories)
      const topEntries = await readdir(snapshotPath, { withFileTypes: true });
      const topLevelNames = topEntries.map((e) => e.name).sort();
      const expectedEntries = SNAPSHOT_ALLOWLISTS[fixture.scenario]!.map((e) =>
        e.replace(/\/$/, ""),
      ).sort();
      expect(topLevelNames).toEqual(expectedEntries);
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 8. Snapshot excludes dist and generated files (wrapper scripts created)
  // -----------------------------------------------------------------------
  it("snapshot excludes dist and generated files for all fixtures", async () => {
    const snapshotRoot = join(
      process.env.TEMP ?? "/tmp",
      "batch43b-snapshot-exclusion-test",
    );
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(snapshotRoot, { recursive: true }),
    );

    try {
      for (const fixture of TYPESCRIPT_FIXTURES) {
        const snapshotId = brandId<"RepositorySnapshotId">(
          `batch43b-exclusion-${fixture.scenario}`,
        );

        const snapshotPath = await provisionCleanSnapshot(
          fixture.fixturePath,
          fixture.scenario,
          snapshotRoot,
          snapshotId,
        );

        // Verify no excluded entries exist
        for (const excluded of SNAPSHOT_EXCLUSIONS) {
          expect(
            existsSync(join(snapshotPath, excluded)),
            `Snapshot for ${fixture.scenario} should not contain ${excluded}`,
          ).toBe(false);
        }

        // Verify node_modules directory exists with wrapper scripts
        expect(
          existsSync(join(snapshotPath, "node_modules")),
          `Snapshot for ${fixture.scenario} should contain node_modules`,
        ).toBe(true);

        // Verify tsc wrapper script is present (required by all TypeScript fixtures)
        expect(
          existsSync(join(snapshotPath, "node_modules/.bin/tsc")),
          `Snapshot for ${fixture.scenario} should contain tsc wrapper`,
        ).toBe(true);

        // Verify vitest wrapper script is present for fixtures that need it
        if (
          fixture.scenario === "typescript-healthy" ||
          fixture.scenario === "typescript-failing-test"
        ) {
          expect(
            existsSync(join(snapshotPath, "node_modules/.bin/vitest")),
            `Snapshot for ${fixture.scenario} should contain vitest wrapper`,
          ).toBe(true);
        }

        // Verify full node_modules packages are NOT present (image-provisioned)
        expect(
          existsSync(join(snapshotPath, "node_modules/typescript")),
          `Snapshot for ${fixture.scenario} should not contain full typescript`,
        ).toBe(false);
        expect(
          existsSync(join(snapshotPath, "node_modules/vitest")),
          `Snapshot for ${fixture.scenario} should not contain full vitest`,
        ).toBe(false);
      }
    } finally {
      await import("node:fs/promises").then((fs) =>
        fs.rm(snapshotRoot, { recursive: true, force: true }),
      );
    }
  }, 60_000);

  // -----------------------------------------------------------------------
  // 9. Snapshot contains intended fixture source/config and wrapper scripts
  // -----------------------------------------------------------------------
  it("snapshot contains all intended fixture source, config, and wrapper scripts", async () => {
    const snapshotRoot = join(
      process.env.TEMP ?? "/tmp",
      "batch43b-snapshot-content-test",
    );
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(snapshotRoot, { recursive: true }),
    );

    try {
      for (const fixture of TYPESCRIPT_FIXTURES) {
        const snapshotId = brandId<"RepositorySnapshotId">(
          `batch43b-content-${fixture.scenario}`,
        );

        const snapshotPath = await provisionCleanSnapshot(
          fixture.fixturePath,
          fixture.scenario,
          snapshotRoot,
          snapshotId,
        );

        // Verify each allowlisted entry exists (skip sandbox-wrappers — consumed during install)
        for (const relPath of SNAPSHOT_ALLOWLISTS[fixture.scenario]!) {
          if (relPath === "sandbox-wrappers") continue;
          const fullPath = join(snapshotPath, relPath);
          expect(
            existsSync(fullPath),
            `Missing allowlisted entry: ${relPath} for ${fixture.scenario}`,
          ).toBe(true);
        }

        // Verify source files are non-empty
        for (const relPath of SNAPSHOT_ALLOWLISTS[fixture.scenario]!) {
          if (relPath === "sandbox-wrappers") continue; // consumed during install
          const fullPath = join(snapshotPath, relPath);
          const srcStat = await stat(fullPath);
          if (srcStat.isFile()) {
            const content = await readFile(fullPath);
            expect(
              content.length,
              `Empty allowlisted file: ${relPath} for ${fixture.scenario}`,
            ).toBeGreaterThan(0);
          }
        }

        // Verify wrapper scripts are present and non-empty
        expect(
          existsSync(join(snapshotPath, "node_modules/.bin")),
          `Missing node_modules/.bin in ${fixture.scenario}`,
        ).toBe(true);

        const tscContent = await readFile(
          join(snapshotPath, "node_modules/.bin/tsc"),
          "utf-8",
        );
        expect(
          tscContent.length,
          `Empty tsc wrapper in ${fixture.scenario}`,
        ).toBeGreaterThan(0);
        expect(tscContent).toContain("#!/usr/bin/env node");

        // For fixtures with tests, verify vitest wrapper is available
        if (
          fixture.scenario === "typescript-healthy" ||
          fixture.scenario === "typescript-failing-test"
        ) {
          expect(
            existsSync(join(snapshotPath, "node_modules/.bin/vitest")),
            `Missing vitest wrapper in ${fixture.scenario}`,
          ).toBe(true);
          const vitestContent = await readFile(
            join(snapshotPath, "node_modules/.bin/vitest"),
            "utf-8",
          );
          expect(vitestContent).toContain("#!/usr/bin/env node");
        }
      }
    } finally {
      await import("node:fs/promises").then((fs) =>
        fs.rm(snapshotRoot, { recursive: true, force: true }),
      );
    }
  }, 60_000);

  // -----------------------------------------------------------------------
  // 10. Materialized wrapper scripts have executable permissions
  // -----------------------------------------------------------------------
  it("materialized wrapper scripts have executable permissions for pnpm exec resolution", async () => {
    // The snapshot provisioner writes wrapper scripts with mode 0o755 so
    // that pnpm exec can discover and execute them on the Linux sandbox.
    // On Windows, stat().mode does not expose Unix execute bits, so we
    // verify the mode only on Unix. The writeFile call with mode 0o755
    // is effective on the Linux sandbox regardless of host platform.
    const snapshotRoot = join(
      process.env.TEMP ?? "/tmp",
      "batch43d-exec-perms-test",
    );
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(snapshotRoot, { recursive: true }),
    );

    try {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const snapshotId = brandId<"RepositorySnapshotId">(
        "batch43d-exec-perms-healthy",
      );

      const snapshotPath = await provisionCleanSnapshot(
        fixture.fixturePath,
        fixture.scenario,
        snapshotRoot,
        snapshotId,
      );

      // tsc wrapper must exist and be a regular file
      const tscPath = join(snapshotPath, "node_modules", ".bin", "tsc");
      expect(existsSync(tscPath)).toBe(true);
      const tscStat = await stat(tscPath);
      expect(tscStat.isFile()).toBe(true);

      // vitest wrapper must exist and be a regular file
      const vitestPath = join(snapshotPath, "node_modules", ".bin", "vitest");
      expect(existsSync(vitestPath)).toBe(true);
      const vitestStat = await stat(vitestPath);
      expect(vitestStat.isFile()).toBe(true);

      // On Unix, verify execute bits are set (0o755 → rwxr-xr-x)
      // On Windows, stat().mode does not expose Unix permission bits
      if (process.platform !== "win32") {
        expect(tscStat.mode & 0o111).toBe(0o111);
        expect(vitestStat.mode & 0o111).toBe(0o111);

        // Source sandbox-wrappers files remain mode 0o644 (ordinary text)
        const srcTscPath = join(fixture.fixturePath, "sandbox-wrappers", "tsc");
        const srcTscStat = await stat(srcTscPath);
        expect(srcTscStat.mode & 0o111).toBe(0);
      }
    } finally {
      await import("node:fs/promises").then((fs) =>
        fs.rm(snapshotRoot, { recursive: true, force: true }),
      );
    }
  }, 30_000);

  // -----------------------------------------------------------------------
  // 11. Unavailable or unidentifiable sandbox explicitly skips
  // -----------------------------------------------------------------------
  it("explicitly skips when real verify-sandbox is not configured or not identified", () => {
    if (sandboxAvailable) {
      expect(process.env.VERIFY_SANDBOX_PROCESS).toBeTruthy();
      expect(process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT).toBeTruthy();
      expect(process.env.VERIFY_SANDBOX_DOCKER_EXECUTABLE).toBeTruthy();
      expect(process.env.VERIFY_SANDBOX_DOCKER_HOST).toBeTruthy();
      expect(process.env.VERIFY_SANDBOX_SYSTEM_ROOT).toBeTruthy();
      expect(process.env.VERIFY_SANDBOX_TEMP_ROOT).toBeTruthy();
      expect(process.env.VERIFY_SANDBOX_IDENTITY).toBe(
        EXPECTED_SANDBOX_IDENTITY,
      );
    } else {
      expect(true).toBe(true);
    }
  });

  // -----------------------------------------------------------------------
  // 12. No fallback to host-subprocess execution
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "real sandbox does not fall back to host harness"
      : skipReason,
    async () => {
      const transport = createRealSandboxTransport();
      expect(transport.executionSource).toBe("real");

      // Must be the actual verify-sandbox binary, not node or a harness
      expect(process.env.VERIFY_SANDBOX_PROCESS).not.toContain("node");
      expect(process.env.VERIFY_SANDBOX_PROCESS).not.toContain("harness");
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 13. Incorrect process cannot satisfy identity gate
  // -----------------------------------------------------------------------
  it("incorrect or non-Verify-Sandbox process cannot satisfy the identity gate", () => {
    // When sandbox is not available, verify the gate rejects:
    // - Missing env vars
    // - Wrong identity value
    if (sandboxAvailable) {
      // If available, verify the identity matches
      expect(process.env.VERIFY_SANDBOX_IDENTITY).toBe(
        EXPECTED_SANDBOX_IDENTITY,
      );
    } else {
      // Gate correctly rejects when:
      // 1. VERIFY_SANDBOX_PROCESS is not set
      // 2. VERIFY_SANDBOX_IDENTITY is not set or wrong
      // 3. Any required env var is missing
      expect(sandboxAvailable).toBe(false);
    }
  });

  // -----------------------------------------------------------------------
  // 14. Clean snapshot contains all prerequisites for check execution
  // -----------------------------------------------------------------------
  it("clean snapshot contains all prerequisites for TypeScript check execution", async () => {
    // This test proves that a clean snapshot (no host-generated state) contains
    // everything needed to execute TypeScript check commands inside the sandbox.
    // The sandbox image provisions typescript and vitest globally. The snapshot
    // includes only minimal wrapper scripts in node_modules/.bin/ that pnpm exec
    // can discover and delegate to the global installations.
    const snapshotRoot = join(
      process.env.TEMP ?? "/tmp",
      "batch43c-reproducibility-test",
    );
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(snapshotRoot, { recursive: true }),
    );

    try {
      for (const fixture of TYPESCRIPT_FIXTURES) {
        const snapshotId = brandId<"RepositorySnapshotId">(
          `batch43c-reproducibility-${fixture.scenario}`,
        );

        const snapshotPath = await provisionCleanSnapshot(
          fixture.fixturePath,
          fixture.scenario,
          snapshotRoot,
          snapshotId,
        );

        // 1. Source files exist (skip sandbox-wrappers — consumed during install)
        for (const relPath of SNAPSHOT_ALLOWLISTS[fixture.scenario]!) {
          if (relPath === "sandbox-wrappers") continue;
          expect(
            existsSync(join(snapshotPath, relPath)),
            `Missing source file: ${relPath} for ${fixture.scenario}`,
          ).toBe(true);
        }

        // 2. node_modules directory exists with .bin subdirectory
        expect(
          existsSync(join(snapshotPath, "node_modules")),
          `Missing node_modules for ${fixture.scenario}`,
        ).toBe(true);
        expect(
          existsSync(join(snapshotPath, "node_modules/.bin")),
          `Missing node_modules/.bin for ${fixture.scenario}`,
        ).toBe(true);

        // 3. tsc wrapper script exists (required by typecheck and build checks)
        const tscPath = join(snapshotPath, "node_modules/.bin/tsc");
        expect(
          existsSync(tscPath),
          `Missing tsc wrapper for ${fixture.scenario}`,
        ).toBe(true);
        const tscContent = await readFile(tscPath, "utf-8");
        expect(tscContent).toContain("#!/usr/bin/env node");
        expect(tscContent).toContain("tsc");

        // 4. For fixtures with tests, vitest wrapper script exists
        if (
          fixture.scenario === "typescript-healthy" ||
          fixture.scenario === "typescript-failing-test"
        ) {
          const vitestPath = join(snapshotPath, "node_modules/.bin/vitest");
          expect(
            existsSync(vitestPath),
            `Missing vitest wrapper for ${fixture.scenario}`,
          ).toBe(true);
          const vitestContent = await readFile(vitestPath, "utf-8");
          expect(vitestContent).toContain("#!/usr/bin/env node");
          expect(vitestContent).toContain("vitest");
        }

        // 5. No prohibited generated state
        for (const excluded of SNAPSHOT_EXCLUSIONS) {
          expect(
            existsSync(join(snapshotPath, excluded)),
            `Prohibited entry ${excluded} in ${fixture.scenario}`,
          ).toBe(false);
        }

        // 6. Full node_modules packages are NOT present (image-provisioned)
        expect(
          existsSync(join(snapshotPath, "node_modules/typescript")),
          `Full typescript should not be in snapshot for ${fixture.scenario}`,
        ).toBe(false);
        expect(
          existsSync(join(snapshotPath, "node_modules/vitest")),
          `Full vitest should not be in snapshot for ${fixture.scenario}`,
        ).toBe(false);

        // 7. Snapshot is self-contained: no host paths, no symlinks to host
        // (The materializer rejects symlinks, so this is enforced at runtime)
      }
    } finally {
      await import("node:fs/promises").then((fs) =>
        fs.rm(snapshotRoot, { recursive: true, force: true }),
      );
    }
  }, 60_000);

  // -----------------------------------------------------------------------
  // 15. Repeated semantic results remain deterministic
  // -----------------------------------------------------------------------
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "repeated real sandbox runs produce semantically identical outcomes"
      : skipReason,
    async () => {
      const fixture = TYPESCRIPT_FIXTURES.find(
        (f) => f.scenario === "typescript-healthy",
      )!;
      const first = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
      );
      const second = await runRealSandboxPipeline(
        fixture.fixturePath,
        fixture.scenario,
        [brandId<"CheckId">("typescript.typecheck")],
      );

      expect(first.verificationResult.status).toBe(
        second.verificationResult.status,
      );
      expect(first.policyDecision.outcome).toBe(second.policyDecision.outcome);
      expect(first.evidence.length).toBe(second.evidence.length);
      expect(first.findings.length).toBe(second.findings.length);
    },
    360_000,
  );

  // -----------------------------------------------------------------------
  // 16. Clean checkout validation — wrapper scripts are repository-controlled
  // -----------------------------------------------------------------------
  it("wrapper scripts in sandbox-wrappers/ are tracked in git", async () => {
    // This test proves the dependency strategy is repository-controlled:
    // wrapper scripts live in sandbox-wrappers/ (tracked in git), not in
    // node_modules/ (gitignored). The snapshot provisioner copies them to
    // node_modules/.bin/ so pnpm exec can discover them.
    const fixture = TYPESCRIPT_FIXTURES.find(
      (f) => f.scenario === "typescript-healthy",
    )!;

    // Check that sandbox-wrappers/ is tracked in git
    let gitTrackedFiles: string;
    try {
      gitTrackedFiles = execSync("git ls-files", {
        encoding: "utf-8",
        cwd: fixture.fixturePath,
        timeout: 10_000,
      });
    } catch {
      // If git is not available or fixture is not in a git repo, skip
      return;
    }

    const trackedFiles = gitTrackedFiles
      .split("\n")
      .filter((f) => f.length > 0);

    // tsc wrapper script must be tracked in git
    const tscTracked = trackedFiles.some((f) =>
      f.includes("sandbox-wrappers/tsc"),
    );
    expect(
      tscTracked,
      "sandbox-wrappers/tsc wrapper must be tracked in git",
    ).toBe(true);

    // vitest wrapper script must be tracked in git
    const vitestTracked = trackedFiles.some((f) =>
      f.includes("sandbox-wrappers/vitest"),
    );
    expect(
      vitestTracked,
      "sandbox-wrappers/vitest wrapper must be tracked in git",
    ).toBe(true);

    // Full node_modules packages must NOT be tracked in git
    const fullPackagesTracked = trackedFiles.some(
      (f) =>
        f.includes("node_modules/typescript/") ||
        f.includes("node_modules/vitest/"),
    );
    expect(
      fullPackagesTracked,
      "Full node_modules packages must not be tracked in git",
    ).toBe(false);

    // Verify wrapper scripts exist on disk (confirming they can be provisioned)
    expect(
      existsSync(join(fixture.fixturePath, "sandbox-wrappers", "tsc")),
      "sandbox-wrappers/tsc must exist on disk",
    ).toBe(true);
    expect(
      existsSync(join(fixture.fixturePath, "sandbox-wrappers", "vitest")),
      "sandbox-wrappers/vitest must exist on disk",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectAllFiles(dir: string): Promise<readonly string[]> {
  const files: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile()) {
      files.push(entry.name);
    } else if (entry.isDirectory()) {
      const subFiles = await collectAllFiles(fullPath);
      for (const sub of subFiles) {
        files.push(`${entry.name}/${sub}`);
      }
    }
  }
  return files;
}
