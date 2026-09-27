/**
 * Batch 52 — Runnable GitHub service through the real external sandbox.
 *
 * Proves the Batch 51 runnable service end to end with REAL sandbox
 * isolation (no `FakeSandboxTransport` anywhere in this file):
 *
 * ```text
 * authenticated GitHub webhook (POST /webhook → 202 + queueJobId)
 *   ↓ shared in-memory queue
 *   ↓ application-owned automatic runtime (no manual processNext/drain)
 *   ↓ VerificationJobProcessor → VerificationApplicationService
 *   ↓ real SubprocessSandboxTransport (executionSource "real")
 *   ↓ external verify-sandbox process (Docker-isolated)
 *   ↓ VerificationResult → bounded registry
 *   ↓ protected GET /verification-jobs/:queueJobId/result → 200
 *   ↓ service.stop() (runtime stopped, listener detached, server closed)
 * ```
 *
 * Honest service-selection note (Batch 53, derived from
 * `packages/engine/src/pipeline.ts`, NOT from sandbox behavior): the GitHub
 * webhook path enqueues jobs with `selection: "all-applicable"`, so the
 * pipeline executes every planner-applicable check that has a trusted
 * executable specification, in deterministic planner order. For the
 * TypeScript truth fixtures that means:
 * - healthy / failing-test (tsconfig + vitest signal): `typescript.typecheck`
 *   + `typescript.test`;
 * - failing-typecheck (tsconfig only): `typescript.typecheck` alone;
 * - failing-build (tsconfig + build script): `typescript.typecheck` +
 *   `typescript.build` (dependency-ordered).
 * Applicable checks without an executable specification (e.g.
 * `dependency.audit`) are never executed. Check-selection plumbing from
 * queue job to service is proven here, not follow-up work.
 *
 * Gate: VERIFY_SANDBOX_PROCESS, VERIFY_SANDBOX_SNAPSHOT_ROOT,
 * VERIFY_SANDBOX_DOCKER_EXECUTABLE, VERIFY_SANDBOX_DOCKER_HOST,
 * VERIFY_SANDBOX_SYSTEM_ROOT, VERIFY_SANDBOX_TEMP_ROOT, and
 * VERIFY_SANDBOX_IDENTITY (must equal "verify-sandbox-process-0.1.0").
 * When unavailable the real-sandbox tests skip explicitly with a clear
 * reason. There is NO host fallback: no FakeSandboxTransport, no Node
 * harness, no VERIFY_SANDBOX_WORKING_DIRECTORY anywhere in this file.
 *
 * Snapshot identity: each webhook head SHA maps to a fixture whose
 * snapshot `sourceState.value` is the provisioned snapshot-store
 * directory. The sandbox materializes solely from its configured store;
 * only that identity can execute, so successful completion proves the
 * request carried the provisioned identity (never a host path).
 *
 * No host-side dependency installation: snapshots are provisioned by
 * copying allowlisted fixture files plus repository-tracked wrapper
 * scripts (the sandbox image provides typescript/vitest globally).
 * No `npm/pnpm install`, no network, no arbitrary mounts.
 */

import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubVerificationService } from "../apps/api/src/github-verification-service.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubRepositorySnapshot,
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
} from "../packages/adapters-source/src/github.js";
import type { SourceContents } from "../packages/adapters-source/src/resolver.js";
import type { RepositorySnapshot } from "../packages/domain/src/index.js";
import { createVerificationQueueJob } from "../packages/domain/src/verification-queue.js";
import {
  SubprocessSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
} from "../packages/engine/src/index.js";

// ---------------------------------------------------------------------------
// Gate — same convention as the Batch 43/47 real-sandbox suites
// ---------------------------------------------------------------------------

const EXPECTED_SANDBOX_IDENTITY = "verify-sandbox-process-0.1.0";

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
  ? "SKIPPED — real verify-sandbox is not configured (requires VERIFY_SANDBOX_PROCESS and all related env vars; no host fallback is attempted)"
  : !identityVerified
    ? `SKIPPED — VERIFY_SANDBOX_IDENTITY does not match expected value (expected "${EXPECTED_SANDBOX_IDENTITY}", got "${process.env.VERIFY_SANDBOX_IDENTITY}")`
    : undefined;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const PR_NUMBER = 42;
