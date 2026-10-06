import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import type {
  VerificationResult,
  VerificationResultReader,
} from "@verify-agent/domain";
import { isValidVerificationQueueJobId } from "@verify-agent/domain";
import {
  DEFAULT_EXECUTION_LIMITS,
  ExecutionEnvironmentMaterializer,
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  SubprocessSandboxTransport,
  createVerificationPipeline,
  OfflineDependencyProvisioner,
  VerificationApplicationService,
  maxTrustedExecutionTimeoutMs,
} from "@verify-agent/engine";
import { createProjectDetectionService } from "@verify-agent/adapters-lang";
import {
  InvalidSourceReferenceError,
  type SourceResolver,
  createGitHubApiInstallationResolver,
  createGitHubApiSourceProvider,
  createGitHubAppInstallationTokenClient,
  createGitHubAppSourceProvider,
  createGitHubSourceResolver,
  createSnapshotStorePublisher,
  readGitHubAppConfig,
  readGitHubToken,
  readSnapshotStoreRoot,
  selectGitHubSourceAuthKind,
} from "@verify-agent/adapters-source";
import type {
  PublicAsyncVerificationResponse,
  PublicVerifyRequest,
  PublicVerificationResponse,
} from "./public-dto.js";
import { fileURLToPath } from "node:url";
import {
  createMvpVerificationApplicationService,
  type MvpVerificationApplicationService as VerificationApplicationServiceType,
} from "./mvp-application-service.js";

const MAX_BODY_BYTES = 1_048_576;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

export class ApiRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 415,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePublicRequest(value: unknown): PublicVerifyRequest {
  if (!isRecord(value)) {
    throw new ApiRequestError(400, "request body must be a JSON object");
  }
  if (
    !isRecord(value.source) ||
    value.source.kind !== "snapshot" ||
    typeof value.source.id !== "string"
  ) {
    throw new ApiRequestError(
      400,
      "source must be { kind: 'snapshot', id: string }",
    );
  }
  return value as unknown as PublicVerifyRequest;
}

function adaptResult(
  result: VerificationResult,
  source: PublicVerifyRequest["source"],
): PublicVerificationResponse {
  return {
    status: result.status,
    coverage: {
      verified: result.coverage.verified,
      partial: result.coverage.partial,
      unsupported: result.coverage.unsupported,
      notApplicable: result.coverage.notApplicable,
    },
    checkResults: result.checkResults,
    findings: result.findingReferences,
    evidenceReferences: result.evidenceReferences,
    policyDecision: result.policyDecision,
    summary: result.summary,
    resultVersion: result.resultVersion,
    contentHash: result.contentHash,
    createdAt: result.createdAt,
    source,
  };
}

/**
 * Batch 50 — queue-job ID validation reuses the single domain-level
 * contract (`isValidVerificationQueueJobId`). There is intentionally no
 * API-only maximum length: the API accepts every domain-valid ID.
 */
function isValidQueueJobId(value: string): boolean {
  return isValidVerificationQueueJobId(value);
}

/**
 * Batch 50 — explicitly protected internal result boundary.
 *
 * No reusable inbound API authentication exists (the only `Bearer` usages
 * in the repo are outbound GitHub client headers and webhook HMAC), so
 * the async result route uses a dedicated route-specific bearer token.
 *
 * - Enabled only when BOTH a result reader AND a non-empty token exist.
 * - `Authorization: Bearer <token>` with exact comparison (timing-safe).
 * - Query-string, path, queue-ID-as-credential, and custom headers are
 *   never accepted. The token is never echoed or logged.
 */
export function readInternalResultToken(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const raw = env.VERIFY_INTERNAL_RESULT_TOKEN;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  return raw.trim();
}

