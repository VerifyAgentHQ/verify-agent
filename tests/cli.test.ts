import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  brandId,
  type CheckId,
  type RepositorySnapshot,
  type VerificationRequest,
  type VerificationJob,
  type ChangeSet,
  type Project,
} from "../packages/domain/src/index.js";
import {
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
  aggregateVerification,
  aggregationInputFromPipeline,
  SubprocessSandboxTransport,
} from "../packages/engine/src/index.js";
import {
  createFileSystemDetectionContext,
  createProjectDetectionService,
} from "../packages/adapters-lang/src/index.js";
import { createCheckPlanner } from "../packages/checks/src/index.js";
import { formatResult, formatError } from "../apps/cli/src/format.js";
import type { CliResult } from "../apps/cli/src/format.js";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

const TRUTH_ROOT = resolve("fixtures", "truth-matrix");
const HARNESS_PATH = resolve(
  "tests",
  "fixtures",
  "sandbox-real-execution-harness.mjs",
);
const CLI_PATH = resolve("apps", "cli", "dist", "index.js");

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
    return paths.join(";");
  }
  // On Unix (Linux, macOS), preserve the runner's normal PATH so child
  // processes can find standard system utilities (node, pnpm, tsc, etc.).
  return process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
}

function createLocalTransport(fixturePath: string) {
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

interface PipelineResult {
  readonly status: string;
  readonly coverage: CliResult["coverage"];
  readonly checkResults: CliResult["checkResults"];
  readonly findings: CliResult["findings"];
  readonly policyDecision: CliResult["policyDecision"];
  readonly profile: CliResult["profile"];
  readonly execution: CliResult["execution"];
}

async function runVerificationAgainstFixture(
  fixturePath: string,
  scenario: string,
  selectedCheckIds: readonly CheckId[],
): Promise<PipelineResult> {
  const projectId = brandId<"ProjectId">(`cli-test-${scenario}`);
  const snapshotId = brandId<"RepositorySnapshotId">(
    `cli-test-${scenario}-snapshot`,
  );

  const project: Project = {
    id: projectId,
    name: `cli-test-${scenario}`,
    root: ".",
  };

  const snapshot: RepositorySnapshot = {
    id: snapshotId,
    projectId,
    source: { provider: "fixture", reference: `cli-test-${scenario}` },
    sourceState: { type: "snapshot", value: snapshotId },
    retrievedAt: new Date().toISOString(),
  };

  const changeSet: ChangeSet = {
    id: brandId<"ChangeSetId">(`cli-test-${scenario}-change`),
    baseSourceState: snapshot.sourceState,
    headSourceState: snapshot.sourceState,
    changedFiles: [],
    additions: 0,
    deletions: 0,
    changeHash: "a".repeat(64),
    issueReferences: [],
  };

  const request: VerificationRequest = {
    id: brandId<"VerificationRequestId">(`cli-test-${scenario}-request`),
    projectId,
    snapshotId,
    changeSetId: changeSet.id,
    requestedBy: { type: "human" },
    mode: "manual",
    requestedChecks: [],
    policyId: brandId<"PolicyId">("policy.default"),
    priority: 0,
    createdAt: new Date().toISOString(),
  };

  const job: VerificationJob = {
    id: brandId<"VerificationJobId">(`cli-test-${scenario}-job`),
    requestId: request.id,
    attempt: 1,
    status: "completed",
  };

  const detectionContext = createFileSystemDetectionContext(fixturePath);
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

  const transport = createLocalTransport(fixturePath);
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
    executionId: `cli-test-${scenario}-execution`,
    resultId: `cli-test-${scenario}-result`,
    createdAt: request.createdAt,
  });

  const aggregationInput = aggregationInputFromPipeline(
    pipelineOutput,
    request,
    job,
    {
      verificationId: `cli-test-${scenario}-verification`,
      createdAt: request.createdAt,
    },
  );

  const aggregationOutput = aggregateVerification(aggregationInput);

  return {
    status: aggregationOutput.result.status,
    coverage: aggregationOutput.result.coverage,
    checkResults: pipelineOutput.checkResults.map((cr) => ({
      checkId: String(cr.checkId),
      status: cr.status,
      executionSource: cr.executionSource,
      summary: cr.summary,
    })),
    findings: aggregationOutput.findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      description: f.description,
    })),
    policyDecision: {
      outcome: aggregationOutput.policyDecision.outcome,
      triggeredRuleIds: aggregationOutput.policyDecision.triggeredRuleIds,
    },
    profile: {
      languages: detected.profile.languages,
      frameworks: detected.profile.frameworks,
      supportedCapabilities: detected.profile.supportedCapabilities,
    },
    execution: {
      source: transport.executionSource,
      sandboxed: false,
    },
  } satisfies PipelineResult;
}