const SECRET = "batch52-test-webhook-secret";
const INTERNAL_RESULT_TOKEN = "batch52-internal-result-token-for-tests-only";
const VALID_AUTH = `Bearer ${INTERNAL_RESULT_TOKEN}`;
const CREATED_AT = "2026-09-25T00:00:00.000Z";
const TRUTH_ROOT = join("fixtures", "truth-matrix", "typescript");

interface Batch52Scenario {
  readonly scenario: string;
  readonly fixturePath: string;
  readonly headSha: string;
  readonly allowlist: readonly string[];
}

const SCENARIOS: readonly Batch52Scenario[] = [
  {
    scenario: "typescript-healthy",
    fixturePath: join(TRUTH_ROOT, "healthy"),
    headSha: "d".repeat(40),
    allowlist: [
      "src/index.ts",
      "src/index.test.ts",
      "package.json",
      "tsconfig.json",
      "vitest.config.ts",
      "sandbox-wrappers",
    ],
  },
  {
    scenario: "typescript-failing-test",
    fixturePath: join(TRUTH_ROOT, "failing-test"),
    headSha: "e".repeat(40),
    allowlist: [
      "src/index.ts",
      "src/index.test.ts",
      "package.json",
      "tsconfig.json",
      "vitest.config.ts",
      "sandbox-wrappers",
    ],
  },
  {
    scenario: "typescript-failing-typecheck",
    fixturePath: join(TRUTH_ROOT, "failing-typecheck"),
    headSha: "f".repeat(40),
    allowlist: [
      "src/index.ts",
      "package.json",
      "tsconfig.json",
      "sandbox-wrappers",
    ],
  },
  {
    scenario: "typescript-failing-build",
    fixturePath: join(TRUTH_ROOT, "failing-build"),
    headSha: "9".repeat(40),
    allowlist: [
      "src/index.ts",
      "package.json",
      "tsconfig.json",
      "lib/src/index.ts",
      "lib/tsconfig.json",
      "sandbox-wrappers",
    ],
  },
];

function snapshotStoreId(scenario: string): string {
  return `batch52-real-service-${scenario}`;
}

function expectedSnapshotId(headSha: string): string {
  return `${OWNER}--${REPOSITORY}--${headSha}`;
}

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Snapshot provisioning — allowlist copy + wrapper install, no installs
//
// Mirrors the Batch 43D provisioning semantics: only allowlisted fixture
// files reach the snapshot store, `sandbox-wrappers/` becomes executable
// `node_modules/.bin/` entries, and nothing else (no lockfiles, no full
// node_modules, no dependency installation of any kind).
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
      await writeFile(destPath, await readFile(srcPath));
    } else if (entry.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    }
  }
}

async function provisionCleanSnapshot(
  scenario: Batch52Scenario,
  snapshotRoot: string,
): Promise<string> {
  const snapshotDest = join(snapshotRoot, snapshotStoreId(scenario.scenario));
  await rm(snapshotDest, { recursive: true, force: true }).catch(() => {});
  await mkdir(snapshotDest, { recursive: true });

  const missingEntries: string[] = [];
  for (const relativePath of scenario.allowlist) {
    const srcPath = join(scenario.fixturePath, relativePath);
    const destPath = join(snapshotDest, relativePath);
    if (!existsSync(srcPath)) {
      missingEntries.push(relativePath);
      continue;
    }
    const srcStat = await stat(srcPath);
    if (srcStat.isFile()) {
      await mkdir(join(destPath, ".."), { recursive: true });
      await writeFile(destPath, await readFile(srcPath));
    } else if (srcStat.isDirectory()) {
      await copyDirectoryRecursive(srcPath, destPath);
    } else {
      missingEntries.push(`${relativePath} (unsupported file type)`);
    }
  }
  if (missingEntries.length > 0) {
    throw new Error(
      `Allowlisted entries missing from fixture "${scenario.scenario}": ${missingEntries.join(", ")}.`,
    );
  }

  if (scenario.allowlist.includes("sandbox-wrappers")) {
    const srcDir = join(snapshotDest, "sandbox-wrappers");
    const destDir = join(snapshotDest, "node_modules", ".bin");
    if (!existsSync(srcDir)) {
      throw new Error(
        `sandbox-wrappers/ directory missing in snapshot for "${scenario.scenario}".`,
      );
    }
    await mkdir(destDir, { recursive: true });
    for (const entry of await readdir(srcDir)) {
      await writeFile(
        join(destDir, entry),
        await readFile(join(srcDir, entry)),
        {
          mode: 0o755,
        },
      );
    }
    await rm(srcDir, { recursive: true, force: true });
  }
  return snapshotDest;
}

