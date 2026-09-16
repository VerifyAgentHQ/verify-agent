#!/usr/bin/env node

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  brandId,
  type CheckId,
  type RepositorySnapshot,
  type VerificationRequest,
  type VerificationJob,
  type ChangeSet,
  type Project,
} from "@verify-agent/domain";
import {
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
  aggregateVerification,
  aggregationInputFromPipeline,
  SubprocessSandboxTransport,
} from "@verify-agent/engine";
import {
  createFileSystemDetectionContext,
  createProjectDetectionService,
} from "@verify-agent/adapters-lang";
import { createCheckPlanner } from "@verify-agent/checks";
import { createTrustedExecutionSpecRegistry } from "@verify-agent/checks";
import { formatResult, formatError } from "./format.js";

const HARNESS_PATH = resolve(
  import.meta.dirname,
  "../../../tests/fixtures/sandbox-real-execution-harness.mjs",
);

function getNodeExecutable(): string {
  return process.execPath;
}

function getSystemPath(): string {
  const paths: string[] = [];
  const systemRoot = process.env.SYSTEMROOT ?? "C:\\Windows";
  paths.push(join(systemRoot, "System32"));
  const nodeDir = resolve(process.execPath, "..");
  paths.push(nodeDir);
  const npmGlobal = resolve(process.env.APPDATA ?? "", "npm");
  if (existsSync(npmGlobal)) paths.push(npmGlobal);
  const userLocal = resolve(process.env.USERPROFILE ?? "", ".local", "bin");
  if (existsSync(userLocal)) paths.push(userLocal);
  return process.platform === "win32" ? paths.join(";") : paths.join(":");
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

function parseArgs(argv: string[]): {
  path?: string;
  json?: boolean;
  allowHostExecution?: boolean;
} {
  const args = argv.slice(2);
  let path: string | undefined;
  let json = false;
  let allowHostExecution = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--allow-host-execution") {
      allowHostExecution = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("-")) {
      path = arg;
    } else {
      process.stderr.write(`Unknown option: ${arg}\n`);
      printUsage();
      process.exit(2);
    }
  }
  return { path, json, allowHostExecution };
}

function printUsage(): void {
  process.stderr.write(
    "Usage: verify-agent verify <path> [--json] [--allow-host-execution]\n\n" +
      "Run the VerifyAgent verification pipeline against a local repository.\n\n" +
      "Arguments:\n" +
      "  <path>     Path to the repository directory to verify\n\n" +
      "Options:\n" +
      "  --json     Output machine-readable JSON instead of human-readable text\n" +
      "  --allow-host-execution\n" +
      "             Acknowledge that repository tooling will execute on the host.\n" +
      "             Without this flag, verification is refused for safety.\n" +
      "  -h, --help Show this help message\n\n" +
      "Exit codes:\n" +
      "  0  Verification completed without blocking\n" +
      "  1  Verification completed with a blocking result\n" +
      "  2  Invalid CLI input or missing safety acknowledgement\n" +
      "  3  Unexpected internal error\n",
  );
}

interface CliResult {
  readonly status: string;
  readonly coverage: {
    readonly verified: readonly string[];
    readonly partial: readonly string[];
    readonly unsupported: readonly string[];
    readonly notApplicable: readonly string[];
  };
  readonly checkResults: readonly {
    readonly checkId: string;
    readonly status: string;
    readonly executionSource: string;
    readonly summary: string;
  }[];
  readonly findings: readonly {
    readonly severity: string;
    readonly title: string;
    readonly description: string;
  }[];
  readonly policyDecision: {
    readonly outcome: string;
    readonly triggeredRuleIds: readonly string[];
  };
  readonly profile: {
    readonly languages: readonly string[];
    readonly frameworks: readonly string[];
    readonly supportedCapabilities: readonly string[];
  };
  readonly execution: {
    readonly source: string;
    readonly sandboxed: boolean;
  };
}