// ---------------------------------------------------------------------------
// Format unit tests
// ---------------------------------------------------------------------------

describe("CLI format", () => {
  it("formatResult produces human-readable output", () => {
    const result: CliResult = {
      status: "pass",
      coverage: {
        verified: ["typescript.typecheck", "typescript.test"],
        partial: [],
        unsupported: [],
        notApplicable: [],
      },
      checkResults: [
        {
          checkId: "typescript.typecheck",
          status: "passed",
          executionSource: "real",
          summary: "tsc --noEmit passed",
        },
        {
          checkId: "typescript.test",
          status: "passed",
          executionSource: "real",
          summary: "vitest run passed",
        },
      ],
      findings: [],
      policyDecision: { outcome: "allow", triggeredRuleIds: [] },
      profile: {
        languages: ["typescript"],
        frameworks: [],
        supportedCapabilities: [
          "typescript.typecheck",
          "typescript.test",
          "typescript.build",
        ],
      },
      execution: { source: "real", sandboxed: false },
    };

    const output = formatResult("/some/path", result);
    expect(output).toContain("VerifyAgent");
    expect(output).toContain("Repository: /some/path");
    expect(output).toContain("typescript.typecheck  PASS");
    expect(output).toContain("typescript.test  PASS");
    expect(output).toContain("ALLOW");
    expect(output).toContain("PASS");
    expect(output).toContain("2/2 passed");
    expect(output).toContain("Execution: real");
    expect(output).toContain(
      "Warning: repository tooling will execute with host privileges.",
    );
  });

  it("formatResult shows findings for failures", () => {
    const result: CliResult = {
      status: "blocked",
      coverage: {
        verified: ["typescript.typecheck"],
        partial: ["typescript.test"],
        unsupported: [],
        notApplicable: [],
      },
      checkResults: [
        {
          checkId: "typescript.typecheck",
          status: "passed",
          executionSource: "real",
          summary: "tsc --noEmit passed",
        },
        {
          checkId: "typescript.test",
          status: "failed",
          executionSource: "real",
          summary: "vitest run failed",
        },
      ],
      findings: [
        {
          severity: "high",
          title: "typescript.test failed",
          description: "vitest run failed",
        },
      ],
      policyDecision: {
        outcome: "block",
        triggeredRuleIds: ["required-check-failure"],
      },
      profile: {
        languages: ["typescript"],
        frameworks: [],
        supportedCapabilities: ["typescript.typecheck", "typescript.test"],
      },
      execution: { source: "real", sandboxed: false },
    };

    const output = formatResult("/some/path", result);
    expect(output).toContain("BLOCKED");
    expect(output).toContain("BLOCK");
    expect(output).toContain("typescript.test  FAIL");
    expect(output).toContain("[HIGH] typescript.test failed");
    expect(output).toContain("1/2 passed");
    expect(output).toContain("Rules: required-check-failure");
  });

  it("formatError produces error string", () => {
    expect(formatError(new Error("test error"))).toBe("Error: test error");
    expect(formatError("string error")).toBe("Error: string error");
  });

  it("formatResult shows host execution warning when not sandboxed", () => {
    const result: CliResult = {
      status: "pass",
      coverage: {
        verified: ["typescript.typecheck"],
        partial: [],
        unsupported: [],
        notApplicable: [],
      },
      checkResults: [
        {
          checkId: "typescript.typecheck",
          status: "passed",
          executionSource: "real",
          summary: "tsc --noEmit passed",
        },
      ],
      findings: [],
      policyDecision: { outcome: "allow", triggeredRuleIds: [] },
      profile: {
        languages: ["typescript"],
        frameworks: [],
        supportedCapabilities: ["typescript.typecheck"],
      },
      execution: { source: "real", sandboxed: false },
    };

    const output = formatResult("/some/path", result);
    expect(output).toContain("Execution: real");
    expect(output).toContain(
      "Warning: repository tooling will execute with host privileges.",
    );
  });

  it("formatResult does not show host warning when sandboxed", () => {
    const result: CliResult = {
      status: "pass",
      coverage: {
        verified: ["typescript.typecheck"],
        partial: [],
        unsupported: [],
        notApplicable: [],
      },
      checkResults: [
        {
          checkId: "typescript.typecheck",
          status: "passed",
          executionSource: "simulated",
          summary: "tsc --noEmit passed",
        },
      ],
      findings: [],
      policyDecision: { outcome: "allow", triggeredRuleIds: [] },
      profile: {
        languages: ["typescript"],
        frameworks: [],
        supportedCapabilities: ["typescript.typecheck"],
      },
      execution: { source: "simulated", sandboxed: true },
    };

    const output = formatResult("/some/path", result);
    expect(output).toContain("Execution: simulated");
    expect(output).not.toContain("Warning:");
  });
});