/** Every file under the provisioned snapshot must be allowlist-derived. */
async function assertProvisionedCleanliness(
  snapshotDest: string,
  scenario: Batch52Scenario,
): Promise<void> {
  const allowedFiles = new Set<string>();
  for (const entry of scenario.allowlist) {
    if (entry === "sandbox-wrappers") {
      for (const wrapper of await readdir(
        join(scenario.fixturePath, "sandbox-wrappers"),
      )) {
        allowedFiles.add(`node_modules/.bin/${wrapper}`);
      }
      continue;
    }
    allowedFiles.add(entry);
  }
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.push(relative(snapshotDest, full).split(sep).join("/"));
      }
    }
  }
  await walk(snapshotDest);
  for (const file of found) {
    expect(
      allowedFiles.has(file),
      `unexpected file in provisioned snapshot: ${file}`,
    ).toBe(true);
  }
  expect(found.length).toBeGreaterThan(0);
  // No host-installation markers, ever.
  for (const file of found) {
    const lower = file.toLowerCase();
    expect(lower.endsWith("package-lock.json")).toBe(false);
    expect(lower.endsWith("yarn.lock")).toBe(false);
    expect(lower.endsWith("pnpm-lock.yaml")).toBe(false);
  }
}

/** Flat file map for in-memory detection, from the same allowlist. */
async function readFixtureSourceContents(
  scenario: Batch52Scenario,
): Promise<SourceContents> {
  const contents: Record<string, string> = {};
  for (const entry of scenario.allowlist) {
    if (entry === "sandbox-wrappers") continue;
    const full = join(scenario.fixturePath, entry);
    contents[entry.split(sep).join("/")] = await readFile(full, "utf8");
  }
  return contents;
}

// ---------------------------------------------------------------------------
// Real service composition — the actual Batch 51 service, real transport
// ---------------------------------------------------------------------------

interface RealBatch52Service {
  readonly service: ReturnType<typeof createGitHubVerificationService>;
  readonly transport: SubprocessSandboxTransport;
  readonly applicationService: VerificationApplicationService;
}

function createRealSandboxTransport(
  executable = process.env.VERIFY_SANDBOX_PROCESS,
  environment: Record<string, string> = {
    VERIFY_SANDBOX_SNAPSHOT_ROOT: process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!,
    VERIFY_SANDBOX_DOCKER_EXECUTABLE:
      process.env.VERIFY_SANDBOX_DOCKER_EXECUTABLE!,
    VERIFY_SANDBOX_DOCKER_HOST: process.env.VERIFY_SANDBOX_DOCKER_HOST!,
    VERIFY_SANDBOX_SYSTEM_ROOT: process.env.VERIFY_SANDBOX_SYSTEM_ROOT!,
    VERIFY_SANDBOX_TEMP_ROOT: process.env.VERIFY_SANDBOX_TEMP_ROOT!,
  },
): SubprocessSandboxTransport {
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("VERIFY_SANDBOX_PROCESS must be configured");
  }
  return new SubprocessSandboxTransport({
    executable,
    environment,
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 120_000,
    maxMessageBytes: 1024 * 1024,
    maxStderrBytes: 64 * 1024,
  });
}

