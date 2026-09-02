import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import type {
  ExecutionSource,
  PublicSandboxJobRequest,
  PublicSandboxJobResult,
  SandboxExecutor,
  SandboxJobRequest,
  SandboxTransport,
  SandboxTransportObserver,
} from "./interfaces.js";
import { toPublicSandboxJobRequest } from "./execution.js";

const SCHEMA_VERSION = "1.0.0";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SANDBOX_STATUSES = new Set([
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "error",
]);

function requireExecutionSource(value: unknown): ExecutionSource {
  if (value === "real" || value === "simulated" || value === "fixture")
    return value;
  throw new SandboxTransportError(
    "sandbox transport must explicitly declare execution provenance",
  );
}

export class SandboxProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxProtocolError";
  }
}

export class SandboxTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTransportError";
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SandboxProtocolError("sandbox message must be an object");
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new SandboxProtocolError(`unexpected field in ${name}`);
}

function stringField(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw new SandboxProtocolError(`invalid ${name}`);
  return value;
}

function integerField(value: unknown, name: string, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new SandboxProtocolError(`invalid ${name}`);
  return value;
}

function stringArray(value: unknown, name: string, maxItem: number): string[] {
  if (!Array.isArray(value)) throw new SandboxProtocolError(`invalid ${name}`);
  return value.map((entry) => stringField(entry, name, maxItem));
}

export function validateSandboxJobRequest(
  value: unknown,
): PublicSandboxJobRequest {
  const object = record(value);
  exactKeys(
    object,
    [
      "schemaVersion",
      "jobId",
      "source",
      "snapshot",
      "commands",
      "resourceLimits",
      "networkPolicy",
      "artifactPolicy",
    ],
    "sandbox request",
  );
  if (object.schemaVersion !== SCHEMA_VERSION)
    throw new SandboxProtocolError("invalid sandbox request schemaVersion");
  const jobId = stringField(object.jobId, "jobId", 256);
  if (!IDENTIFIER.test(jobId)) throw new SandboxProtocolError("invalid jobId");
  const source = record(object.source);
  const provider = stringField(source.provider, "source.provider", 64);
  const reference = stringField(source.reference, "source.reference", 2048);
  const snapshot = stringField(object.snapshot, "snapshot", 256);
  const commands = stringArray(object.commands, "command", 4096);
  if (commands.length === 0)
    throw new SandboxProtocolError("sandbox request has no commands");
  const limits = record(object.resourceLimits);
  exactKeys(limits, ["timeoutMs", "memoryLimitBytes"], "resourceLimits");
  const resourceLimits = {
    timeoutMs: integerField(limits.timeoutMs, "timeoutMs", 1),
    memoryLimitBytes: integerField(
      limits.memoryLimitBytes,
      "memoryLimitBytes",
      1,
    ),
  };
  if (resourceLimits.memoryLimitBytes > 1_099_511_627_776)
    throw new SandboxProtocolError("memoryLimitBytes exceeds contract maximum");
  if (
    !["none", "restricted", "allowlist"].includes(String(object.networkPolicy))
  )
    throw new SandboxProtocolError("invalid networkPolicy");
  if (!["none", "declared"].includes(String(object.artifactPolicy)))
    throw new SandboxProtocolError("invalid artifactPolicy");
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId,
    source: { provider, reference },
    snapshot,
    commands,
    resourceLimits,
    networkPolicy:
      object.networkPolicy as PublicSandboxJobRequest["networkPolicy"],
    artifactPolicy:
      object.artifactPolicy as PublicSandboxJobRequest["artifactPolicy"],
  };
}