function normalizeConfiguredToken(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

function isResultRouteEnabled(
  resultReader: VerificationResultReader | null | undefined,
  internalResultToken: string | null | undefined,
): boolean {
  return (
    resultReader !== null &&
    resultReader !== undefined &&
    normalizeConfiguredToken(internalResultToken) !== null
  );
}

function isAuthorizedResultRequest(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  const header = request.headers["authorization"];
  if (typeof header !== "string") return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const candidate = header.slice(prefix.length);
  if (candidate.length === 0) return false;
  const expectedBuffer = Buffer.from(expectedToken, "utf8");
  const candidateBuffer = Buffer.from(candidate, "utf8");
  if (expectedBuffer.length !== candidateBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, candidateBuffer);
}

function parseQueueJobIdFromPath(url: string | undefined): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  const pathname = url.split("?")[0]?.split("#")[0] ?? "";
  const prefix = "/verification-jobs/";
  const suffix = "/result";
  if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix)) return null;
  const inner = pathname.slice(prefix.length, -suffix.length);
  // Exactly one non-empty path segment: reject extra slashes or traversal.
  if (inner.length === 0 || inner.includes("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(inner);
  } catch {
    return "";
  }
  return decoded;
}

function adaptAsyncResult(
  queueJobId: string,
  result: VerificationResult,
): PublicAsyncVerificationResponse {
  return {
    queueJobId,
    verificationId: String(result.id),
    jobId: String(result.jobId),
    snapshotId: String(result.snapshotId),
    status: result.status,
    coverage: {
      verified: result.coverage.verified,
      partial: result.coverage.partial,
      unsupported: result.coverage.unsupported,
      notApplicable: result.coverage.notApplicable,
    },
    checkResults: result.checkResults,
    findings: result.findingReferences,
    evidenceReferences: result.evidenceReferences,
    policyDecision: result.policyDecision,
    summary: result.summary,
    resultVersion: result.resultVersion,
    contentHash: result.contentHash,
    createdAt: result.createdAt,
  };
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(payload);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || !JSON_CONTENT_TYPE.test(contentType)) {
    throw new ApiRequestError(415, "Content-Type must be application/json");
  }
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new ApiRequestError(400, "request body exceeds 1 MiB"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new ApiRequestError(400, "request body is not valid JSON"));
      }
    });
    request.on("error", reject);
  });
}

export interface VerificationApi {
  readonly server: Server;
  readonly close: () => Promise<void>;
}

export interface VerificationApiOptions {
  readonly internalResultToken?: string | null;
}

/**
 * Batch 51 — reusable API request listener for single-process composition.
 *
 * Exposes the same `handleRequest` boundary used by `createVerificationApi`
 * so a composed service can multiplex webhook + API routes on one HTTP
 * server without duplicating the API boundary or creating a second server.
 */
export function createVerificationRequestListener(
  applicationService: Pick<VerificationApplicationServiceType, "verifySource">,
  resultReader?: VerificationResultReader | null,
  options: VerificationApiOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  const internalResultToken =
    normalizeConfiguredToken(options.internalResultToken) ?? null;
  return (request, response) => {
    void handleRequest(
      request,
      response,
      applicationService,
      resultReader,
      internalResultToken,
    );
  };
}

export function createVerificationApi(
  applicationService: Pick<VerificationApplicationServiceType, "verifySource">,
  resultReader?: VerificationResultReader | null,
  options: VerificationApiOptions = {},
): VerificationApi {
  const server = createServer(
    createVerificationRequestListener(
      applicationService,
      resultReader,
      options,
    ),
  );
  return {
    server,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export interface ApiServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly resultReader?: VerificationResultReader;
  readonly internalResultToken?: string;
}

export async function startApiServer(
  applicationService: Pick<VerificationApplicationServiceType, "verifySource">,
  options: ApiServerOptions = {},
): Promise<VerificationApi> {
  const api = createVerificationApi(
    applicationService,
    options.resultReader ?? null,
    options.internalResultToken === undefined
      ? {}
      : { internalResultToken: options.internalResultToken },
  );
  const port = options.port ?? readPort(process.env.PORT);
  const host = options.host ?? "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    api.server.once("error", reject);
    api.server.listen(port, host, () => {
      api.server.off("error", reject);
      resolve();
    });
  });
  return api;
}

