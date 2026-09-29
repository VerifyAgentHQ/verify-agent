import {
  InvalidSourceReferenceError,
  type CheckResult,
  type RepositorySnapshot,
  type VerificationResult,
  type VerificationStatus,
} from "@verify-agent/domain";
import {
  validateGitHubSnapshotReference,
  type GitHubSnapshotReference,
} from "./github.js";
import type {
  GitHubAppConfig,
  GitHubAppInstallationTokenClient,
  GitHubInstallationResolver,
} from "./github-app.js";

/**
 * Batch 55 — VerificationResult → GitHub Check Run publication.
 *
 * Exposes the completed deterministic `VerificationResult` back to GitHub
 * as a Check Run attached to the exact verified commit:
 *
 * ```text
 * VerificationResult (+ snapshot SHAs)
 *     ↓ GitHubCheckPublisher (GitHub App installation authentication)
 * POST/PATCH /repos/{owner}/{repo}/check-runs
 *     ↓ human-visible PR verification summary
 * ```
 *
 * Boundaries:
 * - Only the existing GitHub App installation path authenticates
 *   publication. Ambient personal-token modes are never consulted here.
 * - The Check Run is derived from the existing result model; no second
 *   result model, no findings invented, no source contents included.
 * - Verification truth stays separate from publication status: a GitHub
 *   API failure never mutates the result.
 *
 * Batch 55A hardening (same file, no second publisher):
 * - Identity is bound before any network: result.snapshotId, snapshot
 *   commit/source/reference, repository owner/name, and exact head SHA
 *   must agree via the canonical GitHub snapshot identity.
 * - Publication is serialized per repository + check name + exact SHA
 *   with a process-local promise chain (no DB, no distributed locks).
 * - Freshness uses VerifyAgent's own result.createdAt + contentHash;
 *   GitHub Check Run IDs are never freshness markers. Older results
 *   cannot overwrite newer ones for the same key.
 *
 * Batch 55B bounding (same file):
 * - Freshness state is bounded (`maxFreshnessEntries`, LRU eviction).
 *
 * Batch 55C persistence (same file, same API client and auth boundary):
 * - Every created/updated Check Run carries a versioned freshness marker
 *   in `external_id` (`verifyagent:v1:<createdAtMs>:<contentHash>`).
 * - The remote marker is the restart/eviction-safe freshness authority:
 *   an existing run is never mutated before its marker is read, parsed,
 *   and compared. Missing/malformed markers fail closed.
 * - The bounded local LRU remains as a fast-path optimization only.
 * - Serialization stays process-local; no distributed locking is claimed.
 *
 * Batch 55D ownership (same file):
 * - Only Check Runs whose `app.id` equals the configured VerifyAgent App
 *   ID are trusted or updated. Foreign-App runs are ignored: never
 *   selected, never PATCHed, their `external_id` never trusted. With no
 *   owned run, publication creates a VerifyAgent-owned run instead.
 */

export const VERIFY_AGENT_CHECK_NAME = "VerifyAgent / verification";

const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;

export type GitHubCheckConclusion = "success" | "failure" | "neutral";

export class GitHubCheckPublicationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "GitHubCheckPublicationError";
    if (options?.cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = options.cause;
    }
  }
}

export class StaleVerificationResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleVerificationResultError";
  }
}

/**
 * Deterministic mapping from existing verification semantics to a GitHub
 * Check Run conclusion. Documented contract:
 *
 * - `pass` → `success`: all required checks passed with real provenance
 *   and complete coverage (the aggregation guarantees no partial,
 *   unsupported, simulated, or fixture remainder).
 * - `blocked` → `failure`: a required check failed or policy blocked.
 * - `needs_changes` → `neutral`: completed but not passing (unsupported
 *   capability or non-real execution). Never presented as a pass.
 * - `needs_review` → `neutral`: a medium finding requests human review.
 *   Never presented as a pass.
 * - `partial` → `neutral`: applicable checks remain unverified. Partial
 *   coverage is preserved as-is and never transformed into a pass claim.
 * - `error` → `failure`: verification errored and did not complete; the
 *   title/summary say so explicitly.
 */
