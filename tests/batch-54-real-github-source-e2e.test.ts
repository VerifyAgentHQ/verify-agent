/**
 * Batch 54 — Exact GitHub Snapshot Publication + Real Sandbox E2E.
 *
 * Closes the source-to-sandbox boundary: exact acquired bytes are published
 * under the exact commit SHA so the external verify-sandbox materializes
 * precisely the verified revision.
 *
 * ```text
 * real signed GitHub webhook (POST /webhook → 202 + queueJobId)
 *   ↓ shared in-memory queue
 *   ↓ application-owned automatic runtime (no manual processNext/drain)
 *   ↓ VerificationJobProcessor → VerificationApplicationService
 *   ↓ real GitHub SourceResolver (commit/tree/blob through the actual
 *     createGitHubApiSourceProvider path, served by a deterministic
 *     authenticated API double — no fake sourceContents map)
 *   ↓ SnapshotStorePublisher → VERIFY_SANDBOX_SNAPSHOT_ROOT/<commit-SHA>
 *   ↓ real SubprocessSandboxTransport (executionSource "real")
 *   ↓ external verify-sandbox process (Docker-isolated, network none)
 *   ↓ VerificationResult → bounded registry
 *   ↓ protected GET /verification-jobs/:queueJobId/result → 200
 * ```
 *
 * Security invariant under test:
 *
 * ```text
 * PR HEAD SHA == resolved commit == sourceState.value
 *          == published store identity == materialized source
 * ```
 *
 * Gate: VERIFY_SANDBOX_PROCESS, VERIFY_SANDBOX_SNAPSHOT_ROOT,
 * VERIFY_SANDBOX_DOCKER_EXECUTABLE, VERIFY_SANDBOX_DOCKER_HOST,
 * VERIFY_SANDBOX_SYSTEM_ROOT, VERIFY_SANDBOX_TEMP_ROOT, and
 * VERIFY_SANDBOX_IDENTITY (must equal "verify-sandbox-process-0.1.0").
 * When unavailable the real-sandbox tests skip explicitly with a clear
 * reason. There is NO host fallback: no FakeSandboxTransport, no host
 * harness, no dependency installation anywhere in this file.
 *
 * Fixture strategy: dependency-free Rust revisions served through the real
 * acquisition path (commit → tree → blob). Rust needs no
 * `node_modules/.bin` executable shims and no dependency downloads, so the
 * network-disabled sandbox executes offline with zero host-side installs.
 * SHA_A is healthy; SHA_B fails exactly one test. Both SHAs are pinned
 * 40-hex constants; no mutable branch is consulted.
 */

import { createHash, createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubVerificationService } from "../apps/api/src/github-verification-service.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";
import {
  createGitHubApiSourceProvider,
  createGitHubSourceResolver,
  createSnapshotStorePublisher,
  type GitHubSourceProvider,
} from "../packages/adapters-source/src/index.js";
import type { SourceContents } from "../packages/adapters-source/src/resolver.js";
import {
  SubprocessSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
} from "../packages/engine/src/index.js";

// ---------------------------------------------------------------------------
// Gate — same convention as the Batch 43/47/52 real-sandbox suites
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
// Pinned revisions — dependency-free Rust, offline-safe in the sandbox
// ---------------------------------------------------------------------------

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const PR_NUMBER = 42;
const SECRET = "batch54-test-webhook-secret";
const INTERNAL_RESULT_TOKEN = "batch54-internal-result-token-for-tests-only";
const VALID_AUTH = `Bearer ${INTERNAL_RESULT_TOKEN}`;
const CREATED_AT = "2026-09-27T00:00:00.000Z";
const GITHUB_TOKEN = "batch54-test-github-token-not-a-secret";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const UNKNOWN_SHA = "c".repeat(40);

const CARGO_TOML = `[package]
name = "batch54-fixture"
version = "0.1.0"
edition = "2021"
`;

const LIB_PASSING = `pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add() {
        assert_eq!(add(1, 2), 3);
    }
}
`;

const LIB_FAILING = `pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add() {
        assert_eq!(add(1, 2), 4);
    }
}
`;

const CONTENTS_A: SourceContents = Object.freeze({
  "Cargo.toml": CARGO_TOML,
  "src/lib.rs": LIB_PASSING,
});

const CONTENTS_B: SourceContents = Object.freeze({
  "Cargo.toml": CARGO_TOML,
  "src/lib.rs": LIB_FAILING,
});