function readPort(value: string | undefined): number {
  if (value === undefined || value === "") return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

/**
 * Batch 56C — sandbox/transport timeout relationship (Codex blocking
 * finding 1).
 *
 * The sandbox enforces `resourceLimits.timeoutMs` internally (Docker
 * `wait_with_deadline`), then needs time to kill the child, wait, clean up
 * the container, serialize the terminal `timed_out` result, and flush
 * stdout. The outer `SubprocessSandboxTransport` must therefore remain
 * alive longer than ANY trusted check-specific inner deadline; equal
 * timeouts let the outer `sandbox request timed out` mask the sandbox's
 * own `timed_out`.
 *
 * The inner execution timeouts are owned by the canonical trusted
 * execution-spec registry (`trustedExecutionSpecs`: default 120s,
 * `soroban.contract-test` 300s). The outer timeout is derived as
 * `maxTrustedExecutionTimeoutMs + cleanup margin`, so a future trusted
 * check with a larger timeout automatically stays covered. No duplicate
 * timeout constants: the default comes from `DEFAULT_EXECUTION_LIMITS`,
 * the maximum from the registry, and only the margin lives here.
 */
export const SANDBOX_TRANSPORT_CLEANUP_MARGIN_MS = 30_000;
/** Alias for the default inner deadline (single source: engine limits). */
export const SANDBOX_EXECUTION_TIMEOUT_MS = DEFAULT_EXECUTION_LIMITS.timeoutMs;
/** Canonical maximum trusted inner deadline (registry + default fallback). */
export const MAX_TRUSTED_EXECUTION_TIMEOUT_MS = maxTrustedExecutionTimeoutMs(
  DEFAULT_EXECUTION_LIMITS.timeoutMs,
);
/**
 * Canonical maximum `resourceLimits.timeoutMs` the external sandbox backend
 * accepts (verify-sandbox `MAX_TIMEOUT_MS = 60 * 60 * 1000`).
 */
export const MAX_BACKEND_SANDBOX_TIMEOUT_MS = 3_600_000;

/** Raised when a trusted timeout configuration cannot be honored. */
export class SandboxTimeoutConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTimeoutConfigurationError";
  }
}

/**
 * Batch 56C-R1 — derived-timeout invariant.
 *
 * ```text
 * maximum trusted execution timeout + cleanup margin <= backend maximum
 * ```
 *
 * The derivation is explicit and fail closed: a configuration whose derived
 * outer transport timeout would exceed the backend contract is rejected with a
 * clear internal configuration error. It is never silently capped, because a
 * silent cap could terminate a trusted check before its requested timeout.
 */
export function deriveSandboxTransportTimeoutMs(
  maxTrustedTimeoutMs: number,
  cleanupMarginMs: number,
  backendMaxTimeoutMs: number = MAX_BACKEND_SANDBOX_TIMEOUT_MS,
): number {
  const entries = [
    [maxTrustedTimeoutMs, "maximum trusted execution timeout"],
    [cleanupMarginMs, "cleanup margin"],
    [backendMaxTimeoutMs, "backend maximum timeout"],
  ] as const;
  for (const [value, name] of entries) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new SandboxTimeoutConfigurationError(
        `${name} must be a positive safe integer`,
      );
    }
  }
  const derived = maxTrustedTimeoutMs + cleanupMarginMs;
  if (!Number.isSafeInteger(derived)) {
    throw new SandboxTimeoutConfigurationError(
      "derived sandbox transport timeout is not a safe integer",
    );
  }
  if (derived > backendMaxTimeoutMs) {
    throw new SandboxTimeoutConfigurationError(
      `derived sandbox transport timeout ${derived}ms exceeds the backend maximum of ${backendMaxTimeoutMs}ms`,
    );
  }
  return derived;
}

export const SANDBOX_TRANSPORT_REQUEST_TIMEOUT_MS =
  deriveSandboxTransportTimeoutMs(
    MAX_TRUSTED_EXECUTION_TIMEOUT_MS,
    SANDBOX_TRANSPORT_CLEANUP_MARGIN_MS,
  );

export function createConfiguredApplicationService(
  env: NodeJS.ProcessEnv = process.env,
): VerificationApplicationServiceType {
  void env;
  return createMvpVerificationApplicationService();
}