export function mapVerificationStatusToCheckConclusion(
  status: VerificationStatus,
): GitHubCheckConclusion {
  switch (status) {
    case "pass":
      return "success";
    case "blocked":
    case "error":
      return "failure";
    case "needs_changes":
    case "needs_review":
    case "partial":
      return "neutral";
    default:
      throw new GitHubCheckPublicationError(
        `unknown verification status: ${String(status)}`,
      );
  }
}

export interface VerificationCheckRepository {
  readonly owner: string;
  readonly name: string;
}

export interface RenderVerificationCheckOutputInput {
  readonly result: VerificationResult;
  readonly snapshot: RepositorySnapshot;
  readonly repository: VerificationCheckRepository;
  readonly pullRequestNumber?: number;
  /**
   * Optional full check results for per-check outcome lines. The composed
   * runtime path carries only result IDs, so this enrichment is best-effort:
   * when absent, coverage buckets remain the authoritative listing and
   * nothing is invented.
   */
  readonly checkResults?: readonly CheckResult[];
}

export interface GitHubCheckOutput {
  readonly title: string;
  readonly summary: string;
  readonly text: string;
}

function statusMeaning(status: VerificationStatus): string {
  switch (status) {
    case "pass":
      return "All required checks passed with real provenance and complete coverage.";
    case "blocked":
      return "A required check failed or policy blocked the verification.";
    case "needs_changes":
      return "Completed but not passing: unsupported capability or non-real execution. Not a pass.";
    case "needs_review":
      return "A finding requests human review. Not a pass.";
    case "partial":
      return "Applicable checks remain unverified. Partial coverage is not a pass.";
    case "error":
      return "Verification errored and did not complete.";
    default:
      return "Unknown verification status.";
  }
}

function bucketLabel(values: readonly string[]): string {
  return values.length === 0 ? "none" : [...values].sort().join(", ");
}

function provenanceNote(result: VerificationResult): string {
  const simulated = [...result.coverage.simulated, ...result.coverage.fixture];
  if (simulated.length > 0) {
    return `Synthetic execution present (${bucketLabel(simulated)}); not fully real provenance.`;
  }
  if (result.coverage.verified.length > 0) {
    return "Passing checks ran with real sandbox provenance.";
  }
  return "No passing checks with real provenance.";
}

/**
 * Renders deterministic human-visible Check Run content from the
 * VerificationResult. Only identifiers, statuses, counts, and coverage
 * buckets are included — never source contents, tokens, keys, secrets,
 * filesystem paths, or sandbox internals.
 */
export function renderVerificationCheckOutput(
  input: RenderVerificationCheckOutputInput,
): GitHubCheckOutput {
  const { result, snapshot, repository } = input;
  const headSha = snapshot.sourceState.value.toLowerCase();
  const coverage = result.coverage;
  const title = `VerifyAgent verification: ${result.status}`;
  const summaryLines = [
    `Verified commit: ${headSha}`,
    `Status: ${result.status} — ${statusMeaning(result.status)}`,
    `Result summary: ${result.summary}`,
    `Checks verified (passed, real provenance): ${bucketLabel(coverage.verified)}`,
    `Checks not verified: ${bucketLabel(coverage.partial)}`,
    `Unsupported checks: ${bucketLabel(coverage.unsupported)}`,
    `Not applicable checks: ${bucketLabel(coverage.notApplicable)}`,
    `Findings: ${result.findingReferences.length}`,
    `Provenance: ${provenanceNote(result)}`,
    `Verification: ${String(result.id)} (result version ${result.resultVersion})`,
  ];
  const detailLines = [
    `Repository: ${repository.owner}/${repository.name}`,
    ...(input.pullRequestNumber === undefined
      ? []
      : [`Pull request: #${input.pullRequestNumber}`]),
    `Verified commit SHA: ${headSha}`,
    `Snapshot identity: ${String(snapshot.id)}`,
    `Verification ID: ${String(result.id)}`,
    `Verification job ID: ${String(result.jobId)}`,
    `Policy decision: ${String(result.policyDecision)}`,
    `Coverage verified: ${bucketLabel(coverage.verified)}`,
    `Coverage not verified: ${bucketLabel(coverage.partial)}`,
    `Coverage unsupported: ${bucketLabel(coverage.unsupported)}`,
    `Coverage not applicable: ${bucketLabel(coverage.notApplicable)}`,
  ];
  if (input.checkResults !== undefined) {
    const ordered = [...input.checkResults].sort((a, b) =>
      String(a.checkId) < String(b.checkId)
        ? -1
        : String(a.checkId) > String(b.checkId)
          ? 1
          : 0,
    );
    for (const check of ordered) {
      detailLines.push(
        `Check ${String(check.checkId)}: ${check.status} ` +
          `(exit ${check.exitCode ?? "n/a"}, ${check.durationMs}ms, ${check.executionSource})`,
      );
    }
  }
  if (result.findingReferences.length > 0) {
    detailLines.push(
      `Finding references: ${result.findingReferences.map(String).sort().join(", ")}`,
    );
    detailLines.push(
      "Finding details live in the protected VerifyAgent result; this check mirrors the result only.",
    );
  }
  detailLines.push(
    `Verification truth lives in VerifyAgent result ${String(result.id)}; this Check Run mirrors that result for commit ${headSha}.`,
  );
  return {
    title,
    summary: summaryLines.join("\n"),
    text: detailLines.join("\n"),
  };
}

