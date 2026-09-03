import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type {
  DetectionContext,
  VerifyRepositorySnapshotRequest,
} from "@verify-agent/engine";
import {
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  SubprocessSandboxTransport,
  createVerificationPipeline,
  VerificationApplicationService,
} from "@verify-agent/engine";
import { createProjectDetectionService } from "@verify-agent/adapters-lang";
import type { VerificationApplicationService as VerificationApplicationServiceType } from "@verify-agent/engine";
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

function createDetectionContext(value: unknown): DetectionContext {
  if (!isRecord(value) || !isRecord(value.files)) {
    throw new ApiRequestError(
      400,
      "detectionContext.files must be an object of relative paths to text",
    );
  }
  const files = new Map<string, string>();
  for (const [path, contents] of Object.entries(value.files)) {
    if (typeof contents !== "string") {
      throw new ApiRequestError(
        400,
        `detectionContext.files[${path}] must be text`,
      );
    }
    files.set(path, contents);
  }
  return {
    exists: (path: string) => files.has(path),
    readFile: (path: string) => files.get(path),
    listDirectory: (path = "") =>
      [...files.keys()].filter((filePath) => filePath.startsWith(path)).sort(),
  };
}

function parseVerifyRequest(value: unknown): VerifyRepositorySnapshotRequest {
  if (!isRecord(value)) {
    throw new ApiRequestError(400, "request body must be a JSON object");
  }
  const required = [
    "project",
    "snapshot",
    "changeSet",
    "request",
    "job",
    "verificationId",
  ];
  for (const field of required) {
    if (!(field in value)) {
      throw new ApiRequestError(400, `missing required field: ${field}`);
    }
  }
  return {
    ...value,
    detectionContext: createDetectionContext(value.detectionContext),
  } as unknown as VerifyRepositorySnapshotRequest;
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
): VerificationApi {
  const server = createServer((request, response) => {
    void handleRequest(request, response, applicationService);
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
  options: ApiServerOptions = {},
): Promise<VerificationApi> {
  const api = createVerificationApi(applicationService);
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

export async function startConfiguredApiServer(): Promise<VerificationApi> {
  return startApiServer(createConfiguredApplicationService());
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  applicationService: Pick<VerificationApplicationServiceType, "verify">,
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
    const input = parseVerifyRequest(await readJson(request));
    sendJson(response, 200, await applicationService.verify(input));
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
