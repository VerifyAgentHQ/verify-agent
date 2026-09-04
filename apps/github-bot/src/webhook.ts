import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decideGitHubPullRequestEvent,
  type GitHubPullRequestDecision,
  type GitHubPullRequestEvent,
} from "../../../packages/adapters-source/src/github-pr.js";
import { InvalidSourceReferenceError } from "../../../packages/adapters-source/src/resolver.js";
import type { GitHubVerificationOrchestrator } from "./verification-orchestrator.js";

export class GitHubWebhookAuthenticationError extends Error {
  constructor(message = "GitHub webhook authentication failed") {
    super(message);
    this.name = "GitHubWebhookAuthenticationError";
  }
}

export class GitHubWebhookPayloadError extends Error {
  constructor(message = "GitHub webhook payload error") {
    super(message);
    this.name = "GitHubWebhookPayloadError";
  }
}

export class GitHubWebhookUnsupportedEventError extends Error {
  constructor(message = "GitHub webhook unsupported event") {
    super(message);
    this.name = "GitHubWebhookUnsupportedEventError";
  }
}

export class GitHubWebhookReplayError extends Error {
  constructor(message = "GitHub webhook replay detected") {
    super(message);
    this.name = "GitHubWebhookReplayError";
  }
}

export class GitHubWebhookConfigurationError extends Error {
  constructor(message = "GitHub webhook configuration error") {
    super(message);
    this.name = "GitHubWebhookConfigurationError";
  }
}

export interface GitHubWebhookVerificationOptions {
  readonly secret: string;
  readonly signatureHeader: string | null;
  readonly payload: string | Buffer | Uint8Array;
}

export interface GitHubWebhookReplayGuard {
  readonly checkAndRemember: (deliveryId: string) => boolean;
  readonly isReplay: (deliveryId: string) => boolean;
  readonly size: () => number;
}

export function createInMemoryGitHubWebhookReplayGuard(options?: {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
}): GitHubWebhookReplayGuard {
  const maxEntries = options?.maxEntries ?? 1000;
  const ttlMs = options?.ttlMs ?? 10 * 60 * 1000;
  const map = new Map<string, number>();

  function prune(now: number): void {
    for (const [key, expires] of map.entries()) {
      if (expires <= now) {
        map.delete(key);
      }
    }
    while (map.size > maxEntries) {
      const first = map.keys().next().value as string | undefined;
      if (first === undefined) break;
      map.delete(first);
    }
  }

  return {
    checkAndRemember(deliveryId: string): boolean {
      const now = Date.now();
      prune(now);
      if (map.has(deliveryId)) {
        const expires = map.get(deliveryId) as number;
        if (expires > now) {
          return true;
        }
        map.delete(deliveryId);
      }
      map.set(deliveryId, now + ttlMs);
      return false;
    },
    isReplay(deliveryId: string): boolean {
      const now = Date.now();
      prune(now);
      const expires = map.get(deliveryId);
      return expires !== undefined && expires > now;
    },
    size(): number {
      prune(Date.now());
      return map.size;
    },
  };
}

export function readGitHubWebhookSecret(env: NodeJS.ProcessEnv): string {
  const raw = env.GITHUB_WEBHOOK_SECRET;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new GitHubWebhookAuthenticationError("webhook secret not configured");
  }
  return raw;
}

const SIGNATURE_PREFIX = "sha256=";
const HEX_64_RE = /^[0-9a-f]{64}$/i;
const MAX_BODY_BYTES = 1_048_576;

