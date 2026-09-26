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
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  SubprocessSandboxTransport,
  createVerificationPipeline,
  VerificationApplicationService,
  type VerificationApplicationService as VerificationApplicationServiceType,
} from "@verify-agent/engine";
import { createProjectDetectionService } from "@verify-agent/adapters-lang";
import {
  InvalidSourceReferenceError,
  type SourceResolver,
  createGitHubApiInstallationResolver,
  createGitHubAppInstallationTokenClient,
  createGitHubAppSourceProvider,
  createGitHubSourceResolver,
  readGitHubAppConfig,
} from "@verify-agent/adapters-source";
import type {
  PublicAsyncVerificationResponse,
  PublicVerifyRequest,
  PublicVerificationResponse,
} from "./public-dto.js";
import { fileURLToPath } from "node:url";

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

export function createConfiguredApplicationService(): VerificationApplicationService {
  const executable = process.env.VERIFY_SANDBOX_PROCESS;
  if (!executable) {
    throw new Error("VERIFY_SANDBOX_PROCESS must be configured");
  }
  const transport = new SubprocessSandboxTransport({
    executable,
    environment: {},
    startupTimeoutMs: 5_000,
    requestTimeoutMs: 120_000,
    maxMessageBytes: 1_048_576,
    maxStderrBytes: 64 * 1024,
  });
  const pipeline = createVerificationPipeline({
    detector: createProjectDetectionService(),
    executor: createCheckExecutor(
      createSandboxExecutorFromTransport(transport),
    ),
  });
  return new VerificationApplicationService(
    pipeline,
    createConfiguredSourceResolver(),
  );
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

function createConfiguredSourceResolver(): SourceResolver {
  const env = process.env;
  const appIdConfigured =
    typeof env.GITHUB_APP_ID === "string" &&
    env.GITHUB_APP_ID.trim().length > 0;
  const privateKeyConfigured =
    typeof env.GITHUB_APP_PRIVATE_KEY === "string" &&
    env.GITHUB_APP_PRIVATE_KEY.trim().length > 0;
  if (!appIdConfigured || !privateKeyConfigured) {
    return createDefaultSourceResolver();
  }
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
  return createGitHubSourceResolver(provider);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void startConfiguredApiServer().catch((error: unknown) => {
    console.error(
      `API failed to start: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