function createLegacyConfiguredApplicationService(
  env: NodeJS.ProcessEnv = process.env,
): VerificationApplicationService {
  const executable = env.VERIFY_SANDBOX_PROCESS;
  if (!executable) {
    throw new Error("VERIFY_SANDBOX_PROCESS must be configured");
  }
  const transport = new SubprocessSandboxTransport({
    executable,
    environment: readSandboxProcessEnvironment(env),
    startupTimeoutMs: 5_000,
    requestTimeoutMs: SANDBOX_TRANSPORT_REQUEST_TIMEOUT_MS,
    maxMessageBytes: 1_048_576,
    maxStderrBytes: 64 * 1024,
  });
  const dependencyProvisioner = createConfiguredDependencyProvisioner(env);
  const pipeline = createVerificationPipeline({
    detector: createProjectDetectionService(),
    executor: createCheckExecutor(
      createSandboxExecutorFromTransport(transport),
    ),
    ...(dependencyProvisioner === undefined ? {} : { dependencyProvisioner }),
  });
  const sourceResolver = createConfiguredSourceResolver(env);
  // Batch 56C-R1 — production composition (Codex findings 1-3):
  //
  // ```text
  // GitHub PR → exact source SHA → immutable published source snapshot →
  // trusted artifact metadata (artifactContentHash) →
  // OfflineDependencyProvisioner → composition staging → validated →
  // atomically published composed snapshot
  // (<root>/<sourceState.value>-dep-<artifactContentHash>) →
  // SubprocessSandboxTransport → verify-sandbox → Docker
  // ```
  //
  // The composed snapshot is published atomically under its own opaque
  // identity (bound to the exact source identity and the exact dependency
  // artifact content), so the contract is unchanged (`snapshot` stays the
  // opaque identity, `artifactPolicy` stays `"none"`, `networkPolicy` stays
  // `"none"`) and the immutable source snapshot is never mutated. The
  // pipeline consumes the materialized environment and never provisions
  // again, so provisioning happens exactly once per verification. History is
  // preserved when either root is absent: no provisioner, no materializer, no
  // silent host `node_modules`, no silent install.
  const materialization = createConfiguredSnapshotMaterialization(
    env,
    dependencyProvisioner,
  );
  return materialization === undefined
    ? new VerificationApplicationService(pipeline, sourceResolver)
    : new VerificationApplicationService(
        pipeline,
        sourceResolver,
        materialization,
      );
}

/**
 * Batch 56C — snapshot-dependency materialization wiring.
 *
 * Requires BOTH operator roots: the dependency-artifact store
 * (`VERIFY_DEPENDENCY_ARTIFACT_ROOT`) and the sandbox snapshot store
 * (`VERIFY_SANDBOX_SNAPSHOT_ROOT`, same value forwarded to the sandbox
 * process). Returns `undefined` when either is absent so historical
 * behavior is preserved. The shared provisioner instance serves both the
 * pipeline (execution identity) and the materializer (workspace
 * composition); both invoke the copy-only provisioner, never a package
 * manager.
 */
export function createConfiguredSnapshotMaterialization(
  env: NodeJS.ProcessEnv = process.env,
  provisioner?: OfflineDependencyProvisioner,
):
  | {
      readonly snapshotStoreRoot: string;
      readonly dependencyArtifactRoot: string;
      readonly dependencyProvisioner: OfflineDependencyProvisioner;
      readonly materializer: ExecutionEnvironmentMaterializer;
    }
  | undefined {
  const artifactRoot = readDependencyArtifactRoot(env);
  const snapshotStoreRoot = readSnapshotStoreRoot(env);
  if (artifactRoot === undefined || snapshotStoreRoot === undefined) {
    return undefined;
  }
  const dependencyProvisioner =
    provisioner ?? createConfiguredDependencyProvisioner(env);
  if (dependencyProvisioner === undefined) return undefined;
  return {
    snapshotStoreRoot,
    dependencyArtifactRoot: artifactRoot,
    dependencyProvisioner,
    materializer: new ExecutionEnvironmentMaterializer({
      dependencyProvisioner,
    }),
  };
}