export function verifyGitHubWebhookSignature(
  options: GitHubWebhookVerificationOptions,
): void {
  const { secret, signatureHeader, payload } = options;
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new GitHubWebhookAuthenticationError("webhook secret not configured");
  }
  if (
    typeof signatureHeader !== "string" ||
    signatureHeader.trim().length === 0
  ) {
    throw new GitHubWebhookAuthenticationError("missing webhook signature");
  }
  const signature = signatureHeader.trim();
  if (!signature.startsWith(SIGNATURE_PREFIX)) {
    throw new GitHubWebhookAuthenticationError(
      "unsupported webhook signature algorithm",
    );
  }
  const hex = signature.slice(SIGNATURE_PREFIX.length);
  if (hex.length !== 64 || !HEX_64_RE.test(hex)) {
    throw new GitHubWebhookAuthenticationError("malformed webhook signature");
  }

  const payloadBuffer =
    typeof payload === "string"
      ? Buffer.from(payload, "utf8")
      : Buffer.isBuffer(payload)
        ? payload
        : Buffer.from(payload as Uint8Array);

  const expected = createHmac("sha256", secret)
    .update(payloadBuffer)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const receivedBuf = Buffer.from(hex.toLowerCase(), "utf8");

  if (expectedBuf.length !== receivedBuf.length) {
    throw new GitHubWebhookAuthenticationError("webhook signature mismatch");
  }
  const equal = timingSafeEqual(expectedBuf, receivedBuf);
  if (!equal) {
    throw new GitHubWebhookAuthenticationError("webhook signature mismatch");
  }
}

export interface GitHubWebhookRequest {
  readonly rawBody: string;
  readonly signatureHeader: string | null;
  readonly eventHeader: string | null;
  readonly deliveryHeader: string | null;
}

export interface GitHubWebhookHandlerOptions {
  readonly secret: string;
  readonly maxBytes?: number;
  readonly replayGuard?: GitHubWebhookReplayGuard;
}

export interface GitHubWebhookSuccess {
  readonly kind: "verify" | "ignore";
  readonly decision: GitHubPullRequestDecision;
  readonly event: GitHubPullRequestEvent;
  readonly deliveryId: string;
}

function parseGitHubWebhookJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new GitHubWebhookPayloadError("webhook payload is not valid JSON");
  }
}

function mapGitHubWebhookPayloadToEvent(
  payload: unknown,
): GitHubPullRequestEvent {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    throw new GitHubWebhookPayloadError("webhook payload must be an object");
  }
  const record = payload as Record<string, unknown>;

  const pullRequestRaw = record.pull_request as unknown;
  const repositoryRaw = record.repository as unknown;
  const actionRaw = record.action;

  if (typeof actionRaw !== "string" || actionRaw.trim().length === 0) {
    throw new GitHubWebhookPayloadError("missing pull request action");
  }
  const action = actionRaw;

  if (
    typeof repositoryRaw !== "object" ||
    repositoryRaw === null ||
    Array.isArray(repositoryRaw)
  ) {
    throw new GitHubWebhookPayloadError("missing repository");
  }
  const repoRecord = repositoryRaw as Record<string, unknown>;
  let owner: string | undefined;
  const ownerRaw = repoRecord.owner;
  if (typeof ownerRaw === "string") {
    owner = ownerRaw;
  } else if (
    typeof ownerRaw === "object" &&
    ownerRaw !== null &&
    !Array.isArray(ownerRaw)
  ) {
    const ownerRecord = ownerRaw as Record<string, unknown>;
    if (typeof ownerRecord.login === "string") {
      owner = ownerRecord.login;
    }
  }
  if (typeof owner !== "string" || owner.trim().length === 0) {
    throw new GitHubWebhookPayloadError("missing repository owner");
  }

  const nameRaw = repoRecord.name;
  if (typeof nameRaw !== "string" || nameRaw.trim().length === 0) {
    throw new GitHubWebhookPayloadError("missing repository name");
  }
  const name = nameRaw;

  if (
    typeof pullRequestRaw !== "object" ||
    pullRequestRaw === null ||
    Array.isArray(pullRequestRaw)
  ) {
    throw new GitHubWebhookPayloadError("missing pull_request");
  }
  const prRecord = pullRequestRaw as Record<string, unknown>;
  const numberRaw = prRecord.number;
  if (
    typeof numberRaw !== "number" ||
    !Number.isInteger(numberRaw) ||
    numberRaw <= 0
  ) {
    throw new GitHubWebhookPayloadError("missing pull request number");
  }
  const number = numberRaw;

  const baseRaw = prRecord.base;
  if (
    typeof baseRaw !== "object" ||
    baseRaw === null ||
    Array.isArray(baseRaw)
  ) {
    throw new GitHubWebhookPayloadError("missing pull request base");
  }
  const baseRecord = baseRaw as Record<string, unknown>;
  const baseShaRaw = baseRecord.sha;
  if (typeof baseShaRaw !== "string" || baseShaRaw.trim().length === 0) {
    throw new GitHubWebhookPayloadError("missing pull request base sha");
  }
  const baseSha = baseShaRaw;

  const headRaw = prRecord.head;
  if (
    typeof headRaw !== "object" ||
    headRaw === null ||
    Array.isArray(headRaw)
  ) {
    throw new GitHubWebhookPayloadError("missing pull request head");
  }
  const headRecord = headRaw as Record<string, unknown>;
  const headShaRaw = headRecord.sha;
  if (typeof headShaRaw !== "string" || headShaRaw.trim().length === 0) {
    throw new GitHubWebhookPayloadError("missing pull request head sha");
  }
  const headSha = headShaRaw;

  return {
    action,
    repository: { owner, name },
    pullRequest: {
      number,
      base: { sha: baseSha },
      head: { sha: headSha },
    },
  };
}