async function createRealBatch52Service(
  scenarios: readonly Batch52Scenario[] = SCENARIOS,
  transport: SubprocessSandboxTransport = createRealSandboxTransport(),
): Promise<RealBatch52Service> {
  const provider = createInMemoryGitHubSourceProvider(
    await Promise.all(
      scenarios.map(async (scenario) => {
        const base = createGitHubRepositorySnapshot({
          kind: "github-snapshot" as const,
          owner: OWNER,
          repository: REPOSITORY,
          sha: scenario.headSha,
        });
        // The sandbox resolves the opaque snapshot identity against its
        // configured store, so sourceState carries the provisioned store
        // id while the snapshot id preserves owner/repo/SHA provenance.
        const snapshot: RepositorySnapshot = {
          ...base,
          sourceState: {
            type: "snapshot",
            value: snapshotStoreId(scenario.scenario),
          },
        };
        return {
          reference: {
            kind: "github-snapshot" as const,
            owner: OWNER,
            repository: REPOSITORY,
            sha: scenario.headSha,
          },
          snapshot,
          sourceContents: await readFixtureSourceContents(scenario),
        };
      }),
    ),
  );
  const applicationService = new VerificationApplicationService(
    createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    }),
    createGitHubSourceResolver(provider),
  );
  let counter = 0;
  const service = createGitHubVerificationService({
    applicationService,
    secret: SECRET,
    internalResultToken: INTERNAL_RESULT_TOKEN,
    createJobId: () => `job-batch52-${(counter += 1)}`,
    now: () => CREATED_AT,
  });
  return { service, transport, applicationService };
}

function serverPort(
  service: ReturnType<typeof createGitHubVerificationService>,
): number {
  const address = service.server.address();
  if (!address || typeof address === "string") {
    throw new Error("composed service did not bind a port");
  }
  return address.port;
}

function makePayload(action: string, sha: string): string {
  return JSON.stringify({
    action,
    repository: { owner: { login: OWNER }, name: REPOSITORY },
    pull_request: {
      number: PR_NUMBER,
      base: { sha: "b".repeat(40) },
      head: { sha },
    },
  });
}

function signPayload(payload: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`;
}

function postWebhook(
  port: number,
  payload: string,
  signature: string,
  delivery: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "POST",
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signature,
          "x-github-event": "pull_request",
          "x-github-delivery": delivery,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", reject);
    outbound.end(payload);
  });
}

function httpGetResult(
  port: number,
  queueJobId: string,
  auth: string | null | undefined = VALID_AUTH,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (auth !== null && auth !== undefined) {
      headers.authorization = auth;
    }
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "GET",
        path: `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
        headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", reject);
    outbound.end();
  });
}

async function postRealWebhook(
  port: number,
  scenario: Batch52Scenario,
  delivery: string,
): Promise<string> {
  const payload = makePayload("opened", scenario.headSha);
  const response = await postWebhook(
    port,
    payload,
    signPayload(payload),
    delivery,
  );
  expect(response.status).toBe(202);
  const queueJobId = (JSON.parse(response.body) as { queueJobId: string })
    .queueJobId;
  expect(typeof queueJobId).toBe("string");
  return queueJobId;
}

interface RealResultBody {
  readonly queueJobId: string;
  readonly verificationId: string;
  readonly jobId: string;
  readonly snapshotId: string;
  readonly status: string;
  readonly coverage: {
    readonly verified: readonly string[];
    readonly partial: readonly string[];
    readonly unsupported: readonly string[];
    readonly notApplicable: readonly string[];
  };
  readonly findings: readonly unknown[];
  readonly evidenceReferences: readonly unknown[];
  readonly contentHash: string;
  readonly resultVersion: string;
}

async function fetchRealResult(
  port: number,
  queueJobId: string,
): Promise<RealResultBody> {
  const fetched = await httpGetResult(port, queueJobId);
  expect(fetched.status).toBe(200);
  return JSON.parse(fetched.body) as RealResultBody;
}

/**
 * External-sandbox provenance: the transport is literally the
 * subprocess boundary (never a fake, never a host harness), its
 * execution source is real, and it is configured with the
 * operator-gated external process — never node, never a working
 * directory surrogate.
 */