export function validateSandboxJobResult(
  value: unknown,
  expectedJobId?: string,
): PublicSandboxJobResult {
  const object = record(value);
  exactKeys(
    object,
    [
      "schemaVersion",
      "jobId",
      "status",
      "exitCode",
      "durationMs",
      "logsRef",
      "artifactRefs",
      "resourceUsage",
      "errors",
    ],
    "sandbox result",
  );
  if (object.schemaVersion !== SCHEMA_VERSION)
    throw new SandboxProtocolError("invalid sandbox result schemaVersion");
  const jobId = stringField(object.jobId, "jobId", 256);
  if (
    !IDENTIFIER.test(jobId) ||
    (expectedJobId !== undefined && jobId !== expectedJobId)
  )
    throw new SandboxProtocolError("sandbox result jobId mismatch");
  if (typeof object.status !== "string" || !SANDBOX_STATUSES.has(object.status))
    throw new SandboxProtocolError("invalid sandbox result status");
  const durationMs = integerField(object.durationMs, "durationMs", 0);
  const logsRef =
    typeof object.logsRef === "string" && object.logsRef.length <= 2048
      ? object.logsRef
      : (() => {
          throw new SandboxProtocolError("invalid logsRef");
        })();
  const artifactRefs = stringArray(object.artifactRefs, "artifactRef", 2048);
  if (artifactRefs.length > 100)
    throw new SandboxProtocolError("too many artifact references");
  const usage = record(object.resourceUsage);
  exactKeys(usage, ["memoryBytes", "cpuTimeMs"], "resourceUsage");
  const resourceUsage = {
    memoryBytes: integerField(usage.memoryBytes, "memoryBytes", 0),
    cpuTimeMs: integerField(usage.cpuTimeMs, "cpuTimeMs", 0),
  };
  if (
    resourceUsage.memoryBytes > 1_099_511_627_776 ||
    resourceUsage.cpuTimeMs > 86_400_000
  )
    throw new SandboxProtocolError("resource usage exceeds contract maximum");
  const errors = stringArray(object.errors, "error", 4096);
  let exitCode: number | undefined;
  if (object.exitCode !== undefined)
    exitCode = integerField(object.exitCode, "exitCode", -2_147_483_648);
  if (exitCode !== undefined && exitCode > 2_147_483_647)
    throw new SandboxProtocolError("invalid exitCode");
  return {
    schemaVersion: SCHEMA_VERSION,
    jobId,
    status: object.status as PublicSandboxJobResult["status"],
    ...(exitCode === undefined ? {} : { exitCode }),
    durationMs,
    logsRef,
    artifactRefs,
    resourceUsage,
    errors,
  };
}

export interface SandboxProcessConfig {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly workingDirectory?: string;
  /** Explicit child environment. The host environment is never inherited. */
  readonly environment?: Readonly<Record<string, string>>;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxMessageBytes: number;
  readonly maxStderrBytes: number;
  readonly observe?: SandboxTransportObserver;
}

function validateConfig(config: SandboxProcessConfig): void {
  if (!config.executable || config.executable.includes("\0"))
    throw new SandboxTransportError(
      "sandbox executable configuration is invalid",
    );
  if (
    !Number.isSafeInteger(config.startupTimeoutMs) ||
    config.startupTimeoutMs < 1 ||
    !Number.isSafeInteger(config.requestTimeoutMs) ||
    config.requestTimeoutMs < 1 ||
    !Number.isSafeInteger(config.maxMessageBytes) ||
    config.maxMessageBytes < 1 ||
    !Number.isSafeInteger(config.maxStderrBytes) ||
    config.maxStderrBytes < 1
  )
    throw new SandboxTransportError("sandbox process limits are invalid");
  if (config.args?.some((arg) => arg.includes("\0")))
    throw new SandboxTransportError("sandbox process argument contains NUL");
  if (
    config.environment &&
    Object.entries(config.environment).some(
      ([key, value]) =>
        key.length === 0 || key.includes("\0") || value.includes("\0"),
    )
  )
    throw new SandboxTransportError("sandbox process environment is invalid");
}