export function readSingleHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    throw new GitHubWebhookPayloadError(`ambiguous header: ${name}`);
  }
  if (typeof value !== "string") return null;
  return value;
}

export function readSingleHeaderFromIncomingMessage(
  request: IncomingMessage,
  name: string,
): string | null {
  const headers = request.headers as Record<
    string,
    string | string[] | undefined
  >;
  return readSingleHeader(headers, name);
}

export function collectRawBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let overflowed = false;

    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
      request.removeListener("close", onClose);
    };

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    // Named drain listeners for overflow – removable after terminal close
    const onDrainError = (): void => {};
    const onDrainAborted = (): void => {};
    const onDrainClose = (): void => {
      request.removeListener("error", onDrainError);
      request.removeListener("aborted", onDrainAborted);
      request.removeListener("close", onDrainClose);
    };

    const onData = (chunk: Buffer | string): void => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk, "utf8");
      total += buffer.length;
      if (total > maxBytes) {
        overflowed = true;
        settled = true;
        cleanup();
        // Keep swallowing late errors/aborted/close after overflow until terminal close
        request.on("error", onDrainError);
        request.on("aborted", onDrainAborted);
        request.on("close", onDrainClose);
        try {
          request.resume();
        } catch {
          // ignore
        }
        reject(
          new GitHubWebhookPayloadError(
            `webhook payload exceeds ${maxBytes} bytes`,
          ),
        );
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = (): void => {
      settle(() => resolve(Buffer.concat(chunks)));
    };

    const onError = (error: unknown): void => {
      settle(() =>
        reject(
          error instanceof Error
            ? error
            : new GitHubWebhookPayloadError("webhook request error"),
        ),
      );
    };

    const onAborted = (): void => {
      settle(() =>
        reject(new GitHubWebhookPayloadError("webhook request aborted")),
      );
    };

    const onClose = (): void => {
      if (settled) return;
      // Close without end – avoid hanging; treat as aborted unless overflowed (already settled)
      if (overflowed) return;
      settle(() =>
        reject(new GitHubWebhookPayloadError("webhook request closed")),
      );
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
    request.on("aborted", onAborted);
    request.on("close", onClose);
  });
}