// ---------------------------------------------------------------------------
// Truth-matrix verification tests
// ---------------------------------------------------------------------------

describe("CLI verification pipeline against truth fixtures", () => {
  it("healthy: passes with all checks passing", async () => {
    const fixture = resolve(TRUTH_ROOT, "typescript", "healthy");
    const result = await runVerificationAgainstFixture(fixture, "healthy", [
      brandId<"CheckId">("typescript.typecheck"),
      brandId<"CheckId">("typescript.test"),
    ]);

    for (const cr of result.checkResults) {
      expect(cr.executionSource).toBe("real");
    }

    expect(result.checkResults).toHaveLength(2);
    expect(result.checkResults.every((cr) => cr.status === "passed")).toBe(
      true,
    );
    expect(result.policyDecision.outcome).not.toBe("block");
    expect(result.status).not.toBe("blocked");
    expect(result.coverage.verified).toEqual(
      expect.arrayContaining(["typescript.typecheck", "typescript.test"]),
    );
    expect(result.profile.languages).toContain("typescript");
    expect(result.execution.source).toBe("real");
    expect(result.execution.sandboxed).toBe(false);

    const output = formatResult(fixture, result);
    expect(output).toContain("PASS");
    expect(output).toContain("2/2 passed");
    expect(output).toContain("Execution: real");
    expect(output).toContain(
      "Warning: repository tooling will execute with host privileges.",
    );
  }, 180_000);

  it("failing-test: blocks with test failure", async () => {
    const fixture = resolve(TRUTH_ROOT, "typescript", "failing-test");
    const result = await runVerificationAgainstFixture(
      fixture,
      "failing-test",
      [
        brandId<"CheckId">("typescript.typecheck"),
        brandId<"CheckId">("typescript.test"),
      ],
    );

    const typecheckResult = result.checkResults.find(
      (cr) => cr.checkId === "typescript.typecheck",
    );
    const testResult = result.checkResults.find(
      (cr) => cr.checkId === "typescript.test",
    );
    expect(typecheckResult?.status).toBe("passed");
    expect(testResult?.status).toBe("failed");

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.policyDecision.outcome).toBe("block");
    expect(result.policyDecision.triggeredRuleIds).toContain(
      "required-check-failure",
    );
    expect(result.status).toBe("blocked");

    const output = formatResult(fixture, result);
    expect(output).toContain("BLOCKED");
    expect(output).toContain("FAIL");
  }, 180_000);

  it("failing-typecheck: blocks with typecheck failure", async () => {
    const fixture = resolve(TRUTH_ROOT, "typescript", "failing-typecheck");
    const result = await runVerificationAgainstFixture(
      fixture,
      "failing-typecheck",
      [brandId<"CheckId">("typescript.typecheck")],
    );

    const typecheckResult = result.checkResults.find(
      (cr) => cr.checkId === "typescript.typecheck",
    );
    expect(typecheckResult?.status).toBe("failed");

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.policyDecision.outcome).toBe("block");
    expect(result.status).toBe("blocked");

    const output = formatResult(fixture, result);
    expect(output).toContain("BLOCKED");
    expect(output).toContain("FAIL");
  }, 180_000);

  it("failing-build: blocks with build failure", async () => {
    const fixture = resolve(TRUTH_ROOT, "typescript", "failing-build");
    const result = await runVerificationAgainstFixture(
      fixture,
      "failing-build",
      [
        brandId<"CheckId">("typescript.typecheck"),
        brandId<"CheckId">("typescript.build"),
      ],
    );

    const typecheckResult = result.checkResults.find(
      (cr) => cr.checkId === "typescript.typecheck",
    );
    const buildResult = result.checkResults.find(
      (cr) => cr.checkId === "typescript.build",
    );
    expect(typecheckResult?.status).toBe("passed");
    expect(buildResult?.status).toBe("failed");

    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.policyDecision.outcome).toBe("block");
    expect(result.status).toBe("blocked");

    const output = formatResult(fixture, result);
    expect(output).toContain("BLOCKED");
    expect(output).toContain("FAIL");
  }, 180_000);
});