function expectExternalSandboxProvenance(
  transport: SubprocessSandboxTransport,
): void {
  expect(transport).toBeInstanceOf(SubprocessSandboxTransport);
  expect(transport.executionSource).toBe("real");
  expect(process.env.VERIFY_SANDBOX_PROCESS).toBeTruthy();
  expect(process.env.VERIFY_SANDBOX_PROCESS).not.toContain("node");
  expect(process.env.VERIFY_SANDBOX_IDENTITY).toBe(EXPECTED_SANDBOX_IDENTITY);
}

// ---------------------------------------------------------------------------
// Host tests — always run, never touch the external sandbox
// ---------------------------------------------------------------------------

describe("Batch 52 — real-service sandbox configuration", () => {
  it("gate reports availability honestly with a clear reason", () => {
    if (sandboxAvailable) {
      expect(skipReason).toBeUndefined();
      expect(process.env.VERIFY_SANDBOX_IDENTITY).toBe(
        EXPECTED_SANDBOX_IDENTITY,
      );
    } else {
      expect(typeof skipReason).toBe("string");
      expect(skipReason as string).toContain("SKIPPED");
    }
  });

  it("invalid sandbox configuration fails closed with no host fallback", async () => {
    // Well-formed but bogus operator configuration: construction
    // succeeds, and the failure surfaces deterministically at spawn
    // time through the real transport boundary (fail closed). This file
    // never instantiates FakeSandboxTransport or any host harness.
    const transport = createRealSandboxTransport(
      "C:\\nonexistent\\verify-sandbox-process-missing.exe",
      {
        VERIFY_SANDBOX_SNAPSHOT_ROOT: "C:\\nonexistent\\snapshots",
        VERIFY_SANDBOX_DOCKER_EXECUTABLE: "C:\\nonexistent\\docker.exe",
        VERIFY_SANDBOX_DOCKER_HOST: "npipe:////./pipe/docker_engine",
        VERIFY_SANDBOX_SYSTEM_ROOT: "C:\\Windows",
        VERIFY_SANDBOX_TEMP_ROOT: "C:\\nonexistent\\temp",
      },
    );
    expect(transport).toBeInstanceOf(SubprocessSandboxTransport);
    expect(transport.constructor.name).toBe("SubprocessSandboxTransport");
    expect(transport.executionSource).toBe("real");
    const { service } = await createRealBatch52Service(
      [SCENARIOS[0]!],
      transport,
    );
    const verifySource = vi.spyOn(
      (service as { applicationService: VerificationApplicationService })
        .applicationService,
      "verifySource",
    );
    await service.start(0, "127.0.0.1");
    try {
      const port = serverPort(service);
      const payload = makePayload("opened", SCENARIOS[0]!.headSha);
      const response = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b52-invalid-config",
      );
      // The webhook trust boundary still enqueues; failure surfaces at
      // execution time, never as a fake success.
      expect(response.status).toBe(202);
      const queueJobId = (JSON.parse(response.body) as { queueJobId: string })
        .queueJobId;
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 30_000,
      });
      expect(verifySource).toHaveBeenCalledTimes(1);
      if (outcome.kind === "completed") {
        // A transport failure recorded as an error result: never a
        // successful sandbox execution claim.
        const fetched = await httpGetResult(port, queueJobId);
        expect(fetched.status).toBe(200);
        const body = JSON.parse(fetched.body) as RealResultBody;
        expect(body.status).not.toBe("pass");
        expect(body.coverage.verified).toHaveLength(0);
      } else {
        // A processor-level failure registers nothing successful.
        expect(outcome.kind).toBe("failed");
        const fetched = await httpGetResult(port, queueJobId);
        expect(fetched.status).toBe(404);
      }
      // The runtime remains usable: a second job settles the same way.
      const payload2 = makePayload("opened", SCENARIOS[0]!.headSha);
      const response2 = await postWebhook(
        port,
        payload2,
        signPayload(payload2),
        "delivery-b52-invalid-config-2",
      );
      expect(response2.status).toBe(202);
      const queueJobId2 = (JSON.parse(response2.body) as { queueJobId: string })
        .queueJobId;
      const outcome2 = await service.waitForQueueJob(queueJobId2, {
        timeoutMs: 30_000,
      });
      expect(["completed", "failed"] as const).toContain(outcome2.kind);
      expect(verifySource).toHaveBeenCalledTimes(2);
    } finally {
      await service.stop();
    }
    expect(service.runtime.isAutoProcessing()).toBe(false);
  });

  it("snapshot provisioning installs no host dependencies", async () => {
    const staging = await mkdtemp(join(tmpdir(), "verify-agent-batch52-"));
    tempRoots.push(staging);
    for (const scenario of SCENARIOS) {
      const dest = await provisionCleanSnapshot(scenario, staging);
      await assertProvisionedCleanliness(dest, scenario);
    }
  });
});