export function parseTrustedGitHubPullRequestEvent(options: {
  readonly rawBody: string | Buffer | Uint8Array;
  readonly signatureHeader: string | null;
  readonly eventHeader: string | null;
  readonly deliveryHeader: string | null;
  readonly secret: string;
  readonly maxBytes?: number;
  readonly replayGuard?: GitHubWebhookReplayGuard;
}): GitHubPullRequestEvent {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const rawBodyBuffer =
    typeof options.rawBody === "string"
      ? Buffer.from(options.rawBody, "utf8")
      : Buffer.isBuffer(options.rawBody)
        ? options.rawBody
        : Buffer.from(options.rawBody as Uint8Array);

  if (rawBodyBuffer.length > maxBytes) {
    throw new GitHubWebhookPayloadError(
      `webhook payload exceeds ${maxBytes} bytes`,
    );
  }

  // Required header extraction before verification (event type and delivery)
  if (
    typeof options.deliveryHeader !== "string" ||
    options.deliveryHeader.trim().length === 0
  ) {
    throw new GitHubWebhookReplayError("missing X-GitHub-Delivery");
  }
  const deliveryId = options.deliveryHeader.trim();

  if (
    typeof options.eventHeader !== "string" ||
    options.eventHeader.trim().length === 0
  ) {
    throw new GitHubWebhookUnsupportedEventError("missing X-GitHub-Event");
  }
  const eventName = options.eventHeader.trim();
  if (eventName !== "pull_request") {
    throw new GitHubWebhookUnsupportedEventError(
      `unsupported event: ${eventName}`,
    );
  }

  verifyGitHubWebhookSignature({
    secret: options.secret,
    signatureHeader: options.signatureHeader,
    payload: rawBodyBuffer,
  });

  if (options.replayGuard) {
    const isReplay = options.replayGuard.checkAndRemember(deliveryId);
    if (isReplay) {
      throw new GitHubWebhookReplayError(
        `replay detected for delivery ${deliveryId}`,
      );
    }
  }

  const payloadString = rawBodyBuffer.toString("utf8");
  const json = parseGitHubWebhookJson(payloadString);
  const event = mapGitHubWebhookPayloadToEvent(json);

  return event;
}

export function handleGitHubWebhookRequest(options: {
  readonly rawBody: string | Buffer | Uint8Array;
  readonly signatureHeader: string | null;
  readonly eventHeader: string | null;
  readonly deliveryHeader: string | null;
  readonly secret: string;
  readonly maxBytes?: number;
  readonly replayGuard?: GitHubWebhookReplayGuard;
}): GitHubWebhookSuccess {
  const rawBodyBuffer =
    typeof options.rawBody === "string"
      ? Buffer.from(options.rawBody, "utf8")
      : Buffer.isBuffer(options.rawBody)
        ? options.rawBody
        : Buffer.from(options.rawBody as Uint8Array);

  const event = parseTrustedGitHubPullRequestEvent({
    rawBody: rawBodyBuffer,
    signatureHeader: options.signatureHeader,
    eventHeader: options.eventHeader,
    deliveryHeader: options.deliveryHeader,
    secret: options.secret,
    maxBytes: options.maxBytes,
    replayGuard: options.replayGuard,
  });

  let decision: GitHubPullRequestDecision;
  try {
    decision = decideGitHubPullRequestEvent(event);
  } catch (error) {
    if (
      error instanceof InvalidSourceReferenceError ||
      (error instanceof Error && error.name === "InvalidSourceReferenceError")
    ) {
      throw new GitHubWebhookPayloadError("invalid pull request event");
    }
    throw error;
  }

  const deliveryId = options.deliveryHeader?.trim() ?? "";

  if (decision.kind === "verify") {
    return {
      kind: "verify",
      decision,
      event,
      deliveryId,
    };
  }
  return {
    kind: "ignore",
    decision,
    event,
    deliveryId,
  };
}

export interface GitHubWebhookHttpOptions {
  readonly secret: string;
  readonly maxBytes?: number;
  readonly replayGuard?: GitHubWebhookReplayGuard;
  readonly orchestrator?: GitHubVerificationOrchestrator;
}

export interface GitHubWebhookHttpResult {
  readonly status: number;
  readonly body: unknown;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(payload);
}

