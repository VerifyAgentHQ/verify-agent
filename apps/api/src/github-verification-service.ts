import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { VerificationResultReader } from "@verify-agent/domain";
import type { VerificationApplicationService as VerificationApplicationServiceType } from "@verify-agent/engine";
import { createInMemoryVerificationJobQueue } from "@verify-agent/engine";
import type { InMemoryVerificationJobQueue } from "@verify-agent/engine";
import {
  createGitHubVerificationOrchestrator,
  createConfiguredGitHubWebhookHandler,
  createInMemoryGitHubWebhookReplayGuard,
  type GitHubVerificationOrchestrator,
  type GitHubWebhookReplayGuard,
} from "@verify-agent/github-bot";
import {
  createInMemoryVerificationResultRegistry,
  createVerificationJobProcessor,
  createVerificationJobRuntime,
  type VerificationJobProcessor,
  type VerificationJobRuntime,
  type VerificationJobSettledOutcome,
  type VerificationResultRegistry,
} from "@verify-agent/worker";
import {
  createGitHubApiInstallationResolver,
  createGitHubAppInstallationTokenClient,
  createGitHubCheckPublisher,
  createGitHubRepositorySnapshot,
  decodeGitHubSnapshotReference,
  readGitHubAppConfig,
  type GitHubCheckPublisher,
} from "@verify-agent/adapters-source";
import {
  createConfiguredApplicationService,
  createVerificationRequestListener,
  readInternalResultToken,
} from "./index.js";
import { readGitHubWebhookSecret } from "@verify-agent/github-bot";

/**
 * Batch 51 — Runnable In-Process GitHub Verification Service.
 *
 * Single-process composition sharing ONE queue, ONE runtime, ONE processor,
 * ONE result registry, ONE protected API listener, and ONE GitHub webhook
 * boundary:
 *
 * ```text
 * GitHub webhook (POST /webhook, HMAC + replay + immutable head SHA)
 *     ↓ VerificationQueueJob (202 + queueJobId)
 * shared in-memory queue
 *     ↓ application-owned runtime (automatic, event-driven, sequential)
 * VerificationJobProcessor → VerificationApplicationService.verifySource()
 *     ↓ existing detection/planning/execution/evidence/policy pipeline
 * VerificationResult → bounded registry → protected GET
 * /verification-jobs/:queueJobId/result (internal bearer token, fail-closed)
 * ```
 *
 * Invariants:
 * - `webhook queue === runtime queue === processor source/job flow`.
 * - `runtime registry === API result reader`.
 * - The webhook only enqueues verified jobs; it never calls
 *   `verifySource()`, `processNext()`, or the sandbox.
 * - Failures yield `failed` outcomes, register nothing, and keep the
 *   runtime usable. No retries, no dead-letter queues.
 * - Nothing secret is logged; no logging framework is introduced.
 * - Sequential in-process execution; no parallel workers.
 *
 * Batch 55A — when `checkPublisher` is provided, the service additionally
 * owns production Check publication:
 *
 * ```text
 * GitHub PR webhook → queued verification → VerificationResult settled
 *   → GitHubCheckPublisher automatically invoked (exact SHA, monotonic)
 * ```
 *
 * - Exactly one publisher subscription while started; none while stopped.
 * - Publication failures never mutate VerificationResult or the registry.
 *
 * Batch 55B — `startConfiguredGitHubVerificationService` constructs that
 * publisher from GitHub App configuration (`GITHUB_APP_ID` +
 * `GITHUB_APP_PRIVATE_KEY`, fail-closed) via
 * `createConfiguredGitHubCheckPublisher`, so the normal configured
 * startup publishes without any caller-supplied publisher.
 */