// ---------------------------------------------------------------------------
// CLI subprocess tests
// ---------------------------------------------------------------------------

describe("CLI subprocess behavior", () => {
  it.skipIf(!existsSync(CLI_PATH))(
    "prints usage with --help",
    () => {
      try {
        execSync(`node "${CLI_PATH}" --help`, {
          encoding: "utf-8",
          timeout: 10_000,
        });
      } catch (error: unknown) {
        // --help may exit 0 but write to stderr
        const err = error as { status: number; stderr: string; stdout: string };
        const output = err.stderr || err.stdout || "";
        expect(output).toContain("Usage: verify-agent verify <path>");
        expect(output).toContain("--json");
        return;
      }
      // If no error, --help exited successfully
    },
    15_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "exits 2 with no path",
    () => {
      try {
        execSync(`node "${CLI_PATH}"`, {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: "pipe",
        });
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stderr: string };
        expect(err.status).toBe(2);
        expect(err.stderr).toContain("No repository path provided");
      }
    },
    15_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "exits 2 with nonexistent path",
    () => {
      try {
        execSync(`node "${CLI_PATH}" verify /nonexistent/path/xyz`, {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: "pipe",
        });
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stderr: string };
        expect(err.status).toBe(2);
        expect(err.stderr).toContain("does not exist");
      }
    },
    15_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "exits 2 with file path instead of directory",
    () => {
      try {
        execSync(`node "${CLI_PATH}" verify package.json`, {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: "pipe",
          cwd: process.cwd(),
        });
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stderr: string };
        expect(err.status).toBe(2);
        expect(err.stderr).toContain("not a directory");
      }
    },
    15_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "exits 2 without --allow-host-execution",
    () => {
      const healthy = resolve(TRUTH_ROOT, "typescript", "healthy");
      try {
        execSync(`node "${CLI_PATH}" verify "${healthy}"`, {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: "pipe",
        });
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stderr: string };
        expect(err.status).toBe(2);
        expect(err.stderr).toContain("Host execution not acknowledged");
        expect(err.stderr).toContain("NOT sandbox-isolated");
        expect(err.stderr).toContain("--allow-host-execution");
      }
    },
    15_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "healthy fixture: exits 1 (partial) with --allow-host-execution",
    () => {
      const healthy = resolve(TRUTH_ROOT, "typescript", "healthy");
      try {
        execSync(
          `node "${CLI_PATH}" verify "${healthy}" --allow-host-execution`,
          {
            encoding: "utf-8",
            timeout: 60_000,
            stdio: "pipe",
          },
        );
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stdout: string };
        expect(err.status).toBe(1);
        expect(err.stdout).toContain("PASS");
        expect(err.stdout).toContain("2/2 passed");
        expect(err.stdout).toContain("Execution: real");
        expect(err.stdout).toContain(
          "Warning: repository tooling will execute with host privileges.",
        );
      }
    },
    65_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "failing-test fixture: exits 1 with --allow-host-execution",
    () => {
      const failingTest = resolve(TRUTH_ROOT, "typescript", "failing-test");
      try {
        execSync(
          `node "${CLI_PATH}" verify "${failingTest}" --allow-host-execution`,
          {
            encoding: "utf-8",
            timeout: 60_000,
            stdio: "pipe",
          },
        );
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stdout: string };
        expect(err.status).toBe(1);
        expect(err.stdout).toContain("BLOCKED");
        expect(err.stdout).toContain("FAIL");
        expect(err.stdout).toContain("Execution: real");
      }
    },
    65_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "failing-typecheck fixture: exits 1 with --allow-host-execution",
    () => {
      const failingTypecheck = resolve(
        TRUTH_ROOT,
        "typescript",
        "failing-typecheck",
      );
      try {
        execSync(
          `node "${CLI_PATH}" verify "${failingTypecheck}" --allow-host-execution`,
          {
            encoding: "utf-8",
            timeout: 60_000,
            stdio: "pipe",
          },
        );
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stdout: string };
        expect(err.status).toBe(1);
        expect(err.stdout).toContain("BLOCKED");
        expect(err.stdout).toContain("FAIL");
      }
    },
    65_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "failing-build fixture: exits 1 with --allow-host-execution",
    () => {
      const failingBuild = resolve(TRUTH_ROOT, "typescript", "failing-build");
      try {
        execSync(
          `node "${CLI_PATH}" verify "${failingBuild}" --allow-host-execution`,
          {
            encoding: "utf-8",
            timeout: 60_000,
            stdio: "pipe",
          },
        );
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stdout: string };
        expect(err.status).toBe(1);
        expect(err.stdout).toContain("BLOCKED");
        expect(err.stdout).toContain("FAIL");
      }
    },
    65_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "healthy fixture: JSON output with --allow-host-execution",
    () => {
      const healthy = resolve(TRUTH_ROOT, "typescript", "healthy");
      try {
        execSync(
          `node "${CLI_PATH}" verify "${healthy}" --allow-host-execution --json`,
          {
            encoding: "utf-8",
            timeout: 60_000,
            stdio: "pipe",
          },
        );
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stdout: string };
        expect(err.status).toBe(1);
        const parsed = JSON.parse(err.stdout);
        expect(parsed.status).toBe("partial");
        expect(parsed.execution).toBeDefined();
        expect(parsed.execution.source).toBe("real");
        expect(parsed.execution.sandboxed).toBe(false);
        expect(parsed.checkResults).toBeDefined();
        expect(parsed.checkResults.length).toBeGreaterThan(0);
      }
    },
    65_000,
  );

  it.skipIf(!existsSync(CLI_PATH))(
    "without --allow-host-execution: JSON output includes error code",
    () => {
      const healthy = resolve(TRUTH_ROOT, "typescript", "healthy");
      try {
        execSync(`node "${CLI_PATH}" verify "${healthy}" --json`, {
          encoding: "utf-8",
          timeout: 10_000,
          stdio: "pipe",
        });
        expect.fail("should have thrown");
      } catch (error: unknown) {
        const err = error as { status: number; stdout: string };
        expect(err.status).toBe(2);
        const parsed = JSON.parse(err.stdout);
        expect(parsed.error).toBe(true);
        expect(parsed.code).toBe("host_execution_not_acknowledged");
        expect(parsed.message).toContain("NOT sandbox-isolated");
      }
    },
    15_000,
  );
});