export async function handleGitHubWebhookHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GitHubWebhookHttpOptions,
): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  try {
    const signatureHeader = readSingleHeaderFromIncomingMessage(
      request,
      "x-hub-signature-256",
    );
    const eventHeader = readSingleHeaderFromIncomingMessage(
      request,
      "x-github-event",
    );
    const deliveryHeader = readSingleHeaderFromIncomingMessage(
      request,
      "x-github-delivery",
    );

    // Enforce ambiguous header rejection before body collection where possible
    // readSingleHeader already throws on duplicate

    const rawBody = await collectRawBody(request, maxBytes);

    if (options.orchestrator) {
      const event = parseTrustedGitHubPullRequestEvent({
        rawBody,
        signatureHeader,
        eventHeader,
        deliveryHeader,
        secret: options.secret,
        maxBytes,
        replayGuard: options.replayGuard,
      });
      const orchestration = await options.orchestrator.handle(event);
      sendJson(response, 202, {
        status: orchestration.kind === "ignored" ? "ignored" : "accepted",
        deliveryId: deliveryHeader?.trim() ?? "",
        ...(orchestration.kind === "ignored"
          ? { reason: orchestration.reason }
          : {}),
      });
      return;
    }

    const result = handleGitHubWebhookRequest({
      rawBody,
      signatureHeader,
      eventHeader,
      deliveryHeader,
      secret: options.secret,
      maxBytes,
      replayGuard: options.replayGuard,
    });

    if (result.kind === "verify") {
      sendJson(response, 200, {
        status: "accepted",
        source: result.decision.source,
        deliveryId: result.deliveryId,
      });
      return;
    }
    // ignore -> still 200 but with ignored reason
    sendJson(response, 200, {
      status: "ignored",
      reason: (result.decision as { reason: string }).reason,
      deliveryId: result.deliveryId,
    });
  } catch (error) {
    if (error instanceof GitHubWebhookAuthenticationError) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (error instanceof GitHubWebhookReplayError) {
      sendJson(response, 409, { error: "replay detected" });
      return;
    }
    if (error instanceof GitHubWebhookUnsupportedEventError) {
      sendJson(response, 202, {
        status: "ignored",
        reason: (error as Error).message,
      });
      return;
    }
    if (error instanceof GitHubWebhookPayloadError) {
      const message = (error as Error).message;
      const status = message.includes("exceeds") ? 413 : 400;
      sendJson(response, status, {
        error: status === 413 ? "payload too large" : "bad request",
      });
      return;
    }
    sendJson(response, 500, { error: "internal server error" });
  }
}

export function createGitHubWebhookHttpHandler(
  options: GitHubWebhookHttpOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handleGitHubWebhookHttpRequest(request, response, options);
  };
}

export interface ConfiguredGitHubWebhookHandlerOptions {
  readonly secret: string;
  readonly orchestrator: GitHubVerificationOrchestrator;
  readonly maxBytes?: number;
  readonly replayGuard?: GitHubWebhookReplayGuard;
}

/**
 * Production composition for the GitHub webhook boundary.
 *
 * Low-level `createGitHubWebhookHttpHandler` remains a reusable transport
 * primitive where `orchestrator` is optional for transport-only,
 * authentication-only, parser, and deterministic unit tests.
 *
 * Production composition is stricter: the orchestrator is mandatory and its
 * omission fails fast during composition instead of silently acknowledging
 * authenticated PR events without verification.
 *
 * Intended composition (owned by the composition root):
 *
 * ```text
 * SourceResolver
 *     ↓
 * VerificationApplicationService
 *     ↓
 * GitHubVerificationOrchestrator
 *     ↓
 * createConfiguredGitHubWebhookHandler
 * ```
 *
 * Execution remains synchronous with no queue, worker, persistence, or retry.
 */
export function createConfiguredGitHubWebhookHandler(
  options: ConfiguredGitHubWebhookHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  if (!options || typeof options !== "object") {
    throw new GitHubWebhookConfigurationError(
      "GitHub webhook production configuration is required",
    );
  }
  if (
    typeof options.secret !== "string" ||
    options.secret.trim().length === 0
  ) {
    throw new GitHubWebhookConfigurationError(
      "GitHub webhook secret is required for production composition",
    );
  }
  const orchestrator = (options as unknown as { orchestrator?: unknown })
    .orchestrator;
  if (
    !orchestrator ||
    typeof (orchestrator as GitHubVerificationOrchestrator).handle !==
      "function"
  ) {
    throw new GitHubWebhookConfigurationError(
      "GitHub webhook orchestrator is required for production composition",
    );
  }

  const httpOptions: GitHubWebhookHttpOptions = {
    secret: options.secret,
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.replayGuard !== undefined
      ? { replayGuard: options.replayGuard }
      : {}),
    orchestrator: options.orchestrator,
  };
  return createGitHubWebhookHttpHandler(httpOptions);
}