export interface PublishVerificationResultInput {
  readonly result: VerificationResult;
  readonly snapshot: RepositorySnapshot;
  readonly repository: VerificationCheckRepository;
  readonly pullRequestNumber?: number;
  readonly checkResults?: readonly CheckResult[];
  /**
   * Optional current PR head SHA. When provided and different from the
   * result's own commit, publication is refused: a result for A must never
   * be published as the verification of B. Timestamps are never consulted.
   */
  readonly expectedHeadSha?: string;
}

export interface GitHubCheckPublication {
  readonly checkRunId: number;
  readonly headSha: string;
  readonly conclusion: GitHubCheckConclusion;
  readonly created: boolean;
}

export interface GitHubCheckPublisherOptions {
  readonly appConfig: GitHubAppConfig;
  readonly installationResolver: GitHubInstallationResolver;
  readonly installationTokenClient: GitHubAppInstallationTokenClient;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly checkName?: string;
  /**
   * Batch 55B — bounds process-local freshness state (`latestByKey`).
   * Must be a positive integer when provided; defaults to
   * `DEFAULT_MAX_FRESHNESS_ENTRIES`. Least-recently-published keys are
   * evicted first; evicted keys lose historical stale protection (same
   * class of limitation as process restart).
   */
  readonly maxFreshnessEntries?: number;
}

/**
 * Batch 55B — default bound for process-local Check publication
 * freshness state. Covers bursts of distinct pull-request SHAs with a
 * few kilobytes of memory; per-key serialization chains remain
 * self-cleaning regardless of this bound.
 */
export const DEFAULT_MAX_FRESHNESS_ENTRIES = 500;

export interface GitHubCheckPublisher {
  publishVerificationResult(
    input: PublishVerificationResultInput,
  ): Promise<GitHubCheckPublication>;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";

function normalizeApiBaseUrl(value?: string): string {
  const base = (value ?? DEFAULT_API_BASE_URL).trim().replace(/\/+$/, "");
  if (base.length === 0) return DEFAULT_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new GitHubCheckPublicationError("invalid GitHub API base URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new GitHubCheckPublicationError(
      "GitHub API base URL must be http(s)",
    );
  }
  if (url.username || url.password || base.includes("..")) {
    throw new GitHubCheckPublicationError(
      "GitHub API base URL must not contain credentials or traversal",
    );
  }
  return base;
}

function resolveHeadSha(snapshot: RepositorySnapshot): string {
  const state = snapshot?.sourceState;
  if (
    !state ||
    state.type !== "commit" ||
    typeof state.value !== "string" ||
    !COMMIT_SHA_RE.test(state.value.toLowerCase())
  ) {
    throw new InvalidSourceReferenceError(
      "snapshot identity is not an exact commit SHA",
    );
  }
  return state.value.toLowerCase();
}

/**
 * Batch 55A — canonical identity binding.
 *
 * Reuses the single existing GitHub source identity model
 * (`validateGitHubSnapshotReference` + `createGitHubRepositorySnapshot`
 * id scheme `owner--repository--sha`):
 *
 * ```text
 * result.snapshotId === snapshot.id
 * snapshot.source.reference === exact commit SHA
 * snapshot.commitSha === exact commit SHA
 * snapshot.sourceState === { type: "commit", value: exact SHA }
 * snapshot.projectId === owner--repository
 * snapshot.id === projectId--exact SHA
 * repository argument === same owner/repository
 * expectedHeadSha (when given) === exact SHA
 * ```
 *
 * All checks run before any GitHub network access and use generic
 * messages (no tokens, keys, secrets, or source contents).
 */