export interface GitHubVerificationServiceDependencies {
  readonly applicationService: Pick<
    VerificationApplicationServiceType,
    "verifySource"
  >;
  readonly secret: string;
  readonly internalResultToken?: string | null;
  readonly replayGuard?: GitHubWebhookReplayGuard;
  readonly queue?: InMemoryVerificationJobQueue;
  readonly registry?: VerificationResultRegistry;
  readonly maxResults?: number;
  readonly createJobId?: () => string;
  readonly now?: () => string;
  /**
   * Batch 55A — production GitHub Check publisher owned by the running
   * service. When present, the service subscribes exactly once on `start`
   * and unsubscribes on `stop`/`close`, translating each completed
   * `VerificationResult` into a Check Run for the exact verified commit.
   * Publication failures never mutate verification truth.
   */
  readonly checkPublisher?: Pick<
    GitHubCheckPublisher,
    "publishVerificationResult"
  > | null;
}

export interface GitHubVerificationService {
  readonly queue: InMemoryVerificationJobQueue;
  readonly runtime: VerificationJobRuntime;
  readonly processor: VerificationJobProcessor;
  readonly registry: VerificationResultRegistry;
  readonly resultReader: VerificationResultReader;
  readonly applicationService: Pick<
    VerificationApplicationServiceType,
    "verifySource"
  >;
  readonly orchestrator: GitHubVerificationOrchestrator;
  readonly replayGuard: GitHubWebhookReplayGuard;
  readonly server: Server;
  readonly isStarted: () => boolean;
  start(port?: number, host?: string): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  waitForQueueJob(
    queueJobId: string,
    options?: { readonly timeoutMs?: number },
  ): Promise<VerificationJobSettledOutcome>;
  onSettled(
    listener: (outcome: VerificationJobSettledOutcome) => void,
  ): () => void;
}

function resolveWebhookPath(url: string | undefined): string {
  if (typeof url !== "string" || url.length === 0) return "";
  return url.split("?")[0]?.split("#")[0] ?? "";
}

function sendShutdownJson(response: ServerResponse): void {
  const payload = JSON.stringify({
    error: { code: "unavailable", message: "service is shutting down" },
  });
  response.statusCode = 503;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(payload);
}