/**
 * Batch 56B — optional trusted dependency-artifact store.
 *
 * When `VERIFY_DEPENDENCY_ARTIFACT_ROOT` is set to an absolute directory,
 * the production pipeline is given the existing offline copy-only
 * provisioner (`OfflineDependencyProvisioner`) bound to the Linux amd64
 * runner platform. When unset, the historical behavior is preserved: the
 * pipeline has no provisioner and provisioning requests fail closed with
 * `dependency_provisioning_failed`.
 *
 * The trusted artifact itself is built separately with the existing
 * `PnpmDependencyArtifactBuilder` in a Linux amd64 environment
 * (Node 24.19.0, pnpm 11.21.0) via `pnpm install --frozen-lockfile
 * --ignore-scripts`. Runtime provisioning here never runs a package
 * manager, lifecycle hook, script, or network operation; it only copies
 * the prebuilt content-addressed artifact. See
 * `docs/VERIFICATION-PIPELINE.md` (Batch 11 boundary) and
 * `docs/decisions/0005-platform-bound-dependency-artifacts.md`.
 */
export function readDependencyArtifactRoot(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env.VERIFY_DEPENDENCY_ARTIFACT_ROOT;
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return raw.trim();
}

export function createConfiguredDependencyProvisioner(
  env: NodeJS.ProcessEnv = process.env,
): OfflineDependencyProvisioner | undefined {
  const root = readDependencyArtifactRoot(env);
  if (root === undefined) return undefined;
  // Batch 56C-R1 — production artifacts must carry a trusted content hash;
  // a directory that merely matches the expected artifact ID is not enough.
  return new OfflineDependencyProvisioner(
    root,
    {
      operatingSystem: "linux",
      architecture: "amd64",
    },
    { requireArtifactContentHash: true },
  );
}

/**
 * Batch 54 — minimal explicit environment for the external verify-sandbox
 * process. The transport never inherits the host environment; only these
 * established operator-configured keys are forwarded, and only when set.
 * No credentials (GitHub tokens, webhook secrets, result tokens) are ever
 * included: the sandbox materializes published snapshots and needs no
 * acquisition credentials.
 */
const SANDBOX_PROCESS_ENV_KEYS = [
  "VERIFY_SANDBOX_SNAPSHOT_ROOT",
  "VERIFY_SANDBOX_DOCKER_EXECUTABLE",
  "VERIFY_SANDBOX_DOCKER_HOST",
  "VERIFY_SANDBOX_SYSTEM_ROOT",
  "VERIFY_SANDBOX_TEMP_ROOT",
] as const;

export function readSandboxProcessEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const key of SANDBOX_PROCESS_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      forwarded[key] = value;
    }
  }
  return forwarded;
}

function createDefaultSourceResolver(): SourceResolver {
  return {
    async resolveSnapshot(source) {
      throw new InvalidSourceReferenceError(
        `source not resolvable: ${source.id}`,
      );
    },
  };
}

/**
 * Batch 54A — configured GitHub source authentication.
 *
 * - Complete GitHub App configuration → GitHub App provider (an ambient
 *   `GITHUB_TOKEN` never overrides it).
 * - Partial App configuration (exactly one of ID/key) → fail closed via
 *   the default resolver; never a silent token fallback.
 * - No App configuration → token provider only with the explicit
 *   `GITHUB_SOURCE_AUTH_MODE=token` opt-in plus a `GITHUB_TOKEN`;
 *   otherwise fail closed.
 *
 * Exported as a composition seam for focused configuration tests; normal
 * startup uses `createConfiguredApplicationService()`.
 */
export function createConfiguredSourceResolver(
  env: NodeJS.ProcessEnv = process.env,
): SourceResolver {
  const authKind = selectGitHubSourceAuthKind(env);
  let base: SourceResolver;
  if (authKind === "app") {
    const appConfig = readGitHubAppConfig(env);
    const apiBaseUrl =
      typeof env.GITHUB_API_BASE_URL === "string" &&
      env.GITHUB_API_BASE_URL.trim().length > 0
        ? env.GITHUB_API_BASE_URL.trim()
        : undefined;
    const installationResolver = createGitHubApiInstallationResolver({
      appConfig,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    });
    const installationTokenClient = createGitHubAppInstallationTokenClient({
      appConfig,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    });
    const provider = createGitHubAppSourceProvider({
      installationResolver,
      installationTokenClient,
      ...(apiBaseUrl ? { apiBaseUrl } : {}),
    });
    base = createGitHubSourceResolver(provider);
  } else if (authKind === "token") {
    const token = readGitHubToken(env);
    base =
      token === undefined
        ? createDefaultSourceResolver()
        : createGitHubSourceResolver(createGitHubApiSourceProvider({ token }));
  } else {
    base = createDefaultSourceResolver();
  }
  // Batch 54 — publish exact acquired bytes under the exact commit SHA so
  // the external sandbox materializes precisely the verified revision.
  // Without a configured store root the historical resolver behavior is
  // preserved unchanged.
  const snapshotStoreRoot = readSnapshotStoreRoot(env);
  return snapshotStoreRoot === undefined
    ? base
    : createSnapshotStorePublisher(base, { snapshotStoreRoot });
}

