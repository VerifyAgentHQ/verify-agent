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
import type { PublicAsyncVerificationResponse } from "./public-dto.js";
import { fileURLToPath } from "node:url";

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
    requirementEvidence: result.requirementEvidence,
    checkRunEvidence: result.checkRunEvidence,
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
  resultReader?: VerificationResultReader | null,
  options: VerificationApiOptions = {},
): (request: IncomingMessage, response: ServerResponse) => void {
  const internalResultToken =
    normalizeConfiguredToken(options.internalResultToken) ?? null;
  return (request, response) => {
    void handleRequest(request, response, resultReader, internalResultToken);
  };
}

export function createVerificationApi(
  resultReader?: VerificationResultReader | null,
  options: VerificationApiOptions = {},
): VerificationApi {
  const server = createServer(
    createVerificationRequestListener(resultReader, options),
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
  options: ApiServerOptions = {},
): Promise<VerificationApi> {
  const api = createVerificationApi(
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
/**
 * Canonical maximum `resourceLimits.timeoutMs` the external sandbox backend
 * accepts (verify-sandbox `MAX_TIMEOUT_MS = 60 * 60 * 1000`).
 */

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
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
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
  sendJson(response, 404, {
    error: { code: "not_found", message: "route not found" },
  });
}

export const apiBoundary = {
  status: "implemented",
  purpose: "HTTP boundary for the VerificationApplicationService.",
};