async function runVerification(targetPath: string): Promise<CliResult> {
  const projectId = brandId<"ProjectId">("cli-local");
  const snapshotId = brandId<"RepositorySnapshotId">("cli-local-snapshot");

  const project: Project = {
    id: projectId,
    name: "cli-local",
    root: ".",
  };

  const snapshot: RepositorySnapshot = {
    id: snapshotId,
    projectId,
    source: { provider: "local", reference: "cli-verification" },
    sourceState: { type: "snapshot", value: snapshotId },
    retrievedAt: new Date().toISOString(),
  };

  const changeSet: ChangeSet = {
    id: brandId<"ChangeSetId">("cli-local-change"),
    baseSourceState: snapshot.sourceState,
    headSourceState: snapshot.sourceState,
    changedFiles: [],
    additions: 0,
    deletions: 0,
    changeHash: "a".repeat(64),
    issueReferences: [],
  };

  const request: VerificationRequest = {
    id: brandId<"VerificationRequestId">("cli-local-request"),
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
    id: brandId<"VerificationJobId">("cli-local-job"),
    requestId: request.id,
    attempt: 1,
    status: "completed",
  };

  const detectionContext = createFileSystemDetectionContext(targetPath);
  const detectionService = createProjectDetectionService();
  const planner = createCheckPlanner();
  const specRegistry = createTrustedExecutionSpecRegistry();

  const detected = detectionService.detect(project, snapshot, detectionContext);
  const plan = planner.plan(detected.profile, {
    disabledChecks: [
      brandId<"CheckId">("dependency.audit"),
      brandId<"CheckId">("security.analysis"),
      brandId<"CheckId">("license.analysis"),
    ],
  });

  const selectedCheckIds = plan.items
    .filter(
      (item) =>
        item.applicability === "applicable" &&
        specRegistry.find(item.checkId) !== undefined,
    )
    .map((item) => item.checkId);

  if (selectedCheckIds.length === 0) {
    throw new Error(
      "No applicable checks found for this repository. " +
        "Supported ecosystems: TypeScript/JavaScript, Rust/Soroban.",
    );
  }

  const transport = createLocalTransport(targetPath);
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
    selectedCheckIds,
    jobId: String(job.id),
    executionId: "cli-local-execution",
    resultId: "cli-local-result",
    createdAt: request.createdAt,
  });

  const aggregationInput = aggregationInputFromPipeline(
    pipelineOutput,
    request,
    job,
    {
      verificationId: "cli-local-verification",
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
  } satisfies CliResult;
}

function exitCodeForStatus(status: string): number {
  switch (status) {
    case "pass":
      return 0;
    case "blocked":
      return 1;
    case "needs_changes":
      return 1;
    case "partial":
      return 1;
    case "needs_review":
      return 1;
    case "error":
      return 3;
    default:
      return 3;
  }
}

function normalizeError(error: Error): string {
  const name = error.name;
  if (name === "VerificationApplicationServiceError") {
    return "Verification pipeline error.";
  }
  if (name === "SandboxTransportError") {
    return "Repository tooling execution failed.";
  }
  if (name === "SandboxTimeoutError") {
    return "Repository tooling execution timed out.";
  }
  if (name === "CheckExecutionError") {
    return "Check execution failed.";
  }
  return "An unexpected internal error occurred.";
}

async function main(): Promise<void> {
  const {
    path: targetPath,
    json,
    allowHostExecution,
  } = parseArgs(process.argv);

  if (!targetPath) {
    process.stderr.write("Error: No repository path provided.\n\n");
    printUsage();
    process.exit(2);
  }

  const resolved = resolve(targetPath);

  if (!existsSync(resolved)) {
    process.stderr.write(`Error: Path does not exist: ${resolved}\n`);
    process.exit(2);
  }

  if (!lstatSync(resolved).isDirectory()) {
    process.stderr.write(`Error: Path is not a directory: ${resolved}\n`);
    process.exit(2);
  }

  if (!allowHostExecution) {
    const message =
      "Error: Host execution not acknowledged.\n\n" +
      "This CLI executes repository tooling directly on the host machine.\n" +
      "It is NOT sandbox-isolated and NOT the external verify-sandbox.\n\n" +
      "To proceed, add the --allow-host-execution flag:\n" +
      `  node apps/cli/dist/index.js verify ${resolved} --allow-host-execution\n\n` +
      "Untrusted repositories should NOT be run through this mode.";
    if (json) {
      process.stdout.write(
        JSON.stringify({
          error: true,
          code: "host_execution_not_acknowledged",
          message:
            "Host execution not acknowledged. " +
            "This CLI executes repository tooling directly on the host machine. " +
            "It is NOT sandbox-isolated. " +
            "Add --allow-host-execution to proceed.",
        }) + "\n",
      );
    } else {
      process.stderr.write(message + "\n");
    }
    process.exit(2);
  }

  let result: CliResult;
  try {
    result = await runVerification(resolved);
  } catch (error) {
    const safeMessage =
      error instanceof Error
        ? normalizeError(error)
        : "An unexpected internal error occurred.";
    if (json) {
      process.stdout.write(
        JSON.stringify({
          error: true,
          code: "internal_error",
          message: safeMessage,
        }) + "\n",
      );
    } else {
      process.stderr.write(`Error: ${safeMessage}\n`);
    }
    process.exit(3);
  }

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(formatResult(resolved, result) + "\n");
  }

  process.exit(exitCodeForStatus(result.status));
}

void main();