export function createGitHubVerificationService(
  dependencies: GitHubVerificationServiceDependencies,
): GitHubVerificationService {
  const applicationService = dependencies?.applicationService;
  if (
    !applicationService ||
    typeof applicationService.verifySource !== "function"
  ) {
    throw new Error("an application service with verifySource is required");
  }
  const secret = dependencies?.secret;
  if (typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("a GitHub webhook secret is required");
  }

  const queue: InMemoryVerificationJobQueue =
    dependencies.queue ?? createInMemoryVerificationJobQueue();
  const registry: VerificationResultRegistry =
    dependencies.registry ??
    createInMemoryVerificationResultRegistry(
      dependencies.maxResults === undefined
        ? {}
        : { maxResults: dependencies.maxResults },
    );
  const replayGuard: GitHubWebhookReplayGuard =
    dependencies.replayGuard ?? createInMemoryGitHubWebhookReplayGuard();
  const processor: VerificationJobProcessor =
    createVerificationJobProcessor(applicationService);
  const runtime: VerificationJobRuntime = createVerificationJobRuntime({
    queue,
    processor,
    registry,
  });
  const orchestrator: GitHubVerificationOrchestrator =
    createGitHubVerificationOrchestrator(
      queue,
      dependencies.createJobId !== undefined || dependencies.now !== undefined
        ? {
            ...(dependencies.createJobId !== undefined
              ? { createJobId: dependencies.createJobId }
              : {}),
            ...(dependencies.now !== undefined
              ? { now: dependencies.now }
              : {}),
          }
        : undefined,
    );

  const internalResultToken =
    typeof dependencies.internalResultToken === "string" &&
    dependencies.internalResultToken.trim().length > 0
      ? dependencies.internalResultToken.trim()
      : null;
  const resultReader: VerificationResultReader = {
    getByQueueJobId: (queueJobId: string) =>
      registry.getByQueueJobId(queueJobId) ?? null,
  };

  const apiListener = createVerificationRequestListener(
    applicationService,
    resultReader,
    internalResultToken === null ? {} : { internalResultToken },
  );
  const webhookListener = createConfiguredGitHubWebhookHandler({
    secret,
    replayGuard,
    orchestrator,
  });

  let accepting = false;
  let started = false;
  let listenPort = 0;
  let listenHost = "127.0.0.1";
  // Single-flight lifecycle transitions. At most one startup transition
  // and at most one shutdown transition exist at a time; concurrent
  // callers join the in-flight transition instead of executing a second
  // one. A shutdown always joins an in-flight startup first, so a
  // completed stop/close can never be followed by a stale startup
  // continuation resurrecting the service.
  let startupTransition: Promise<void> | null = null;
  let shutdownTransition: Promise<void> | null = null;

  const server: Server = createServer(
    (request: IncomingMessage, response: ServerResponse) => {
      const pathname = resolveWebhookPath(request.url);
      if (pathname === "/webhook") {
        if (!accepting) {
          sendShutdownJson(response);
          return;
        }
        void webhookListener(request, response);
        return;
      }
      void apiListener(request, response);
    },
  );

  // The composed service owns the consumption lifecycle: starting the
  // service starts automatic event-driven consumption; stopping it waits
  // for the current job, detaches the wakeup, and closes HTTP resources.
  // No caller is required to drive `processNext()` manually for the
  // composed service to work.

  // Batch 55A — lifecycle-owned Check publisher subscription. Exactly one
  // active subscription while started; none while stopped. Uses the same
  // single-flight start/stop transitions as the runtime (no second
  // runtime, no queue, no event-bus framework).
  const checkPublisher = dependencies?.checkPublisher ?? null;
  let checkPublisherUnsubscribe: (() => void) | null = null;

  function toCheckPublication(outcome: VerificationJobSettledOutcome): {
    readonly result: VerificationJobSettledOutcome extends never
      ? never
      : import("@verify-agent/domain").VerificationResult;
    readonly snapshot: import("@verify-agent/domain").RepositorySnapshot;
    readonly repository: { readonly owner: string; readonly name: string };
    readonly pullRequestNumber: number | undefined;
    readonly expectedHeadSha: string;
  } | null {
    if (outcome.kind !== "completed") return null;
    let reference: {
      readonly owner: string;
      readonly repository: string;
      readonly sha: string;
    };
    try {
      reference = decodeGitHubSnapshotReference(outcome.job.source.id);
    } catch {
      return null;
    }
    let snapshot: import("@verify-agent/domain").RepositorySnapshot;
    try {
      snapshot = createGitHubRepositorySnapshot({
        kind: "github-snapshot",
        owner: reference.owner,
        repository: reference.repository,
        sha: reference.sha,
      });
    } catch {
      return null;
    }
    const trigger = outcome.job.trigger as
      | { readonly kind?: unknown; readonly pullRequestNumber?: unknown }
      | undefined;
    const pullRequestNumber =
      typeof trigger?.pullRequestNumber === "number" &&
      Number.isInteger(trigger.pullRequestNumber) &&
      (trigger.pullRequestNumber as number) > 0
        ? (trigger.pullRequestNumber as number)
        : undefined;
    return {
      result: outcome.result,
      snapshot,
      repository: { owner: reference.owner, name: reference.repository },
      pullRequestNumber,
      expectedHeadSha: reference.sha.toLowerCase(),
    };
  }

  function handleSettledForChecks(
    outcome: VerificationJobSettledOutcome,
  ): void {
    if (!checkPublisher) return;
    const derived = toCheckPublication(outcome);
    if (!derived) return;
    // Publication failure must never corrupt verification truth:
    // no registry mutation, no result mutation, no retries, no secret
    // logging. The publisher already fails closed before network on
    // identity mismatches.
    void checkPublisher
      .publishVerificationResult({
        result: derived.result,
        snapshot: derived.snapshot,
        repository: derived.repository,
        ...(derived.pullRequestNumber === undefined
          ? {}
          : { pullRequestNumber: derived.pullRequestNumber }),
        expectedHeadSha: derived.expectedHeadSha,
      })
      .catch(() => {});
  }

  function attachCheckPublisher(): void {
    if (!checkPublisher) return;
    if (checkPublisherUnsubscribe !== null) return;
    checkPublisherUnsubscribe = runtime.onSettled(handleSettledForChecks);
  }

  function detachCheckPublisher(): void {
    if (checkPublisherUnsubscribe !== null) {
      try {
        checkPublisherUnsubscribe();
      } catch {
        // Unsubscribe must never break shutdown.
      }
      checkPublisherUnsubscribe = null;
    }
  }

  return {
    queue,
    runtime,
    processor,
    registry,
    resultReader,
    applicationService,
    orchestrator,
    replayGuard,
    server,
    isStarted: () => started,
    async start(port = 0, host = "127.0.0.1"): Promise<void> {
      // A shutdown in progress wins: join it, then start fresh from the
      // stopped state it leaves behind.
      const pendingShutdown = shutdownTransition;
      if (pendingShutdown !== null) {
        await pendingShutdown;
      }
      if (started) return;
      // Single-flight startup: concurrent callers share the one startup
      // transition (and its single bind) instead of binding twice.
      const inflight = startupTransition;
      if (inflight !== null) {
        return inflight;
      }
      const transition = (async (): Promise<void> => {
        listenPort = port;
        listenHost = host;
        accepting = true;
        runtime.startAutoProcessing();
        attachCheckPublisher();
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(listenPort, listenHost, () => {
              server.off("error", reject);
              resolve();
            });
          });
        } catch (error) {
          // Transactional startup: a failed bind must leave no background
          // work behind. Stop the runtime, detach the queue wakeup
          // listener AND the Check publisher callback, reset lifecycle
          // state, close any partially opened server resource, and rethrow
          // the original bind error.
          detachCheckPublisher();
          accepting = false;
          started = false;
          try {
            await runtime.stopAutoProcessing();
          } finally {
            runtime.stop();
          }
          if (server.listening) {
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
          }
          throw error;
        }
        started = true;
      })();
      startupTransition = transition;
      try {
        await transition;
      } finally {
        if (startupTransition === transition) {
          startupTransition = null;
        }
      }
    },
    async stop(): Promise<void> {
      const inflightShutdown = shutdownTransition;
      if (inflightShutdown !== null) {
        await inflightShutdown;
        return;
      }
      const transition = (async (): Promise<void> => {
        // Join an in-flight startup first: stop observes the startup's
        // own result, then tears down, so no stale startup continuation
        // can resurrect the service after this stop completes.
        const starting = startupTransition;
        if (starting !== null) {
          try {
            await starting;
          } catch {
            // The startup caller observes the failure; stop still
            // ensures the service ends stopped.
          }
        }
        accepting = false;
        detachCheckPublisher();
        await runtime.stopAutoProcessing();
        runtime.stop();
        started = false;
        await new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        });
      })();
      shutdownTransition = transition;
      try {
        await transition;
      } finally {
        if (shutdownTransition === transition) {
          shutdownTransition = null;
        }
      }
    },
    async close(): Promise<void> {
      const inflightShutdown = shutdownTransition;
      if (inflightShutdown !== null) {
        await inflightShutdown;
        return;
      }
      const transition = (async (): Promise<void> => {
        const starting = startupTransition;
        if (starting !== null) {
          try {
            await starting;
          } catch {
            // The startup caller observes the failure; close still
            // ensures the service ends stopped.
          }
        }
        accepting = false;
        detachCheckPublisher();
        await runtime.stopAutoProcessing();
        runtime.stop();
        started = false;
        await new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        });
      })();
      shutdownTransition = transition;
      try {
        await transition;
      } finally {
        if (shutdownTransition === transition) {
          shutdownTransition = null;
        }
      }
    },
    waitForQueueJob(
      queueJobId: string,
      options?: { readonly timeoutMs?: number },
    ): Promise<VerificationJobSettledOutcome> {
      return runtime.waitForQueueJob(queueJobId, options);
    },
    onSettled(
      listener: (outcome: VerificationJobSettledOutcome) => void,
    ): () => void {
      return runtime.onSettled(listener);
    },
  };
}

function readConfiguredPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw === "") return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function readConfiguredApiBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.GITHUB_API_BASE_URL;
  if (typeof raw !== "string" || raw.trim().length === 0) return undefined;
  return raw.trim();
}

/**
 * Batch 55B — configured GitHub Check publisher construction.
 *
 * Reuses the existing GitHub App authentication infrastructure (no second
 * JWT/token implementation, no `GITHUB_TOKEN`, no Batch 54A token mode):
 * `readGitHubAppConfig` → `createGitHubApiInstallationResolver` →
 * `createGitHubAppInstallationTokenClient` → `createGitHubCheckPublisher`.
 *
 * Fail-closed: absent/incomplete App configuration throws the existing
 * `GitHubAppConfigurationError` (diagnosable, no secrets) before any
 * network access; no publisher is fabricated and no token fallback occurs.
 */
export function createConfiguredGitHubCheckPublisher(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: { readonly fetch?: typeof globalThis.fetch },
): GitHubCheckPublisher {
  const appConfig = readGitHubAppConfig(env);
  const apiBaseUrl = readConfiguredApiBaseUrl(env);
  const fetch = overrides?.fetch ?? globalThis.fetch;
  const installationResolver = createGitHubApiInstallationResolver({
    appConfig,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    ...(fetch === undefined ? {} : { fetch }),
  });
  const installationTokenClient = createGitHubAppInstallationTokenClient({
    appConfig,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    ...(fetch === undefined ? {} : { fetch }),
  });
  return createGitHubCheckPublisher({
    appConfig,
    installationResolver,
    installationTokenClient,
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
    ...(fetch === undefined ? {} : { fetch }),
  });
}