/**
 * Normal configured startup intentionally exposes NO async result
 * observation: no result reader is wired, so the
 * `GET /verification-jobs/:queueJobId/result` route is unavailable
 * (404 `route not found`) even if `VERIFY_INTERNAL_RESULT_TOKEN` happens
 * to be set. Async result observation is an explicitly protected
 * internal boundary available only through focused composition that
 * supplies BOTH a `VerificationResultReader` and an internal result
 * token via `createVerificationApi` / `startApiServer`. It is not a
 * general public production API.
 */
export async function startConfiguredApiServer(): Promise<VerificationApi> {
  return startApiServer(createConfiguredApplicationService());
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  applicationService: Pick<VerificationApplicationServiceType, "verifySource">,
  resultReader?: VerificationResultReader | null,
  internalResultToken?: string | null,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }
  const queueJobId = parseQueueJobIdFromPath(request.url);
  if (queueJobId !== null) {
    // Fail closed: without BOTH a reader and a token the route does not
    // exist (generic 404, indistinguishable from an unknown route).
    const expectedToken = normalizeConfiguredToken(internalResultToken);
    if (
      !isResultRouteEnabled(resultReader, expectedToken) ||
      expectedToken === null
    ) {
      sendJson(response, 404, {
        error: { code: "not_found", message: "route not found" },
      });
      return;
    }
    // Authenticate before method, validation, or existence checks so a
    // failure never becomes a result-existence oracle. Same generic 401
    // regardless of whether the queue job exists.
    if (!isAuthorizedResultRequest(request, expectedToken)) {
      sendJson(response, 401, {
        error: { code: "unauthorized", message: "unauthorized" },
      });
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("allow", "GET");
      sendJson(response, 405, {
        error: { code: "method_not_allowed", message: "method not allowed" },
      });
      return;
    }
    if (!isValidQueueJobId(queueJobId)) {
      sendJson(response, 400, {
        error: { code: "invalid_request", message: "invalid queue job id" },
      });
      return;
    }
    try {
      const stored = resultReader?.getByQueueJobId(queueJobId) ?? null;
      if (stored === null || stored === undefined) {
        sendJson(response, 404, {
          error: { code: "not_found", message: "no retained result" },
        });
        return;
      }
      sendJson(response, 200, adaptAsyncResult(queueJobId, stored));
    } catch {
      sendJson(response, 500, {
        error: { code: "internal_error", message: "verification failed" },
      });
    }
    return;
  }
  if (request.url !== "/verify") {
    sendJson(response, 404, {
      error: { code: "not_found", message: "route not found" },
    });
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    sendJson(response, 405, {
      error: { code: "method_not_allowed", message: "method not allowed" },
    });
    return;
  }
  try {
    const input = await readJson(request);
    const publicRequest = parsePublicRequest(input);
    const result = await applicationService.verifySource({
      source: publicRequest.source,
    });
    sendJson(response, 200, adaptResult(result, publicRequest.source));
  } catch (error) {
    if (error instanceof ApiRequestError) {
      sendJson(response, error.statusCode, {
        error: { code: "invalid_request", message: error.message },
      });
      return;
    }
    if (
      error instanceof InvalidSourceReferenceError ||
      (error instanceof Error && error.name === "InvalidSourceReferenceError")
    ) {
      sendJson(response, 400, {
        error: { code: "invalid_request", message: "invalid source reference" },
      });
      return;
    }
    sendJson(response, 500, {
      error: { code: "internal_error", message: "verification failed" },
    });
  }
}

export const apiBoundary = {
  status: "implemented",
  purpose: "HTTP boundary for the VerificationApplicationService.",
};