function assertPublicationIdentity(
  result: VerificationResult,
  snapshot: RepositorySnapshot,
  repository: VerificationCheckRepository,
  headSha: string,
): void {
  const fail = (): never => {
    throw new GitHubCheckPublicationError(
      "verification result snapshot identity mismatch",
    );
  };
  if (!result || !snapshot || !repository) {
    throw new GitHubCheckPublicationError(
      "verification result, snapshot, and repository are required",
    );
  }
  // result.snapshotId must be exactly the snapshot that produced it.
  if (String(result.snapshotId) !== String(snapshot.id)) {
    fail();
  }
  // result.projectId must agree with the snapshot's project.
  if (String(result.projectId) !== String(snapshot.projectId)) {
    fail();
  }
  // Snapshot must be a GitHub commit snapshot for the exact SHA.
  const source = snapshot.source as unknown as {
    provider?: unknown;
    reference?: unknown;
  };
  if (!source || source.provider !== "github") {
    fail();
  }
  const sourceReference = (source as { reference?: unknown }).reference;
  if (
    typeof sourceReference !== "string" ||
    sourceReference.toLowerCase() !== headSha
  ) {
    fail();
  }
  // commitSha is the canonical immutable commit field: when present it
  // must agree; for GitHub publication it is required.
  const commitSha = (snapshot as { commitSha?: unknown }).commitSha;
  if (typeof commitSha !== "string" || commitSha.toLowerCase() !== headSha) {
    fail();
  }
  // Canonical id scheme from createGitHubRepositorySnapshot:
  // projectId === owner--repository, id === projectId--sha.
  // Owner/repository comparison is case-insensitive (GitHub is), SHA is
  // already lowercase exact.
  const ownerLower = repository.owner.toLowerCase();
  const nameLower = repository.name.toLowerCase();
  const projectLower = String(snapshot.projectId).toLowerCase();
  if (projectLower !== `${ownerLower}--${nameLower}`) {
    fail();
  }
  const idLower = String(snapshot.id).toLowerCase();
  if (idLower !== `${ownerLower}--${nameLower}--${headSha}`) {
    fail();
  }
}

/**
 * Batch 55C — versioned freshness marker persisted in the Check Run
 * `external_id` field.
 *
 * - Deterministic: derived solely from the VerificationResult's own
 *   `createdAt` milliseconds + `contentHash` (the existing ordering).
 * - Versioned (`verifyagent:v1:...`) so future formats fail closed as
 *   unknown instead of miscomparing.
 * - Bounded: at most a few hundred characters; hash segment charset
 *   excludes `:` so parsing is unambiguous.
 * - Free of secrets, paths, credentials, branch/PR/process state.
 */
export const VERIFY_AGENT_FRESHNESS_MARKER_VERSION = "v1";

const FRESHNESS_MARKER_PREFIX = "verifyagent";
const FRESHNESS_MARKER_MAX_LENGTH = 512;
const FRESHNESS_MARKER_HASH_RE = /^[A-Za-z0-9._-]{1,256}$/;

export interface VerificationFreshness {
  readonly createdAtMs: number;
  readonly contentHash: string;
}

export function formatVerificationFreshnessMarker(ordering: {
  readonly createdAtMs: number;
  readonly contentHash: string;
}): string {
  if (
    typeof ordering?.createdAtMs !== "number" ||
    !Number.isSafeInteger(ordering.createdAtMs) ||
    ordering.createdAtMs < 0 ||
    typeof ordering?.contentHash !== "string" ||
    !FRESHNESS_MARKER_HASH_RE.test(ordering.contentHash)
  ) {
    throw new GitHubCheckPublicationError(
      "verification result ordering cannot be represented as a freshness marker",
    );
  }
  return `${FRESHNESS_MARKER_PREFIX}:${VERIFY_AGENT_FRESHNESS_MARKER_VERSION}:${ordering.createdAtMs}:${ordering.contentHash}`;
}