export interface ConfiguredGitHubVerificationServiceOptions {
  readonly port?: number;
  readonly host?: string;
  /**
   * Batch 55B — composition seams for tests. Production calls with no
   * overrides: webhook secret/result token/port from `env` (default
   * `process.env`), sandbox-backed application service, global fetch.
   * Tests substitute a fake application service and/or stub fetch while
   * still exercising the configured publisher construction path.
   */
  readonly env?: NodeJS.ProcessEnv;
  readonly applicationService?: Pick<
    VerificationApplicationServiceType,
    "verifySource"
  >;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Normal configured startup for the Batch 51 single-process service.
 *
 * Reuses existing environment patterns: `GITHUB_WEBHOOK_SECRET` (required,
 * fail-closed), `VERIFY_INTERNAL_RESULT_TOKEN` (optional; when absent the
 * result route stays unavailable per Batch 50 fail-closed semantics),
 * GitHub App credentials where already supported, and the sandbox
 * transport configuration (`VERIFY_SANDBOX_PROCESS`). No second
 * configuration system, no hardcoded secrets, no secret exposure.
 *
 * Batch 55B — additionally constructs the GitHub App-authenticated Check
 * publisher from the same environment and wires it as the service's
 * single lifecycle-owned settled-result subscription, so real
 * webhook-triggered verification publishes a Check Run without any
 * caller-supplied publisher. Missing/incomplete App configuration fails
 * closed (no `GITHUB_TOKEN` fallback, no fabricated publisher).
 */
export async function startConfiguredGitHubVerificationService(
  options: ConfiguredGitHubVerificationServiceOptions = {},
): Promise<GitHubVerificationService> {
  const env = options.env ?? process.env;
  const secret = readGitHubWebhookSecret(env);
  const internalResultToken = readInternalResultToken(env);
  const applicationService =
    options.applicationService ?? createConfiguredApplicationService();
  const checkPublisher = createConfiguredGitHubCheckPublisher(
    env,
    options.fetch === undefined ? undefined : { fetch: options.fetch },
  );
  const service = createGitHubVerificationService({
    applicationService,
    secret,
    ...(internalResultToken === null ? {} : { internalResultToken }),
    checkPublisher,
  });
  const port = options.port ?? readConfiguredPort(env);
  const host = options.host ?? "0.0.0.0";
  await service.start(port, host);
  return service;
}