// ---------------------------------------------------------------------------
// Real E2E — gated on the external verify-sandbox process
// ---------------------------------------------------------------------------

describe("Batch 52 — runnable service through the real sandbox", () => {
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "healthy: webhook → service → real sandbox checks → verified result"
      : (skipReason as string),
    async () => {
      const scenario = SCENARIOS[0]!;
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const dest = await provisionCleanSnapshot(scenario, snapshotRoot);
      tempRoots.push(dest);
      await assertProvisionedCleanliness(dest, scenario);

      const { service, transport } = await createRealBatch52Service([scenario]);
      expectExternalSandboxProvenance(transport);
      await service.start(0, "127.0.0.1");
      try {
        const port = serverPort(service);
        const queueJobId = await postRealWebhook(
          port,
          scenario,
          "delivery-b52-healthy",
        );
        const outcome = await service.waitForQueueJob(queueJobId, {
          timeoutMs: 170_000,
        });
        expect(outcome.kind).toBe("completed");

        const body = await fetchRealResult(port, queueJobId);
        expect(body.queueJobId).toBe(queueJobId);
        expect(body.snapshotId).toBe(expectedSnapshotId(scenario.headSha));
        expect(body.snapshotId).toContain(scenario.headSha);
        expect(body.verificationId).not.toBe(queueJobId);
        expect(body.jobId).not.toBe(queueJobId);
        // Batch 53 all-applicable selection: the healthy fixture exposes a
        // tsconfig + vitest signal, so both typecheck and test execute for
        // real; checks without an executable spec are never selected, so
        // the honest status remains partial rather than pass.
        expect(body.status).not.toBe("blocked");
        expect(body.coverage.verified).toContain("typescript.typecheck");
        expect(body.coverage.verified).toContain("typescript.test");
        expect(body.coverage.verified).not.toContain("dependency.audit");
        expect(body.findings).toHaveLength(0);
        expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(body.resultVersion).toBe("1.0.0");
        expect(JSON.stringify(body)).not.toContain(SECRET);

        // Service lifecycle: stop detaches everything, then proves it.
        await service.stop();
        expect(service.isStarted()).toBe(false);
        expect(service.runtime.isRunning()).toBe(false);
        expect(service.runtime.isAutoProcessing()).toBe(false);
        expect(service.server.listening).toBe(false);
        await service.queue.enqueue(
          createVerificationQueueJob({
            jobId: "job-batch52-after-stop",
            source: {
              kind: "snapshot",
              id: `${OWNER}:${REPOSITORY}:${scenario.headSha}`,
            },
            trigger: {
              kind: "pull-request",
              action: "opened",
              pullRequestNumber: PR_NUMBER,
            },
            deliveryId: "delivery-b52-after-stop",
            createdAt: CREATED_AT,
          }),
        );
        await expect(
          service.waitForQueueJob("job-batch52-after-stop", {
            timeoutMs: 300,
          }),
        ).rejects.toThrow(/timed out/);
        expect(
          service.registry.getByQueueJobId("job-batch52-after-stop"),
        ).toBeUndefined();
      } finally {
        await service.stop();
        await rm(dest, { recursive: true, force: true }).catch(() => {});
      }
    },
    180_000,
  );

  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "failing-test: all-applicable selection executes typecheck and the failing test"
      : (skipReason as string),
    async () => {
      // Batch 53: the webhook job carries `selection: "all-applicable"`,
      // so the fixture's applicable executable checks (typecheck + test)
      // both execute for real. The typecheck passes, the test fails, and
      // the deterministic policy blocks the verification.
      const scenario = SCENARIOS[1]!;
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const dest = await provisionCleanSnapshot(scenario, snapshotRoot);
      tempRoots.push(dest);

      const { service, transport } = await createRealBatch52Service([scenario]);
      expectExternalSandboxProvenance(transport);
      await service.start(0, "127.0.0.1");
      try {
        const port = serverPort(service);
        const queueJobId = await postRealWebhook(
          port,
          scenario,
          "delivery-b52-failing-test",
        );
        const outcome = await service.waitForQueueJob(queueJobId, {
          timeoutMs: 170_000,
        });
        expect(outcome.kind).toBe("completed");

        const body = await fetchRealResult(port, queueJobId);
        expect(body.snapshotId).toBe(expectedSnapshotId(scenario.headSha));
        // The genuinely executed test failed in the sandbox, so the
        // deterministic policy blocks the verification.
        expect(body.status).toBe("blocked");
        expect(body.coverage.verified).toContain("typescript.typecheck");
        expect(body.coverage.verified).not.toContain("typescript.test");
        expect(body.findings.length).toBeGreaterThanOrEqual(1);
      } finally {
        await service.stop();
        await rm(dest, { recursive: true, force: true }).catch(() => {});
      }
    },
    180_000,
  );

  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "failing-typecheck: real typecheck failure blocks through the service"
      : (skipReason as string),
    async () => {
      const scenario = SCENARIOS[2]!;
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const dest = await provisionCleanSnapshot(scenario, snapshotRoot);
      tempRoots.push(dest);

      const { service, transport } = await createRealBatch52Service([scenario]);
      expectExternalSandboxProvenance(transport);
      await service.start(0, "127.0.0.1");
      try {
        const port = serverPort(service);
        const queueJobId = await postRealWebhook(
          port,
          scenario,
          "delivery-b52-failing-typecheck",
        );
        const outcome = await service.waitForQueueJob(queueJobId, {
          timeoutMs: 170_000,
        });
        expect(outcome.kind).toBe("completed");

        const body = await fetchRealResult(port, queueJobId);
        expect(body.snapshotId).toBe(expectedSnapshotId(scenario.headSha));
        // The genuinely executed typecheck failed in the sandbox, so the
        // deterministic policy blocks the verification.
        expect(body.status).toBe("blocked");
        expect(body.coverage.verified).not.toContain("typescript.typecheck");
        expect(body.findings.length).toBeGreaterThanOrEqual(1);
        expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await service.stop();
        await rm(dest, { recursive: true, force: true }).catch(() => {});
      }
    },
    180_000,
  );

  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "failing-build: all-applicable selection executes typecheck and the failing build"
      : (skipReason as string),
    async () => {
      // Batch 53: the webhook job carries `selection: "all-applicable"`,
      // so the fixture's applicable executable checks (typecheck + build,
      // dependency-ordered) both execute for real. The fixture is a
      // build-only failure by design: typecheck passes, the build fails,
      // and the deterministic policy blocks the verification.
      const scenario = SCENARIOS[3]!;
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const dest = await provisionCleanSnapshot(scenario, snapshotRoot);
      tempRoots.push(dest);

      const { service, transport } = await createRealBatch52Service([scenario]);
      expectExternalSandboxProvenance(transport);
      await service.start(0, "127.0.0.1");
      try {
        const port = serverPort(service);
        const queueJobId = await postRealWebhook(
          port,
          scenario,
          "delivery-b52-failing-build",
        );
        const outcome = await service.waitForQueueJob(queueJobId, {
          timeoutMs: 170_000,
        });
        expect(outcome.kind).toBe("completed");

        const body = await fetchRealResult(port, queueJobId);
        expect(body.snapshotId).toBe(expectedSnapshotId(scenario.headSha));
        // The genuinely executed build failed in the sandbox, so the
        // deterministic policy blocks the verification.
        expect(body.status).toBe("blocked");
        expect(body.coverage.verified).toContain("typescript.typecheck");
        expect(body.coverage.verified).not.toContain("typescript.build");
        expect(body.findings.length).toBeGreaterThanOrEqual(1);
      } finally {
        await service.stop();
        await rm(dest, { recursive: true, force: true }).catch(() => {});
      }
    },
    180_000,
  );
});