function boundedRead(stream: Readable, maximum: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    stream.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maximum - size;
      if (remaining > 0) {
        const retained = buffer.subarray(0, remaining);
        chunks.push(retained);
        size += retained.length;
      }
      if (buffer.length > remaining) exceeded = true;
    });
    stream.once("error", reject);
    stream.once("end", () => {
      if (exceeded)
        reject(
          new SandboxTransportError("sandbox message exceeded size limit"),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

function exit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

function terminate(child: ChildProcess): void {
  if (child.exitCode === null && !child.killed) child.kill();
}

export class SubprocessSandboxTransport implements SandboxTransport {
  readonly executionSource = "real" as const;
  constructor(private readonly config: SandboxProcessConfig) {
    validateConfig(config);
  }

  async execute(
    request: PublicSandboxJobRequest,
    signal?: AbortSignal,
  ): Promise<unknown> {
    validateSandboxJobRequest(request);
    const encoded = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(encoded) > this.config.maxMessageBytes)
      throw new SandboxTransportError("sandbox request exceeded size limit");
    const child = spawn(this.config.executable, [...(this.config.args ?? [])], {
      cwd: this.config.workingDirectory,
      env: { ...(this.config.environment ?? {}) },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.config.observe?.({ type: "request_started", jobId: request.jobId });
    const stdout = boundedRead(child.stdout!, this.config.maxMessageBytes);
    const stderr = boundedRead(child.stderr!, this.config.maxStderrBytes);
    const exited = exit(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const onAbort = (): void => {
      cancelled = true;
      this.config.observe?.({ type: "cancelled", jobId: request.jobId });
      terminate(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child.stdin!.end(encoded);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.config.observe?.({ type: "timeout", jobId: request.jobId });
          terminate(child);
          reject(new SandboxTransportError("sandbox request timed out"));
        }, this.config.requestTimeoutMs);
      });
      const [raw, , code] = await Promise.race([
        Promise.all([stdout, stderr, exited]),
        timeout,
      ]);
      if (cancelled)
        throw new SandboxTransportError("sandbox request cancelled");
      if (code !== 0 && raw.trim().length === 0)
        throw new SandboxTransportError(
          `sandbox process exited with code ${String(code)}`,
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        throw new SandboxProtocolError("sandbox response is not valid JSON");
      }
      const result = validateSandboxJobResult(parsed, request.jobId);
      this.config.observe?.({
        type: "response_received",
        jobId: request.jobId,
      });
      return result;
    } catch (error) {
      this.config.observe?.({
        type: "transport_failure",
        jobId: request.jobId,
      });
      if (
        error instanceof SandboxProtocolError ||
        error instanceof SandboxTransportError
      )
        throw error;
      throw new SandboxTransportError(
        error instanceof Error ? error.message : "sandbox transport failed",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      terminate(child);
      await Promise.race([
        exited,
        new Promise((resolve) =>
          setTimeout(resolve, this.config.startupTimeoutMs),
        ),
      ]);
    }
  }
}

export function createSandboxExecutorFromTransport(
  transport: SandboxTransport,
): SandboxExecutor {
  const executionSource = requireExecutionSource(transport.executionSource);
  return {
    executionSource,
    async execute(
      request: SandboxJobRequest,
    ): Promise<import("./interfaces.js").SandboxJobResult> {
      const publicRequest = validateSandboxJobRequest(
        toPublicSandboxJobRequest(request),
      );
      const raw = await transport.execute(publicRequest);
      return validateSandboxJobResult(raw, publicRequest.jobId);
    },
  };
}

export class FakeSandboxTransport implements SandboxTransport {
  readonly executionSource = "simulated" as const;
  readonly requests: PublicSandboxJobRequest[] = [];

  constructor(
    private readonly response:
      unknown | ((request: PublicSandboxJobRequest) => unknown),
    private readonly failure?: Error,
  ) {}

  async execute(request: PublicSandboxJobRequest): Promise<unknown> {
    this.requests.push(request);
    if (this.failure) throw this.failure;
    return typeof this.response === "function"
      ? this.response(request)
      : this.response;
  }
}