export function parseVerificationFreshnessMarker(
  value: unknown,
): VerificationFreshness | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > FRESHNESS_MARKER_MAX_LENGTH
  ) {
    return null;
  }
  const parts = value.split(":");
  if (parts.length !== 4) return null;
  const [prefix, version, msRaw, hash] = parts as [
    string,
    string,
    string,
    string,
  ];
  if (
    prefix !== FRESHNESS_MARKER_PREFIX ||
    version !== VERIFY_AGENT_FRESHNESS_MARKER_VERSION
  ) {
    return null;
  }
  if (!/^\d+$/.test(msRaw as string)) return null;
  const createdAtMs = Number(msRaw);
  if (!Number.isSafeInteger(createdAtMs) || createdAtMs < 0) return null;
  if (!FRESHNESS_MARKER_HASH_RE.test(hash as string)) return null;
  return { createdAtMs, contentHash: hash as string };
}

/**
 * Batch 55B/55C ordering: `createdAtMs` first, `contentHash` as the
 * deterministic tie-break. Returns -1 (older), 0 (identical), 1 (newer).
 */
export function compareVerificationFreshness(
  incoming: VerificationFreshness,
  known: VerificationFreshness,
): -1 | 0 | 1 {
  if (incoming.createdAtMs !== known.createdAtMs) {
    return incoming.createdAtMs < known.createdAtMs ? -1 : 1;
  }
  if (incoming.contentHash === known.contentHash) return 0;
  return incoming.contentHash < known.contentHash ? -1 : 1;
}

function resolveRepository(
  repository: VerificationCheckRepository,
  headSha: string,
): GitHubSnapshotReference {
  const reference: GitHubSnapshotReference = {
    kind: "github-snapshot",
    owner: repository.owner,
    repository: repository.name,
    sha: headSha,
  };
  try {
    validateGitHubSnapshotReference(reference);
  } catch (error) {
    throw new GitHubCheckPublicationError(
      "invalid GitHub repository or commit identity",
      { cause: error },
    );
  }
  return reference;
}

