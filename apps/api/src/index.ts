import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { brandId } from "@verify-agent/domain";
import type {
  ChangeSet,
  PolicyId,
  Project,
  RepositorySnapshot,
  VerificationRequest,
  VerificationJob,
  VerificationResult,
} from "@verify-agent/domain";
import type {
  VerifyRepositorySnapshotRequest,
  DetectionContext,
} from "@verify-agent/engine";
import {
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  SubprocessSandboxTransport,
  createVerificationPipeline,
  VerificationApplicationService,
  type VerificationApplicationService as VerificationApplicationServiceType,
} from "@verify-agent/engine";
import {
  createProjectDetectionService,
  createMemoryDetectionContext,
} from "@verify-agent/adapters-lang";
import {
  InvalidSourceReferenceError,
  type ResolvedSource,
  type SourceResolver,
} from "@verify-agent/adapters-source";
import type {
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

function adaptRequest(
  publicRequest: PublicVerifyRequest,
  resolved: ResolvedSource,
): VerifyRepositorySnapshotRequest {
  const snapshot: RepositorySnapshot = resolved.snapshot;
  const projectId = snapshot.projectId;
  const changeSetId = brandId(
    `${publicRequest.source.id}-changeset`,
  ) as ChangeSet["id"];
  const requestId = brandId(
    `${publicRequest.source.id}-request`,
  ) as VerificationRequest["id"];
  const jobId = brandId(
    `${publicRequest.source.id}-job`,
  ) as VerificationJob["id"];
  const verificationId = `${publicRequest.source.id}-verification`;
  const createdAt = new Date().toISOString();

  const changeSet: ChangeSet = {
    id: changeSetId,
    baseSourceState: snapshot.sourceState,
    headSourceState: snapshot.sourceState,
    changedFiles: [],
    additions: 0,
    deletions: 0,
    changeHash: publicRequest.source.id,
    issueReferences: [],
  };

  const request: VerificationRequest = {
    id: requestId,
    projectId,
    snapshotId: snapshot.id,
    changeSetId,
    requestedBy: { type: "source-platform" },
    mode: "commit",
    requestedChecks: [],
    policyId: brandId("default") as PolicyId,
    priority: 0,
    createdAt,
  };

  const job: VerificationJob = {
    id: jobId,
    requestId,
    attempt: 1,
    status: "queued",
  };

  const detectionContext: DetectionContext = createMemoryDetectionContext(
    resolved.sourceContents,
  );

  const project: Project = {
    id: projectId,
    name: "",
    root: ".",
  };

  return {
    project,
    snapshot,
    changeSet,
    detectionContext,
    request,
    job,
    verificationId,
  };
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

export function createVerificationApi(
  applicationService: Pick<VerificationApplicationServiceType, "verify">,
  sourceResolver: SourceResolver,
): VerificationApi {
  const server = createServer((request, response) => {
    void handleRequest(request, response, applicationService, sourceResolver);
  });
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
}

export async function startApiServer(
  applicationService: Pick<VerificationApplicationServiceType, "verify">,
  sourceResolver: SourceResolver,
  options: ApiServerOptions = {},
): Promise<VerificationApi> {
  const api = createVerificationApi(applicationService, sourceResolver);
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

function createConfiguredApplicationService(): VerificationApplicationService {
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
  return new VerificationApplicationService(pipeline);
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

export async function startConfiguredApiServer(): Promise<VerificationApi> {
  return startApiServer(
    createConfiguredApplicationService(),
    createDefaultSourceResolver(),
  );
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  applicationService: Pick<VerificationApplicationServiceType, "verify">,
  sourceResolver: SourceResolver,
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { status: "ok" });
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
    let resolved: ResolvedSource;
    try {
      resolved = await sourceResolver.resolveSnapshot(publicRequest.source);
    } catch (error) {
      if (
        error instanceof InvalidSourceReferenceError ||
        (error instanceof Error && error.name === "InvalidSourceReferenceError")
      ) {
        throw new ApiRequestError(400, "invalid source reference");
      }
      throw error;
    }
    const verifyInput = adaptRequest(publicRequest, resolved);
    const result = await applicationService.verify(verifyInput);
    sendJson(response, 200, adaptResult(result, publicRequest.source));
  } catch (error) {
    if (error instanceof ApiRequestError) {
      sendJson(response, error.statusCode, {
        error: { code: "invalid_request", message: error.message },
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