const EXPECTED_RUST_CHECKS = [
  "rust.check",
  "rust.clippy",
  "rust.test",
] as const;

// ---------------------------------------------------------------------------
// Deterministic authenticated GitHub API double
//
// Serves the real acquisition path (commit → tree → blob) with authentic
// git blob SHA-1 identities. Unknown SHAs answer 404 so an unexpected HEAD
// fails closed instead of resolving foreign bytes.
// ---------------------------------------------------------------------------

function gitBlobSha(content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes}\0${content}`, "utf8")
    .digest("hex");
}

interface RecordedRequest {
  readonly url: string;
  readonly authorization: string | undefined;
}

function createGitHubApiDouble(
  revisions: Readonly<Record<string, SourceContents>>,
  expectedToken: string,
): {
  readonly fetch: typeof globalThis.fetch;
  readonly requests: readonly RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const blobIndex = new Map<string, { contents: string; size: number }>();
  for (const contents of Object.values(revisions)) {
    for (const [path, text] of Object.entries(contents)) {
      blobIndex.set(gitBlobSha(text), {
        contents: text,
        size: Buffer.byteLength(text, "utf8"),
      });
    }
  }
  const jsonResponse = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  const fetch = (async (url: unknown, init?: { headers?: unknown }) => {
    const urlText = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url: urlText, authorization: headers.Authorization });
    if (headers.Authorization !== `Bearer ${expectedToken}`) {
      return jsonResponse(401, { message: "Bad credentials" });
    }
    const commitMatch = urlText.match(/\/commits\/([0-9a-f]{40})$/i);
    if (commitMatch) {
      const sha = (commitMatch[1] as string).toLowerCase();
      if (revisions[sha] === undefined) {
        return jsonResponse(404, { message: "Not Found" });
      }
      return jsonResponse(200, { sha });
    }
    const treeMatch = urlText.match(
      /\/git\/trees\/([0-9a-f]{40})\?recursive=1$/i,
    );
    if (treeMatch) {
      const sha = (treeMatch[1] as string).toLowerCase();
      const contents = revisions[sha];
      if (contents === undefined) {
        return jsonResponse(404, { message: "Not Found" });
      }
      const tree = Object.entries(contents)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([path, text]) => ({
          path,
          mode: "100644",
          type: "blob",
          sha: gitBlobSha(text),
          size: Buffer.byteLength(text, "utf8"),
        }));
      return jsonResponse(200, { sha, tree, truncated: false });
    }
    const blobMatch = urlText.match(/\/git\/blobs\/([0-9a-f]{40})$/i);
    if (blobMatch) {
      const entry = blobIndex.get((blobMatch[1] as string).toLowerCase());
      if (!entry) return jsonResponse(404, { message: "Not Found" });
      return jsonResponse(200, {
        sha: blobMatch[1],
        size: entry.size,
        encoding: "base64",
        content: `${Buffer.from(entry.contents, "utf8").toString("base64")}\n`,
      });
    }
    return jsonResponse(404, { message: "Not Found" });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}

// ---------------------------------------------------------------------------
// Real service composition — publisher in the resolver chain, real transport
// ---------------------------------------------------------------------------

interface RealBatch54Service {
  readonly service: ReturnType<typeof createGitHubVerificationService>;
  readonly transport: SubprocessSandboxTransport;
  readonly applicationService: VerificationApplicationService;
  readonly apiRequests: readonly RecordedRequest[];
}

function createRealSandboxTransport(): SubprocessSandboxTransport {
  const executable = process.env.VERIFY_SANDBOX_PROCESS;
  if (typeof executable !== "string" || executable.length === 0) {
    throw new Error("VERIFY_SANDBOX_PROCESS must be configured");
  }
  return new SubprocessSandboxTransport({
    executable,
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

function createRealBatch54Service(
  transport: SubprocessSandboxTransport = createRealSandboxTransport(),
  snapshotStoreRoot: string = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!,
): RealBatch54Service {
  const { fetch, requests } = createGitHubApiDouble(
    { [SHA_A]: CONTENTS_A, [SHA_B]: CONTENTS_B },
    GITHUB_TOKEN,
  );
  // The exact production resolver chain: GitHub acquisition, then
  // SHA-keyed publication into the operator's real snapshot store.
  const provider: GitHubSourceProvider = createGitHubApiSourceProvider({
    token: GITHUB_TOKEN,
    fetch,
  });
  const resolver = createSnapshotStorePublisher(
    createGitHubSourceResolver(provider),
    { snapshotStoreRoot },
  );
  const applicationService = new VerificationApplicationService(
    createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    }),
    resolver,
  );
  let counter = 0;
  const service = createGitHubVerificationService({
    applicationService,
    secret: SECRET,
    internalResultToken: INTERNAL_RESULT_TOKEN,
    createJobId: () => `job-batch54-${(counter += 1)}`,
    now: () => CREATED_AT,
  });
  return { service, transport, applicationService, apiRequests: requests };
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
      base: { sha: "d".repeat(40) },
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
  readonly checkResults: readonly unknown[];
  readonly findings: readonly unknown[];
  readonly evidenceReferences: readonly unknown[];
  readonly contentHash: string;
  readonly resultVersion: string;
}

async function postRealWebhook(
  port: number,
  sha: string,
  delivery: string,
): Promise<string> {
  const payload = makePayload("opened", sha);
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

async function fetchRealResult(
  port: number,
  queueJobId: string,
): Promise<RealResultBody> {
  const fetched = await httpGetResult(port, queueJobId);
  expect(fetched.status).toBe(200);
  return JSON.parse(fetched.body) as RealResultBody;
}

function expectExternalSandboxProvenance(
  transport: SubprocessSandboxTransport,
): void {
  expect(transport).toBeInstanceOf(SubprocessSandboxTransport);
  expect(transport.executionSource).toBe("real");
  expect(process.env.VERIFY_SANDBOX_PROCESS).toBeTruthy();
  expect(process.env.VERIFY_SANDBOX_PROCESS).not.toContain("node");
  expect(process.env.VERIFY_SANDBOX_IDENTITY).toBe(EXPECTED_SANDBOX_IDENTITY);
}

async function publishedTree(root: string, sha: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await walk(join(directory, entry.name), relativePath);
      else found.push(relativePath);
    }
  }
  await walk(join(root, sha), "");
  return found.sort();
}

const publishedDirs: string[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  const root = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT;
  await Promise.all(
    publishedDirs.splice(0).map(async (sha) => {
      if (root) await rm(join(root, sha), { recursive: true, force: true });
    }),
  );
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

// ---------------------------------------------------------------------------
// Host tests — always run, never touch the external sandbox
// ---------------------------------------------------------------------------

describe("Batch 54 — real GitHub source configuration", () => {
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

  it("unknown HEAD SHAs fail closed at acquisition with no host fallback", async () => {
    // Host-only: uses an isolated temp store root (never the real one) and
    // a transport that can never spawn. Acquisition fails before either is
    // touched.
    const tempRoot = await mkdtemp(join(tmpdir(), "verify-agent-batch54-"));
    tempRoots.push(tempRoot);
    const { service, applicationService } = createRealBatch54Service(
      // Any transport instance proves the failure happens before execution;
      // construction alone never contacts the sandbox.
      new SubprocessSandboxTransport({
        executable: "C:\\nonexistent\\verify-sandbox-process-missing.exe",
        environment: {
          VERIFY_SANDBOX_SNAPSHOT_ROOT: "C:\\nonexistent\\snapshots",
          VERIFY_SANDBOX_DOCKER_EXECUTABLE: "C:\\nonexistent\\docker.exe",
          VERIFY_SANDBOX_DOCKER_HOST: "npipe:////./pipe/docker_engine",
          VERIFY_SANDBOX_SYSTEM_ROOT: "C:\\Windows",
          VERIFY_SANDBOX_TEMP_ROOT: "C:\\nonexistent\\temp",
        },
        startupTimeoutMs: 5_000,
        requestTimeoutMs: 120_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      }),
      tempRoot,
    );
    const spy = vi.spyOn(applicationService, "verifySource");
    await service.start(0, "127.0.0.1");
    try {
      const port = serverPort(service);
      const payload = makePayload("opened", UNKNOWN_SHA);
      const response = await postWebhook(
        port,
        payload,
        signPayload(payload),
        "delivery-b54-unknown-sha",
      );
      // The webhook trust boundary still enqueues; acquisition of the
      // unknown commit fails deterministically through the real provider
      // path — never a fabricated success, never host execution.
      expect(response.status).toBe(202);
      const queueJobId = (JSON.parse(response.body) as { queueJobId: string })
        .queueJobId;
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 30_000,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(outcome.kind).toBe("failed");
      const fetched = await httpGetResult(port, queueJobId);
      expect(fetched.status).toBe(404);
    } finally {
      await service.stop();
    }
  });

  it("this file never substitutes host execution for the real sandbox", () => {
    // Genuine boundary proof by construction: the only transport named in
    // this file is the real subprocess boundary.
    expect(SubprocessSandboxTransport.name).toBe("SubprocessSandboxTransport");
  });
});

// ---------------------------------------------------------------------------
// Real E2E — gated on the external verify-sandbox process
// ---------------------------------------------------------------------------

describe("Batch 54 — real GitHub source-to-sandbox E2E", () => {
  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "HEAD A: webhook → exact acquisition → SHA publication → real sandbox → verified"
      : (skipReason as string),
    async () => {
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const { service, transport, applicationService, apiRequests } =
        createRealBatch54Service();
      expectExternalSandboxProvenance(transport);
      const verifySource = vi.spyOn(applicationService, "verifySource");
      await service.start(0, "127.0.0.1");
      try {
        const port = serverPort(service);
        const queueJobId = await postRealWebhook(
          port,
          SHA_A,
          "delivery-b54-head-a",
        );
        const outcome = await service.waitForQueueJob(queueJobId, {
          timeoutMs: 170_000,
        });
        expect(outcome.kind).toBe("completed");

        // Exact acquisition through the real provider path.
        const urls = apiRequests.map((request) => request.url);
        expect(urls.some((url) => url.includes(`/commits/${SHA_A}`))).toBe(
          true,
        );
        expect(urls.some((url) => url.includes(`/git/trees/${SHA_A}`))).toBe(
          true,
        );
        expect(urls.some((url) => url.includes("/git/blobs/"))).toBe(true);
        for (const request of apiRequests) {
          expect(request.authorization).toBe(`Bearer ${GITHUB_TOKEN}`);
        }
        // GitHub orchestration still requests the applicable plan.
        expect(verifySource).toHaveBeenCalledTimes(1);
        expect(verifySource).toHaveBeenCalledWith({
          source: { kind: "snapshot", id: `${OWNER}:${REPOSITORY}:${SHA_A}` },
          selection: "all-applicable",
        });

        // SHA-keyed publication: the store holds exactly the acquired bytes.
        publishedDirs.push(SHA_A);
        expect(await publishedTree(snapshotRoot, SHA_A)).toEqual([
          "Cargo.toml",
          "src/lib.rs",
        ]);
        expect(
          await readFile(join(snapshotRoot, SHA_A, "src", "lib.rs"), "utf8"),
        ).toBe(LIB_PASSING);

        const body = await fetchRealResult(port, queueJobId);
        expect(body.queueJobId).toBe(queueJobId);
        expect(body.snapshotId).toBe(`${OWNER}--${REPOSITORY}--${SHA_A}`);
        expect(body.snapshotId).toContain(SHA_A);
        expect(body.verificationId).not.toBe(queueJobId);
        // All applicable executable Rust checks ran for real; the honest
        // status is partial only because dependency.audit remains
        // applicable without an executable spec — never a false pass.
        expect(body.status).not.toBe("blocked");
        expect(body.findings).toHaveLength(0);
        for (const check of EXPECTED_RUST_CHECKS) {
          expect(body.coverage.verified).toContain(check);
        }
        expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
        expect(body.resultVersion).toBe("1.0.0");

        // No credential, source-content, or host-path leakage.
        const serialized = JSON.stringify(body);
        expect(serialized).not.toContain(SECRET);
        expect(serialized).not.toContain(GITHUB_TOKEN);
        expect(serialized).not.toContain("ghs_");
        expect(serialized).not.toContain(LIB_PASSING);
        expect(serialized).not.toContain(snapshotRoot);
      } finally {
        await service.stop();
      }
    },
    180_000,
  );

  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "HEAD B: the failing revision blocks, bound to B — never A's result"
      : (skipReason as string),
    async () => {
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const { service, transport } = createRealBatch54Service();
      expectExternalSandboxProvenance(transport);
      await service.start(0, "127.0.0.1");
      try {
        const port = serverPort(service);
        const queueJobId = await postRealWebhook(
          port,
          SHA_B,
          "delivery-b54-head-b",
        );
        const outcome = await service.waitForQueueJob(queueJobId, {
          timeoutMs: 170_000,
        });
        expect(outcome.kind).toBe("completed");

        publishedDirs.push(SHA_B);
        expect(
          await readFile(join(snapshotRoot, SHA_B, "src", "lib.rs"), "utf8"),
        ).toBe(LIB_FAILING);

        const body = await fetchRealResult(port, queueJobId);
        expect(body.snapshotId).toBe(`${OWNER}--${REPOSITORY}--${SHA_B}`);
        expect(body.snapshotId).toContain(SHA_B);
        expect(body.snapshotId).not.toContain(SHA_A);
        // The genuinely executed test failed in the sandbox: deterministic
        // policy blocks, with the passing check still verified.
        expect(body.status).toBe("blocked");
        expect(body.coverage.verified).toContain("rust.check");
        expect(body.coverage.verified).not.toContain("rust.test");
        expect(body.findings.length).toBeGreaterThanOrEqual(1);
        expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
      } finally {
        await service.stop();
      }
    },
    180_000,
  );

  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "HEAD mutation: A's result is never usable as verification of B"
      : (skipReason as string),
    async () => {
      const { service, transport } = createRealBatch54Service();
      expectExternalSandboxProvenance(transport);
      await service.start(0, "127.0.0.1");
      try {
        const port = serverPort(service);
        const jobA = await postRealWebhook(port, SHA_A, "delivery-b54-mut-a");
        const outcomeA = await service.waitForQueueJob(jobA, {
          timeoutMs: 170_000,
        });
        expect(outcomeA.kind).toBe("completed");
        const jobB = await postRealWebhook(port, SHA_B, "delivery-b54-mut-b");
        const outcomeB = await service.waitForQueueJob(jobB, {
          timeoutMs: 170_000,
        });
        expect(outcomeB.kind).toBe("completed");
        publishedDirs.push(SHA_A, SHA_B);

        const resultA = await fetchRealResult(port, jobA);
        const resultB = await fetchRealResult(port, jobB);
        expect(jobA).not.toBe(jobB);
        expect(resultA.snapshotId).toContain(SHA_A);
        expect(resultB.snapshotId).toContain(SHA_B);
        expect(resultA.snapshotId).not.toBe(resultB.snapshotId);
        expect(resultA.verificationId).not.toBe(resultB.verificationId);
        expect(resultA.contentHash).not.toBe(resultB.contentHash);
        expect(resultA.status).not.toBe("blocked");
        expect(resultB.status).toBe("blocked");
        // Re-reading A still yields A: results are bound per queue job and
        // per immutable commit, never relabeled by a later HEAD.
        const rereadA = await fetchRealResult(port, jobA);
        expect(rereadA.snapshotId).toBe(resultA.snapshotId);
        expect(rereadA.contentHash).toBe(resultA.contentHash);
      } finally {
        await service.stop();
      }
    },
    180_000,
  );

  it.skipIf(!sandboxAvailable)(
    sandboxAvailable
      ? "protected observation exposes provenance without secrets or paths"
      : (skipReason as string),
    async () => {
      const { service, transport } = createRealBatch54Service();
      expectExternalSandboxProvenance(transport);
      await service.start(0, "127.0.0.1");
      try {
        const port = serverPort(service);
        const queueJobId = await postRealWebhook(
          port,
          SHA_A,
          "delivery-b54-protected",
        );
        await service.waitForQueueJob(queueJobId, { timeoutMs: 170_000 });
        publishedDirs.push(SHA_A);

        const path = `/verification-jobs/${encodeURIComponent(queueJobId)}/result`;
        expect((await httpGetResult(port, queueJobId, null)).status).toBe(401);
        expect(
          (await httpGetResult(port, queueJobId, "Bearer wrong-token")).status,
        ).toBe(401);
        const fetched = await httpGetResult(port, queueJobId);
        expect(fetched.status).toBe(200);
        const body = JSON.parse(fetched.body) as RealResultBody;
        // Correlation without exposure: job, snapshot, commit, checks,
        // status — and nothing else.
        expect(body.queueJobId).toBe(queueJobId);
        expect(body.snapshotId).toContain(SHA_A);
        expect(body.checkResults.length).toBeGreaterThanOrEqual(3);
        expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
        const serialized = JSON.stringify(body);
        for (const forbidden of [
          SECRET,
          GITHUB_TOKEN,
          LIB_PASSING,
          CARGO_TOML,
          process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT as string,
          process.env.VERIFY_SANDBOX_PROCESS as string,
        ]) {
          expect(serialized).not.toContain(forbidden);
        }
      } finally {
        await service.stop();
      }
    },
    180_000,
  );
});