export function createGitHubCheckPublisher(
  options: GitHubCheckPublisherOptions,
): GitHubCheckPublisher {
  const appConfig = options?.appConfig;
  if (
    !appConfig ||
    typeof appConfig.appId !== "string" ||
    typeof appConfig.privateKey !== "string"
  ) {
    throw new GitHubCheckPublicationError(
      "GitHub App configuration is required",
    );
  }
  // Batch 55D — the configured VerifyAgent App ID is the Check Run
  // ownership authority. It must be established here, fail-closed, or no
  // publication can validate ownership. Same numeric-ID convention as
  // `readGitHubAppConfig`; never derived from tokens, usernames, check
  // names, or installation IDs.
  const expectedAppIdRaw =
    typeof appConfig.appId === "string" ? appConfig.appId.trim() : "";
  if (!/^[0-9]+$/.test(expectedAppIdRaw)) {
    throw new GitHubCheckPublicationError(
      "GitHub App configuration is required",
    );
  }
  const expectedAppId = Number(expectedAppIdRaw);
  if (!Number.isSafeInteger(expectedAppId) || expectedAppId <= 0) {
    throw new GitHubCheckPublicationError(
      "GitHub App configuration is required",
    );
  }
  const installationResolver = options.installationResolver;
  if (
    !installationResolver ||
    typeof installationResolver.resolveInstallationId !== "function"
  ) {
    throw new GitHubCheckPublicationError("installation resolver is required");
  }
  const installationTokenClient = options.installationTokenClient;
  if (
    !installationTokenClient ||
    typeof installationTokenClient.createInstallationToken !== "function"
  ) {
    throw new GitHubCheckPublicationError(
      "installation token client is required",
    );
  }
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new GitHubCheckPublicationError("fetch is not available");
  }
  const checkName =
    typeof options.checkName === "string" && options.checkName.trim().length > 0
      ? options.checkName.trim()
      : VERIFY_AGENT_CHECK_NAME;
  const maxFreshnessEntries =
    options?.maxFreshnessEntries ?? DEFAULT_MAX_FRESHNESS_ENTRIES;
  if (!Number.isInteger(maxFreshnessEntries) || maxFreshnessEntries <= 0) {
    throw new GitHubCheckPublicationError(
      "maxFreshnessEntries must be a positive integer",
    );
  }

  /**
   * Batch 55A — process-local publication serialization + monotonicity.
   *
   * - Serialization key: repository owner/name + check name + exact head
   *   SHA. Different SHAs remain independently publishable; the same
   *   key never executes its GET → PATCH/POST decision concurrently.
   * - Freshness authority (Batch 55C): the persisted `external_id` marker
   *   on the remote Check Run. VerifyAgent's own `result.createdAt` with
   *   a deterministic `contentHash` tie-break remains the ordering, but
   *   GitHub Check Run IDs are resource creation markers and are never
   *   used as freshness proof.
   * - The bounded local LRU is a fast-path optimization only.
   * - No database, no distributed locks, no queue. Serialization is
   *   process-local; only the freshness marker survives restarts.
   */
  const publicationChains = new Map<string, Promise<void>>();
  const latestByKey = new Map<
    string,
    { readonly createdAtMs: number; readonly contentHash: string }
  >();

  function publicationKey(
    owner: string,
    repository: string,
    headSha: string,
  ): string {
    return `${owner.toLowerCase()}/${repository.toLowerCase()}/${headSha}/${checkName}`;
  }

  function runSerialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = publicationChains.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work);
    const tail = task.then(
      () => {},
      () => {},
    );
    publicationChains.set(key, tail);
    tail.finally(() => {
      if (publicationChains.get(key) === tail) {
        publicationChains.delete(key);
      }
    });
    return task;
  }

  function readResultOrdering(result: VerificationResult): {
    readonly createdAtMs: number;
    readonly contentHash: string;
  } {
    const rawCreatedAt = (result as { createdAt?: unknown }).createdAt;
    const createdAtMs =
      typeof rawCreatedAt === "string" ? Date.parse(rawCreatedAt) : NaN;
    if (!Number.isFinite(createdAtMs)) {
      throw new GitHubCheckPublicationError(
        "verification result ordering is unavailable",
      );
    }
    const rawHash = (result as { contentHash?: unknown }).contentHash;
    const contentHash =
      typeof rawHash === "string" && rawHash.length > 0
        ? rawHash
        : String(result.id);
    return { createdAtMs, contentHash };
  }

  function scrub(error: unknown): GitHubCheckPublicationError {
    if (error instanceof GitHubCheckPublicationError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new GitHubCheckPublicationError(
      `GitHub Check Run request failed: ${message}`,
      { cause: error },
    );
  }

  async function requestJson(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    let response: Response;
    try {
      response = await fetchFn(`${apiBaseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "verify-agent",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
      });
    } catch (error) {
      throw scrub(error);
    }
    let data: unknown = undefined;
    try {
      data = await response.json();
    } catch {
      data = undefined;
    }
    return { status: response.status, data };
  }

  function requireOk(
    status: number,
    data: unknown,
    action: string,
  ): asserts data is Record<string, unknown> {
    if (status === 401 || status === 403) {
      throw new GitHubCheckPublicationError(
        `GitHub Check Run ${action} not authorized (installation token rejected)`,
      );
    }
    if (status === 404) {
      throw new GitHubCheckPublicationError(
        `GitHub Check Run ${action} target not found`,
      );
    }
    if (status === 429) {
      throw new GitHubCheckPublicationError(
        `GitHub Check Run ${action} rate limited (no retries attempted)`,
      );
    }
    if (status < 200 || status >= 300) {
      throw new GitHubCheckPublicationError(
        `GitHub Check Run ${action} failed with status ${status}`,
      );
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new GitHubCheckPublicationError(
        `GitHub Check Run ${action} returned an invalid response`,
      );
    }
  }

  async function acquireInstallationToken(
    owner: string,
    repository: string,
  ): Promise<string> {
    let installationId: number;
    try {
      installationId = await installationResolver.resolveInstallationId(
        owner,
        repository,
      );
    } catch (error) {
      throw new GitHubCheckPublicationError(
        "GitHub App installation lookup failed",
        { cause: error },
      );
    }
    let token: string;
    try {
      const created =
        await installationTokenClient.createInstallationToken(installationId);
      token = created.token;
    } catch (error) {
      throw new GitHubCheckPublicationError(
        "GitHub App installation token acquisition failed",
        { cause: error },
      );
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new GitHubCheckPublicationError(
        "GitHub App installation token acquisition failed",
      );
    }
    return token.trim();
  }

  /**
   * Batch 55C — locate the existing run for this key and surface its
   * persisted freshness marker. The max Check Run ID selects which
   * GitHub resource to update; it is never used as freshness proof.
   *
   * Batch 55D — ownership filter: only runs whose `app.id` equals the
   * configured VerifyAgent App ID are candidates. Foreign-App runs are
   * ignored entirely: their `external_id` is never trusted and they are
   * never selected for update. Max-ID selection applies only within the
   * VerifyAgent-owned candidate set. With no owned run, the caller takes
   * the create path and mints a VerifyAgent-owned Check Run.
   */
  function isVerifyAgentOwnedRun(run: { readonly app?: unknown }): boolean {
    const app = run.app;
    if (typeof app !== "object" || app === null || Array.isArray(app)) {
      return false;
    }
    return (app as { id?: unknown }).id === expectedAppId;
  }

  async function findExistingCheckRun(
    token: string,
    owner: string,
    repository: string,
    headSha: string,
  ): Promise<
    { readonly id: number; readonly externalId: unknown } | undefined
  > {
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/commits/${encodeURIComponent(headSha)}/check-runs` +
      `?check_name=${encodeURIComponent(checkName)}&per_page=100`;
    const { status, data } = await requestJson(token, "GET", path);
    requireOk(status, data, "lookup");
    const runs = (data as { check_runs?: unknown }).check_runs;
    if (!Array.isArray(runs)) return undefined;
    let latest:
      { readonly id: number; readonly externalId: unknown } | undefined;
    for (const run of runs) {
      if (
        typeof run === "object" &&
        run !== null &&
        (run as { name?: unknown }).name === checkName &&
        typeof (run as { id?: unknown }).id === "number" &&
        isVerifyAgentOwnedRun(run as { app?: unknown })
      ) {
        const id = (run as { id: number }).id;
        if (latest === undefined || id > latest.id) {
          latest = {
            id,
            externalId: (run as { external_id?: unknown }).external_id,
          };
        }
      }
    }
    return latest;
  }

  async function createCheckRun(
    token: string,
    owner: string,
    repository: string,
    headSha: string,
    conclusion: GitHubCheckConclusion,
    output: GitHubCheckOutput,
    freshnessMarker: string,
  ): Promise<number> {
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/check-runs`;
    const { status, data } = await requestJson(token, "POST", path, {
      name: checkName,
      head_sha: headSha,
      status: "completed",
      conclusion,
      external_id: freshnessMarker,
      output: {
        title: output.title,
        summary: output.summary,
        text: output.text,
      },
    });
    requireOk(status, data, "creation");
    const id = (data as { id?: unknown }).id;
    if (typeof id !== "number") {
      throw new GitHubCheckPublicationError(
        "GitHub Check Run creation returned an invalid response",
      );
    }
    return id;
  }

  async function updateCheckRun(
    token: string,
    owner: string,
    repository: string,
    checkRunId: number,
    conclusion: GitHubCheckConclusion,
    output: GitHubCheckOutput,
    freshnessMarker: string,
  ): Promise<number | undefined> {
    const path =
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}` +
      `/check-runs/${encodeURIComponent(String(checkRunId))}`;
    const { status, data } = await requestJson(token, "PATCH", path, {
      conclusion,
      external_id: freshnessMarker,
      output: {
        title: output.title,
        summary: output.summary,
        text: output.text,
      },
    });
    if (status === 404) return undefined;
    requireOk(status, data, "update");
    const id = (data as { id?: unknown }).id;
    if (typeof id !== "number") {
      throw new GitHubCheckPublicationError(
        "GitHub Check Run update returned an invalid response",
      );
    }
    return id;
  }

  return {
    async publishVerificationResult(
      input: PublishVerificationResultInput,
    ): Promise<GitHubCheckPublication> {
      if (!input || !input.result || !input.snapshot || !input.repository) {
        throw new GitHubCheckPublicationError(
          "verification result, snapshot, and repository are required",
        );
      }
      // Exact commit binding: the SHA comes from the snapshot that produced
      // the result — never a branch, workspace, or timestamp.
      const headSha = resolveHeadSha(input.snapshot);
      resolveRepository(input.repository, headSha);
      // Batch 55A identity: result ↔ snapshot ↔ repository ↔ exact SHA
      // must agree before any network access.
      assertPublicationIdentity(
        input.result,
        input.snapshot,
        input.repository,
        headSha,
      );
      if (
        input.expectedHeadSha !== undefined &&
        input.expectedHeadSha.toLowerCase() !== headSha
      ) {
        throw new StaleVerificationResultError(
          "verification result is not for the expected commit",
        );
      }
      const conclusion = mapVerificationStatusToCheckConclusion(
        input.result.status,
      );
      const output = renderVerificationCheckOutput({
        result: input.result,
        snapshot: input.snapshot,
        repository: input.repository,
        ...(input.pullRequestNumber === undefined
          ? {}
          : { pullRequestNumber: input.pullRequestNumber }),
        ...(input.checkResults === undefined
          ? {}
          : { checkResults: input.checkResults }),
      });
      const ordering = readResultOrdering(input.result);
      // Batch 55C — the persisted marker is derived from the result alone
      // (no wall clock, branch, PR, or process state). Formatting is pure
      // and local, so an unrepresentable ordering fails before any network.
      const freshnessMarker = formatVerificationFreshnessMarker(ordering);
      const key = publicationKey(
        input.repository.owner,
        input.repository.name,
        headSha,
      );
      return runSerialized(key, async () => {
        // Batch 55B local fast path (optimization only, not authority):
        // the remote marker is monotonic non-decreasing through this
        // publisher, so an input older than our own last success is
        // provably stale without consulting the network.
        const remembered = latestByKey.get(key);
        if (
          remembered !== undefined &&
          compareVerificationFreshness(ordering, remembered) < 0
        ) {
          throw new StaleVerificationResultError(
            "stale verification result cannot overwrite a newer result",
          );
        }
        const token = await acquireInstallationToken(
          input.repository.owner,
          input.repository.name,
        );
        const existing = await findExistingCheckRun(
          token,
          input.repository.owner,
          input.repository.name,
          headSha,
        );
        let publication: GitHubCheckPublication;
        if (existing !== undefined) {
          // Batch 55C — the remote marker is authoritative across LRU
          // eviction and process restarts. A missing/malformed marker
          // fails closed before any mutation so an old result can never
          // overwrite state whose ordering cannot be established.
          const remote = parseVerificationFreshnessMarker(existing.externalId);
          if (remote === null) {
            throw new GitHubCheckPublicationError(
              "existing GitHub Check Run has missing or unrecognized freshness metadata; refusing to overwrite",
            );
          }
          const comparison = compareVerificationFreshness(ordering, remote);
          if (comparison < 0) {
            throw new StaleVerificationResultError(
              "stale verification result cannot overwrite a newer result",
            );
          }
          // Newer or identical: update and persist the (possibly same)
          // marker. Identical inputs stay idempotent on one Check Run.
          const updated = await updateCheckRun(
            token,
            input.repository.owner,
            input.repository.name,
            existing.id,
            conclusion,
            output,
            freshnessMarker,
          );
          if (updated !== undefined) {
            publication = {
              checkRunId: updated,
              headSha,
              conclusion,
              created: false,
            };
          } else {
            const created = await createCheckRun(
              token,
              input.repository.owner,
              input.repository.name,
              headSha,
              conclusion,
              output,
              freshnessMarker,
            );
            publication = {
              checkRunId: created,
              headSha,
              conclusion,
              created: true,
            };
          }
        } else {
          const created = await createCheckRun(
            token,
            input.repository.owner,
            input.repository.name,
            headSha,
            conclusion,
            output,
            freshnessMarker,
          );
          publication = {
            checkRunId: created,
            headSha,
            conclusion,
            created: true,
          };
        }
        // Remember only on success: a failed publication never advances
        // freshness, so a retry with the same result remains publishable.
        // GitHub Check Run IDs are not freshness markers and are not
        // stored here. Batch 55B: bounded LRU — refresh recency on
        // republish, evict least-recently-published keys first. Batch 55C:
        // evicted keys keep protection via the persisted remote marker;
        // the LRU is a fast-path optimization only.
        if (latestByKey.has(key)) {
          latestByKey.delete(key);
        } else {
          while (latestByKey.size >= maxFreshnessEntries) {
            const oldest = latestByKey.keys().next().value as
              string | undefined;
            if (oldest === undefined) break;
            latestByKey.delete(oldest);
          }
        }
        latestByKey.set(key, ordering);
        return publication;
      });
    },
  };
}
