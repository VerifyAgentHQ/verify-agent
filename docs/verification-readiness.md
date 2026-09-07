# Verification Readiness Audit

Date: 2026-09-05

This document is the authoritative audit of what VerifyAgent genuinely supports today, what remains missing, and the smallest end-to-end path needed to produce a real trustworthy verification result against a GitHub repository.

> Passing VerifyAgent's unit/integration tests does not by itself prove that VerifyAgent correctly verifies arbitrary repositories. Unit tests prove implementation correctness of individual boundaries. Verification-system correctness requires a truth-test matrix against known repository outcomes.

---

## 1. Current state

VerifyAgent is a TypeScript monorepo (pnpm workspaces) in Phase 0 bootstrap. It establishes a strict domain model, compile-safe interfaces, provider-neutral orchestration, and multiple boundary implementations that are individually well-tested.

### What actually exists

| Package                    | Status                    | Detail                                                                                                                                                                                         |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/domain`          | FULLY IMPLEMENTED         | 19 source files. Branded IDs, validation, immutability, entity model. ~750+ lines.                                                                                                             |
| `packages/engine`          | 13/14 IMPLEMENTED         | Pipeline, execution, aggregation, application service, dependency provisioning, generated artifacts, environment materializer. Only `runtime.ts` is a legacy stub.                             |
| `packages/checks`          | FULLY IMPLEMENTED         | 11 check definitions, deterministic planner, 8 execution specs mapping IDs to commands; 3 defined checks (`dependency.audit`, `security.analysis`, `license.analysis`) await executable specs. |
| `packages/policy`          | FULLY IMPLEMENTED         | Deterministic default policy evaluator with 5 rules. Provider-independent.                                                                                                                     |
| `packages/ai`              | SERVICE LAYER IMPLEMENTED | Provider-neutral prompt construction, output validation, contradiction detection, caching. No provider SDK installed (by design).                                                              |
| `packages/config`          | TYPE DEFINITIONS ONLY     | Interface definitions for `VerificationConfig` and `AppConfig`.                                                                                                                                |
| `packages/adapters-lang`   | FULLY IMPLEMENTED         | TypeScript + Rust detectors, filesystem + memory detection contexts.                                                                                                                           |
| `packages/adapters-source` | FULLY IMPLEMENTED         | GitHub API provider, GitHub App JWT auth, PR event parsing, fixture/in-memory providers.                                                                                                       |
| `packages/goat`            | PLACEHOLDER               | Single 4-line file reserving namespace.                                                                                                                                                        |
| `apps/api`                 | FULLY IMPLEMENTED         | HTTP server (raw Node.js `http`), full wiring, health + verify endpoints.                                                                                                                      |
| `apps/github-bot`          | FULLY IMPLEMENTED         | Webhook HMAC-SHA256 verification, replay guard, orchestrator, production composition.                                                                                                          |
| `apps/worker`              | FULLY IMPLEMENTED         | 31-line boundary processor delegating to `VerificationApplicationService`.                                                                                                                     |

### What does not exist

- No background worker loop or job polling
- No database or durable queue
- No Docker orchestration in this repository
- No AI provider SDK
- No GOAT integration
- No dashboard or marketplace
- No GitHub feedback posting (PR comments/status checks)

---

## 2. Verification pipeline stage audit

Each stage classified against the full product flow:

```text
GitHub PR
  ↓
Authentication
  ↓
Immutable source acquisition
  ↓
Verification job
  ↓
Worker
  ↓
Project detection
  ↓
Check planning
  ↓
Static verification
  ↓
Secure execution
  ↓
Evidence collection
  ↓
Policy
  ↓
VerificationResult
  ↓
GitHub feedback
```

### Stage-by-stage classification

| Stage                            | Classification  | Files                                                                                 | What works                                                                                                                                                   | What does not work                                                                                                                              |
| -------------------------------- | --------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub PR**                    | IMPLEMENTED     | `packages/adapters-source/github-pr.ts`                                               | Parses PR events (opened/synchronize/reopened), extracts head SHA, maps to provider-neutral source reference                                                 | None — full parsing works                                                                                                                       |
| **Authentication**               | IMPLEMENTED     | `apps/github-bot/webhook.ts`, `packages/adapters-source/github-app.ts`                | HMAC-SHA256 webhook verification with timing-safe comparison; RS256 JWT creation for GitHub App; installation token acquisition                              | None — cryptographic operations are real and tested                                                                                             |
| **Immutable source acquisition** | IMPLEMENTED     | `packages/adapters-source/github.ts`, `packages/adapters-source/github-app.ts`        | Fetches commit, tree, blobs via GitHub REST API; base64 decoding; binary detection; file/byte limits; path safety enforcement                                | None for the API path — but real GitHub App credentials are required at runtime                                                                 |
| **Verification job**             | IMPLEMENTED     | `packages/domain/verification-queue.ts`, `packages/engine/src/in-memory-job-queue.ts` | Validates queue job shape, creates frozen immutable jobs, preserves insertion order                                                                          | No durable queue (Redis, SQS, etc.) — only in-memory                                                                                            |
| **Worker**                       | PARTIAL         | `apps/worker/index.ts`                                                                | Validates queue job, delegates to `VerificationApplicationService.verifySource()`                                                                            | No background loop, no retry, no polling, no graceful shutdown                                                                                  |
| **Project detection**            | IMPLEMENTED     | `packages/adapters-lang/detectors.ts`, `packages/adapters-lang/service.ts`            | Static filesystem scanning for TypeScript/JavaScript and Rust/Soroban; aggregates observations into `ProjectProfile` with capabilities and confidence        | No execution-based detection (e.g., running `node -v`)                                                                                          |
| **Check planning**               | IMPLEMENTED     | `packages/checks/planner.ts`                                                          | Deterministic plan from `ProjectProfile`; priorities, dependency ordering, required/optional/disabled overrides, content hashing                             | None — fully deterministic                                                                                                                      |
| **Static verification**          | IMPLEMENTED     | `packages/checks/catalog.ts`, `packages/checks/execution-specs.ts`                    | 11 check definitions; 8 have trusted executable specifications (commands in `execution-specs.ts`)                                                            | 3 defined checks (`dependency.audit`, `security.analysis`, `license.analysis`) await executable specifications; no execution against real repos |
| **Secure execution**             | PARTIAL         | `packages/engine/src/sandbox-transport.ts`, `packages/engine/src/execution.ts`        | `SubprocessSandboxTransport` spawns a child process with bounded I/O, timeout, abort; `CheckExecutor` maps checks to sandbox requests; lifecycle enforcement | Requires an external `verify-sandbox` process or Docker; integration tests are gated by env vars and mostly skipped in normal CI                |
| **Evidence collection**          | IMPLEMENTED     | `packages/engine/src/aggregation.ts`                                                  | `evidenceForCheckResult()` produces deterministic traceable evidence; `findingsForCheckResults()` creates evidence-backed findings for failures              | Evidence exists only from synthetic check results in normal test runs                                                                           |
| **Policy**                       | IMPLEMENTED     | `packages/policy/default.ts`                                                          | `evaluateDefaultPolicy()` with 5 deterministic rules; `DeterministicPolicyEvaluator` class                                                                   | No configurable policy beyond the default rules                                                                                                 |
| **VerificationResult**           | IMPLEMENTED     | `packages/engine/src/aggregation.ts`                                                  | `aggregateVerification()` assembles immutable `VerificationResult` with coverage, evidence, findings, policy decision                                        | Results are only produced from synthetic check results in normal test runs                                                                      |
| **GitHub feedback**              | NOT IMPLEMENTED | None                                                                                  | Nothing                                                                                                                                                      | No PR comments, no status checks, no commit statuses                                                                                            |

---

## 3. Capability matrix

| Capability                    | Status          | Evidence                                                                                                                                    | Production-ready?                                                                                                                                 |
| ----------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub webhook authentication | IMPLEMENTED     | `apps/github-bot/webhook.ts:verifyGitHubWebhookSignature()` — HMAC-SHA256, timing-safe comparison, tested in 40+ assertions                 | Yes (boundary proven)                                                                                                                             |
| Replay protection             | IMPLEMENTED     | `apps/github-bot/webhook.ts:createInMemoryGitHubWebhookReplayGuard()` — TTL-based with reserve/commit/rollback, bounded retention           | Boundary proven; needs durable store for production                                                                                               |
| Immutable SHA identity        | IMPLEMENTED     | `packages/adapters-source/github-pr.ts` — head SHA extracted, validated (40-char hex), used as `SourceReference.snapshotId`                 | Yes                                                                                                                                               |
| GitHub App auth               | IMPLEMENTED     | `packages/adapters-source/github-app.ts:createGitHubAppJwt()` — RS256 JWT, installation token acquisition, tested with real RSA keys        | Boundary proven; needs real credentials at runtime                                                                                                |
| Source snapshot acquisition   | IMPLEMENTED     | `packages/adapters-source/github.ts:createGitHubApiSourceProvider()` — fetches commit/tree/blobs, base64 decode, binary detect, path safety | Boundary proven; needs real GitHub App + network                                                                                                  |
| Verification job creation     | IMPLEMENTED     | `packages/domain/verification-queue.ts:createVerificationQueueJob()` — frozen immutable job with validation                                 | Yes                                                                                                                                               |
| Queue boundary                | PARTIAL         | `packages/engine/src/in-memory-job-queue.ts` — ordered, frozen, in-memory                                                                   | No durability; not production-ready                                                                                                               |
| Worker boundary               | PARTIAL         | `apps/worker/index.ts` — validates + delegates to application service                                                                       | No loop, retry, or lifecycle management                                                                                                           |
| Project detection             | IMPLEMENTED     | `packages/adapters-lang/detectors.ts` — TypeScript + Rust static detection against fixture files                                            | Yes (boundary proven)                                                                                                                             |
| Check planning                | IMPLEMENTED     | `packages/checks/planner.ts` — deterministic, content-hashed, dependency-ordered                                                            | Yes                                                                                                                                               |
| Static checks                 | IMPLEMENTED     | `packages/checks/catalog.ts` + `execution-specs.ts` — 11 definitions; 8 with executable specs                                               | Definitions exist; 3 checks (`dependency.audit`, `security.analysis`, `license.analysis`) await executable specs; execution is synthetic in tests |
| Secure execution              | PARTIAL         | `packages/engine/src/sandbox-transport.ts` — real subprocess transport, bounded I/O                                                         | Requires external `verify-sandbox` process                                                                                                        |
| Evidence                      | IMPLEMENTED     | `packages/engine/src/aggregation.ts:evidenceForCheckResult()` — deterministic, content-hashed                                               | Yes (boundary proven)                                                                                                                             |
| Policy                        | IMPLEMENTED     | `packages/policy/default.ts:evaluateDefaultPolicy()` — deterministic, 5 rules                                                               | Yes                                                                                                                                               |
| Final verification result     | IMPLEMENTED     | `packages/engine/src/aggregation.ts:aggregateVerification()` — immutable result assembly                                                    | Yes (boundary proven)                                                                                                                             |
| GitHub feedback               | NOT IMPLEMENTED | None                                                                                                                                        | No                                                                                                                                                |

---

## 4. Real-world GitHub capability

### What the system can do against a real GitHub repository/PR today

| Question                                   | Answer      | Implementation path                                                                                                                |
| ------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Receive a real GitHub webhook?             | **YES**     | `apps/github-bot/webhook.ts:handleGitHubWebhookHttpRequest()` — HTTP handler with body parsing, size limits                        |
| Authenticate the webhook?                  | **YES**     | `verifyGitHubWebhookSignature()` — HMAC-SHA256 with timing-safe comparison                                                         |
| Reject invalid signatures?                 | **YES**     | Returns 401 without calling any downstream service                                                                                 |
| Prevent replay?                            | **YES**     | `createInMemoryGitHubWebhookReplayGuard()` — TTL-based reserve/commit/rollback                                                     |
| Identify the PR?                           | **YES**     | `decideGitHubPullRequestEvent()` — extracts owner, repo, PR number, action                                                         |
| Obtain immutable PR head SHA?              | **YES**     | Extracted from `pull_request.head.sha`, validated as 40-char hex                                                                   |
| Authenticate as a GitHub App?              | **YES**     | `createGitHubAppJwt()` — RS256 JWT creation, installation token acquisition                                                        |
| Discover the installation?                 | **YES**     | `createGitHubApiInstallationResolver()` — queries GitHub API with App JWT                                                          |
| Retrieve source snapshot at the exact SHA? | **YES**     | `createGitHubApiSourceProvider()` — fetches commit, tree, blobs at exact SHA                                                       |
| Construct a verification job?              | **YES**     | `createGitHubVerificationOrchestrator()` — builds `VerificationQueueJob` from PR event                                             |
| Enqueue the job?                           | **YES**     | `createInMemoryVerificationJobQueue()` — in-memory queue                                                                           |
| Process the job through the worker?        | **PARTIAL** | `createVerificationJobProcessor()` — validates and delegates, but no background loop                                               |
| Execute actual repository checks?          | **PARTIAL** | `SubprocessSandboxTransport` + `CheckExecutor` can send commands to a configured sandbox process; requires external infrastructure |
| Produce actual verification evidence?      | **PARTIAL** | `evidenceForCheckResult()` works, but depends on real check execution which requires sandbox                                       |
| Produce a meaningful final result?         | **PARTIAL** | `aggregateVerification()` works, but only with real check results from sandbox execution                                           |
| Report result back to GitHub?              | **NO**      | No GitHub feedback implementation exists                                                                                           |

### The critical gap

The system has a complete path from GitHub PR webhook → authenticated source acquisition → job creation → queue → worker boundary → pipeline → detection → planning → execution mapping. But the execution boundary requires an external `verify-sandbox` process that is not part of this repository, and the worker has no background loop to process queued jobs autonomously.

---

## 5. First end-to-end verification slice

The smallest complete path that can produce a trustworthy verification result:

```text
GitHub PR webhook
  ↓
HMAC-SHA256 authentication (IMPLEMENTED)
  ↓
Replay guard (IMPLEMENTED)
  ↓
PR event parsing → immutable head SHA (IMPLEMENTED)
  ↓
GitHub App JWT → installation discovery → token (IMPLEMENTED)
  ↓
Source snapshot at exact SHA via GitHub API (IMPLEMENTED)
  ↓
VerificationQueueJob construction (IMPLEMENTED)
  ↓
In-memory queue enqueue (IMPLEMENTED)
  ↓
Worker picks up job (NOT IMPLEMENTED — no loop)
  ↓
ApplicationService.verifySource() (IMPLEMENTED)
  ↓
SourceResolver resolves snapshot (IMPLEMENTED)
  ↓
Pipeline: detect → plan → provision → execute (IMPLEMENTED except sandbox)
  ↓
Sandbox executes check commands (REQUIRES EXTERNAL VERIFY-SANDBOX)
  ↓
Evidence aggregation (IMPLEMENTED)
  ↓
Policy evaluation (IMPLEMENTED)
  ↓
VerificationResult assembly (IMPLEMENTED)
  ↓
GitHub feedback (NOT IMPLEMENTED)
```

### Supported ecosystems for the first slice

```text
TypeScript / JavaScript
  - typescript.typecheck (pnpm exec tsc --noEmit)
  - typescript.lint (pnpm exec eslint .)
  - typescript.test (pnpm exec vitest run)
  - typescript.build (pnpm exec tsc -b)

Rust / Soroban
  - rust.check (cargo check)
  - rust.test (cargo test)
  - rust.clippy (cargo clippy -- -D warnings)
  - soroban.contract-test (soroban test)
```

### First successful verification must mean

| Result          | Meaning                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `pass`          | All required checks executed with `real` provenance and passed; complete verified coverage |
| `blocked`       | Required check failed or high-severity finding triggered policy block                      |
| `needs_changes` | Unsupported required capability or non-real required execution                             |
| `needs_review`  | Medium-severity finding requires human review                                              |
| `partial`       | Some applicable capabilities remain unchecked or only synthetic results available          |
| `error`         | Infrastructure error prevented check execution                                             |

---

## 6. Truth-test matrix

### Design principle

Known-truth repository snapshots must produce predictable, deterministic results. The truth matrix proves verification-system correctness, not just implementation correctness.

### TypeScript / JavaScript fixtures

| Fixture                | Expected result        | Checks                       | Expected status                   |
| ---------------------- | ---------------------- | ---------------------------- | --------------------------------- |
| `healthy-ts`           | VERIFIED (pass)        | typecheck, lint, test, build | All passed with `real` provenance |
| `failing-test-ts`      | NOT_VERIFIED (blocked) | typecheck, lint, test, build | test failed → policy blocks       |
| `failing-typecheck-ts` | NOT_VERIFIED (blocked) | typecheck, lint, test, build | typecheck failed → policy blocks  |
| `failing-build-ts`     | NOT_VERIFIED (blocked) | typecheck, lint, test, build | build failed → policy blocks      |

### Rust fixtures

| Fixture            | Expected result        | Checks              | Expected status                   |
| ------------------ | ---------------------- | ------------------- | --------------------------------- |
| `healthy-rs`       | VERIFIED (pass)        | check, test, clippy | All passed with `real` provenance |
| `failing-test-rs`  | NOT_VERIFIED (blocked) | check, test, clippy | test failed → policy blocks       |
| `failing-build-rs` | NOT_VERIFIED (blocked) | check, test, clippy | check failed → policy blocks      |

### Fixture structure

Each fixture is a known-truth repository snapshot encoding a deterministic expected outcome. Each fixture is intended to be:

1. Materialized by the existing `ExecutionEnvironmentMaterializer`
2. Provisioned with offline dependencies (or have no dependencies)
3. Executed in the sandbox with `networkPolicy: none`
4. Produce deterministic, repeatable results

### Dependency strategy (Batch 43D — image-provisioned + wrapper scripts)

TypeScript fixtures require `typescript` and `vitest` packages to execute check commands (`pnpm exec tsc`, `pnpm exec vitest run`). The sandbox image provisions these globally at image-build time. The snapshot includes only minimal Node.js wrapper scripts from `sandbox-wrappers/` (tracked in git) that `pnpm exec` can discover after installation to `node_modules/.bin/`.

**Strategy: Image-provisioned tools + repository-controlled wrapper scripts**

The sandbox Docker image installs typescript and vitest globally. Each TypeScript fixture contains a `sandbox-wrappers/` directory with tiny (~150 byte) Node.js wrapper scripts tracked in git. The snapshot provisioner copies these to `node_modules/.bin/` so `pnpm exec` can discover them.

This strategy is:

- **Repository-controlled**: wrapper scripts in `sandbox-wrappers/` are tracked in git
- **Image-provisioned**: typescript/vitest installed at Docker build time
- **Explicit**: allowlist enumerates exactly what the snapshot contains
- **Bounded**: wrapper scripts are ~150 bytes each, not full node_modules
- **Offline**: no network required at runtime
- **No host installation**: wrapper scripts come from git, not the host

**What the sandbox image provides:**

- Node.js 24.19.0, pnpm 11.21.0 (core runtime)
- typescript@5.8.3 (global) — for `tsc --noEmit` and `tsc --build`
- vitest@2.1.9 (global) — for `vitest run`
- `NODE_PATH=/usr/local/lib/node_modules` — enables vitest import resolution

**What the snapshot contains:**

- Source files (`src/index.ts`, `src/index.test.ts`)
- Config files (`package.json`, `tsconfig.json`, `vitest.config.ts`)
- Wrapper scripts (`node_modules/.bin/tsc`, `node_modules/.bin/vitest`) — installed from `sandbox-wrappers/`

**What is excluded from the snapshot:**

- `sandbox-wrappers/` (removed after installation to `node_modules/.bin/`)
- `node_modules/typescript/`, `node_modules/vitest/` (image-provisioned)
- `dist` (build output)
- `tsconfig.tsbuildinfo` (TypeScript build cache)
- `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml` (lock files not needed at runtime)
- `.turbo`, `.cache`, `.vitest`, `coverage`, `.nyc_output` (caches and generated state)

**Where dependencies come from:**

- typescript and vitest are installed globally in the sandbox Docker image
- Wrapper scripts in `sandbox-wrappers/` are tracked in git (repository-controlled)
- They are copied to `node_modules/.bin/` by the snapshot provisioner
- They are NOT copied from the host machine's `node_modules`
- They are NOT installed at runtime by the snapshot provisioner

**Is network required:** No. The sandbox has no network access. Dependencies are fully contained in the image and wrapper scripts.

**Is host installation forbidden:** Yes. The real-sandbox test path never runs `npm install`, `pnpm install`, or equivalent on the host. Wrapper scripts come from git; tools come from the Docker image.

> **Current status (Batch 43D)**: The sandbox image provisions typescript and vitest globally. Repository-controlled wrapper scripts in `sandbox-wrappers/` are installed to `node_modules/.bin/` by the snapshot provisioner. A clean git checkout provides the wrapper scripts; the sandbox image provides the tools. Offline, reproducible execution is established without full node_modules in the snapshot.

### How fixtures are used

1. **Unit tests**: Each fixture is a directory in `tests/fixtures/truth-matrix/` or `fixtures/truth-matrix/`
2. **Integration tests** (gated): Real sandbox execution against fixtures with `VERIFY_REAL_SANDBOX=1` — currently requires external sandbox infrastructure
3. **Future CI**: Automated truth-matrix runs against known snapshots (requires execution harness completion)
4. **Audit proof**: The matrix documents what a passing/not-passing verification must mean

---

## 7. Trust model

### Trust chain

```text
GitHub webhook signature (HMAC-SHA256)
    ↓
trusted event payload
    ↓
immutable source SHA (head SHA from PR)
    ↓
source snapshot (fetched at exact SHA via GitHub API)
    ↓
planned checks (deterministic from detection + config)
    ↓
sandbox execution (external, isolated boundary)
    ↓
structured evidence (deterministic from check results)
    ↓
policy decision (deterministic from evidence + findings)
    ↓
verification result (immutable, content-hashed)
```

### What is trusted vs untrusted

| Category                                | Classification                                  | Notes                                                                          |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| GitHub webhook signature                | Trusted boundary                                | Cryptographic proof of GitHub origin                                           |
| Webhook payload                         | Trusted event (after authentication)            | Immutable once authenticated                                                   |
| Head SHA                                | Trusted fact                                    | Immutable identity of the PR                                                   |
| Source snapshot contents                | Untrusted project data                          | Repository code is untrusted; the snapshot is the trusted reference            |
| Repository `package.json`, `Cargo.toml` | Untrusted project metadata                      | Detection uses them for capability inference only                              |
| Check execution stdout/stderr           | Untrusted project output                        | Never treated as trusted fact; only exit code and structured results are facts |
| Check execution exit code               | Derived fact                                    | 0 = passed, non-zero = failed; structured by sandbox boundary                  |
| Evidence                                | Trusted fact (derived from check results)       | Deterministic, content-hashed, excludes timestamps                             |
| Findings                                | Trusted fact (derived from evidence)            | Evidence-backed, no standalone findings                                        |
| Policy decision                         | Trusted fact (derived from evidence + findings) | Deterministic, versioned rules                                                 |
| AI interpretation                       | Untrusted interpretation                        | Never overrides deterministic facts; contradictions recorded                   |
| VerificationResult                      | Trusted fact (assembled from all above)         | Immutable, content-hashed                                                      |

### Critical invariant

The system must never treat arbitrary repository stdout/stderr as trusted facts merely because the command executed. Only the structured sandbox result (exit code, duration, status) is a fact. The content of stdout/stderr is project output and is untrusted data that can be referenced by evidence but never treated as truth.

---

## 8. Architecture for project detection

### Provider-neutral contract

```text
Repository snapshot (files + metadata)
      ↓
ProjectDetectionResult
```

### Proposed types

```typescript
interface ProjectKind {
  readonly ecosystem: string; // "typescript", "rust", "python", etc.
  readonly confidence: number; // 0-1
  readonly evidence: readonly string[]; // file paths that contributed
}

interface ProjectMetadata {
  readonly packageManager?: string;
  readonly toolchain?: string;
  readonly frameworks?: readonly string[];
  readonly capabilities: readonly string[];
}

interface ProjectDetectionResult {
  readonly kinds: readonly ProjectKind[];
  readonly metadata: ProjectMetadata;
  readonly profile: ProjectProfile; // existing domain type
}

interface ProjectDetector {
  detect(
    snapshot: RepositorySnapshot,
    context: DetectionContext,
  ): ProjectDetectionResult;
}
```

### Layer absorption

| Concern                    | Absorbed by                          |
| -------------------------- | ------------------------------------ |
| Filesystem scanning        | `DetectionContext`                   |
| Ecosystem-specific signals | `ProjectDetector` implementations    |
| Capability mapping         | `ProjectDetectionService` (existing) |
| Confidence scoring         | `ProjectDetectionService` (existing) |

The existing `packages/adapters-lang` already implements this pattern for TypeScript and Rust. Future ecosystems add new detector implementations without changing the core.

---

## 9. Architecture for check planning

### Contract

```text
ProjectDetectionResult
      ↓
CheckPlan
```

### Check plan should describe

```typescript
interface CheckPlanItem {
  readonly checkId: CheckId;
  readonly checkVersion: string;
  readonly applicability: "applicable" | "unsupported" | "not_applicable";
  readonly required: boolean;
  readonly reason: string;
  readonly priority: number;
  readonly scope: CheckScope;
  readonly dependencies: readonly CheckId[];
}

interface CheckPlan {
  readonly items: readonly CheckPlanItem[];
  readonly contentHash: string;
  readonly plannerVersion: string;
}
```

The existing `packages/checks/planner.ts` already implements this. Future enhancements may add:

- Time/resource requirement estimates
- Working directory specifications
- Required environment variables
- Expected evidence shape per check

---

## 10. Architecture for evidence

### Required evidence fields

```typescript
interface ExecutionEvidence {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly sourceRevision: string; // SHA
  readonly environment: {
    readonly toolchain: string;
    readonly platform: string;
    readonly architecture: string;
  };
  readonly artifacts: readonly ArtifactReference[];
  readonly provenance: "real" | "simulated" | "fixture";
}
```

The existing `Evidence` type in `packages/domain` already supports this structure. The `evidenceForCheckResult()` function in `packages/engine/src/aggregation.ts` maps `CheckResult` to `Evidence`. Future work connects real sandbox output to this model.

---

## 11. Language support strategy

### Initial support (this batch defines)

| Ecosystem               | Checks                             | Commands                                                                                   |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| TypeScript / JavaScript | typecheck, lint, test, build       | `pnpm exec tsc --noEmit`, `pnpm exec eslint .`, `pnpm exec vitest run`, `pnpm exec tsc -b` |
| Rust / Soroban          | check, test, clippy, contract-test | `cargo check`, `cargo test`, `cargo clippy -- -D warnings`, `soroban test`                 |

### Future architecture

The system adds ecosystems by implementing:

| Layer                | Responsibility                        | Example                                 |
| -------------------- | ------------------------------------- | --------------------------------------- |
| `ProjectDetector`    | Detect ecosystem from files           | `pythonDetector` reads `pyproject.toml` |
| `ToolchainResolver`  | Resolve toolchain for execution       | `pythonResolver` finds `python3`        |
| `CheckPlanner`       | Map capabilities to checks            | Already generic                         |
| `CommandPolicy`      | Define trusted commands per check     | New per-ecosystem spec                  |
| `EvidenceNormalizer` | Normalize output to standard evidence | May need per-ecosystem parsing          |

No rewrites to domain, engine, checks, or policy are needed for new ecosystems.

---

## 12. Stale/misleading documentation updated

### README.md corrections

The README currently states:

> This repository intentionally does not implement:
>
> - GitHub App or webhook integrations
> - a real sandbox executor

This is misleading. The repository **does** implement:

- GitHub webhook authentication (HMAC-SHA256 with timing-safe comparison)
- GitHub App authentication (RS256 JWT, installation token acquisition)
- GitHub PR event parsing
- GitHub API source provider (commit/tree/blob fetching)
- A subprocess-based sandbox transport boundary

What it does **not** implement:

- A complete sandbox execution environment (that is `verify-sandbox`)
- Background worker loop for processing queued jobs
- GitHub feedback posting

The README should be updated to accurately reflect this distinction.

---

## 13. Production-readiness gaps

Before claiming repository-wide verification capability, these must exist:

1. **Durable queue** — replace in-memory queue with Redis/SQS/BullMQ for production
2. **Worker loop** — background job polling with retry, backoff, graceful shutdown
3. **GitHub feedback** — post PR comments and/or status checks with verification results
4. **Sandbox orchestration** — Docker/Kubernetes deployment of `verify-sandbox` (in the sibling repo)
5. **Credential management** — GitHub App private key rotation, secure storage
6. **Monitoring** — health checks, metrics, alerting for the verification pipeline
7. **Rate limiting** — GitHub API rate limit handling, webhook deduplication at scale
8. **Truth-test CI** — automated runs against known-truth repository snapshots
9. **Policy configurability** — allow repository owners to customize verification policy
10. **Multi-repository support** — handle monorepos, cross-repo dependencies

---

## 14. Suggested future sequence

The following capabilities already exist in the codebase and should be **validated/integrated**, not rebuilt:

- Project detection (`packages/adapters-lang`)
- Check planning (`packages/checks/planner.ts`)
- Evidence aggregation (`packages/engine/src/aggregation.ts`)
- Policy evaluation (`packages/policy/default.ts`)
- VerificationResult assembly (`packages/engine/src/aggregation.ts`)

Future batches connect and prove those components through real execution against the truth-test matrix.

```text
implemented components
        ↓
real execution
        ↓
real evidence
        ↓
real policy
        ↓
truth-matrix validation
        ↓
real TypeScript E2E
        ↓
real Rust/Soroban E2E
```

| Batch     | Focus                                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **39**    | Truth-matrix execution harness + verification-pipeline integration             | **DONE.** Deterministic harness exercises detection → planning → execution-boundary → evidence → policy → result against 7 known-truth fixtures with simulated execution.                                                                                                                                                                                                                                                                                                                            |
| **40**    | Real verify-sandbox lifecycle integration                                      | **DONE.** Gated integration tests exercise CheckExecutor through SubprocessSandboxTransport with test harness fixture. Validates state machine, provenance tracking, and exit code propagation.                                                                                                                                                                                                                                                                                                      |
| **41**    | Canonical sandbox contract integration + lifecycle validation                  | **DONE.** Canonical contract validation, subprocess transport protocol tests, fail-closed process exit handling, URI-reference validation, security properties, enhanced test harness. Real verify-sandbox remains GATED. ADR-0009.                                                                                                                                                                                                                                                                  |
| **42**    | Policy + VerificationResult validation against the truth matrix                | **DONE.** Proves policy decisions and final results match known expected outcomes. 53 tests validate policy truth, VerificationResult completeness, evidence integrity, edge cases, and full pipeline integration across all 7 fixtures.                                                                                                                                                                                                                                                             |
| **43**    | TypeScript/JavaScript end-to-end verification (host-subprocess + real sandbox) | **DONE.** Two test suites: (1) host-subprocess E2E (10 tests, `VERIFY_REAL_SANDBOX=1`) proves real toolchain execution on host via local harness; (2) real sandbox E2E (16 tests, `VERIFY_SANDBOX_PROCESS` + `VERIFY_SANDBOX_IDENTITY`) proves Docker-isolated execution via external verify-sandbox process with wrapper-script-based snapshot provisioning. Fixes harness status mapping, Windows CMD resolution, fixture vitest configs, deterministic build-only failure via project references. |
| **43A**   | Batch 43 corrective: honest naming + real sandbox separation                   | **DONE.** Corrected host-subprocess tests to honestly label execution boundary. Created separate `batch-43-real-sandbox.test.ts` requiring actual external sandbox. Failing-build fixture redesigned with `lib/` sub-project for deterministic build-only failure (`tsc --noEmit` passes, `tsc --build` fails). Harness labeled as host-subprocess only.                                                                                                                                             |
| **43B**   | Batch 43 corrective: clean provisioning + identity gate + docs                 | **DONE.** Allowlist-based snapshot provisioning excludes dist/caches. `VERIFY_SANDBOX_IDENTITY` operator-controlled gate replaces filename-based guessing. Documentation corrected to accurately describe host snapshot provisioning vs sandbox materialization. Real sandbox tests expanded to 16 including snapshot cleanliness/content validation and executable permission verification.                                                                                                         |
| **43C**   | Batch 43 corrective: reproducible snapshot dependency strategy (SUPERSEDED)    | **SUPERSEDED BY 43D.** Investigated snapshot-included `node_modules` as deterministic dependency artifacts. The approach was rejected because fixture `node_modules` are `.gitignored` and therefore not reproducible from a clean checkout. Batch 43D replaced this with image-provisioned TypeScript/Vitest + repository-controlled wrapper scripts.                                                                                                                                               |
| **43D**   | Batch 43 corrective: image-provisioned tools + wrapper scripts                 | **DONE.** Replaced full node_modules snapshot with minimal wrapper scripts. Sandbox Docker image now installs typescript@5.8.3 and vitest@2.1.9 globally + sets NODE_PATH. Snapshot provisioner creates ~150-byte Node.js wrapper scripts in `node_modules/.bin/` that delegate to global tools. Wrapper scripts tracked in git (repository-controlled). Updated docs with accurate dependency strategy.                                                                                             |
| **44**    | Real Rust/Soroban end-to-end verification                                      | Extend to Rust ecosystem with real `cargo check`, `cargo test`, `cargo clippy`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **45+**   | Durable queue + worker lifecycle + production hardening                        | Redis/SQS/BullMQ, retry, backoff, graceful shutdown, monitoring                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Later** | GitHub feedback                                                                | PR comments, status checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Later** | AI-assisted reasoning                                                          | Provider integration, prompt optimization                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Later** | Additional ecosystem support                                                   | Python, Go, Solidity, etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Why this order

The existing implementation covers project detection, check planning, evidence aggregation, policy evaluation, and VerificationResult assembly. The primary gaps are:

1. No real sandbox execution integrated with the existing pipeline (batches 39-40)
2. No truth-matrix validation against known outcomes (batches 41-42)
3. No real end-to-end verification against actual repositories (batches 43-44)
4. No durable job queue or worker loop (batch 45+)
5. No GitHub feedback posting (later)
6. No AI provider (later)

The sequence moves from connecting existing components → proving them through real execution → validating against known truths → production hardening.

---

## 15. Batch 39: Truth-matrix integration harness

Batch 39 provides a deterministic truth-matrix integration harness that exercises the existing verification pipeline against the 7 known-truth fixtures.

### What Batch 39 proves

- **Pipeline composition**: The existing detection → planning → execution-boundary → evidence → policy → result pipeline composes correctly end-to-end
- **Detection correctness**: `createProjectDetectionService()` correctly identifies TypeScript and Rust ecosystems from fixture files
- **Planning correctness**: `createCheckPlanner()` produces correct applicable checks for each ecosystem
- **Execution-spec resolution**: `createTrustedExecutionSpecRegistry()` maps check IDs to trusted commands; 3 definition-only checks (`dependency.audit`, `security.analysis`, `license.analysis`) correctly have no execution spec
- **Evidence aggregation**: `aggregateVerification()` produces deterministic evidence and findings from check results
- **Policy evaluation**: `evaluateDefaultPolicy()` correctly triggers `required-check-failure` for failing checks and `non-real-required-execution` for simulated execution
- **VerificationResult assembly**: The full pipeline produces immutable, content-hashed `VerificationResult` with correct status, coverage, and policy decision

### What Batch 39 does NOT prove

- **Real sandbox execution**: The harness uses a deterministic test adapter (`executionSource: "simulated"`), not real command execution
- **Arbitrary repository correctness**: The fixtures are controlled known-truth snapshots, not arbitrary repositories
- **Sandbox reliability**: No real sandbox process is involved; Batch 40 handles this

### Harness architecture

```text
fixture source files
  ↓
createFileSystemDetectionContext()  [real, from @verify-agent/adapters-lang]
  ↓
createProjectDetectionService()    [real, from @verify-agent/adapters-lang]
  ↓
createCheckPlanner()               [real, from @verify-agent/checks]
  ↓
createDeterministicTestExecutor()  [test adapter — simulated execution]
  ↓
createVerificationPipeline()       [real, from @verify-agent/engine]
  ↓
aggregateVerification()            [real, from @verify-agent/engine]
  ↓
evaluateDefaultPolicy()            [real, from @verify-agent/policy]
  ↓
VerificationResult                 [immutable, content-hashed]
```

### Expected results with simulated execution

| Fixture                      | VerificationStatus | Policy outcome | Coverage          |
| ---------------------------- | ------------------ | -------------- | ----------------- |
| TypeScript healthy           | `needs_changes`    | allow          | simulated         |
| TypeScript failing-test      | `blocked`          | block          | partial+simulated |
| TypeScript failing-typecheck | `blocked`          | block          | partial           |
| TypeScript failing-build     | `blocked`          | block          | partial+simulated |
| Rust healthy                 | `needs_changes`    | allow          | simulated         |
| Rust failing-test            | `blocked`          | block          | partial+simulated |
| Rust failing-build           | `blocked`          | block          | partial           |

Note: With simulated execution, healthy fixtures produce `needs_changes` (not `pass`) because the `non-real-required-execution` policy rule correctly prevents simulated results from satisfying required production verification coverage.

### Test isolation

- No GitHub, network, or external sandbox required
- No dependency provisioning or Docker required
- Deterministic across runs (content-hashed results)
- 60 tests covering architecture guardrails, detection, planning, execution-specs, evidence, policy, and VerificationResult

---

## 16. Batch 40: CheckExecutor subprocess integration

Batch 40 adds gated integration tests that exercise `createCheckExecutor` through the real `SubprocessSandboxTransport` using the test harness fixture.

### What Batch 40 proves

- **Full CheckExecutor pipeline**: `SubprocessSandboxTransport` → `createSandboxExecutorFromTransport` → `createCheckExecutor` composes correctly end-to-end
- **State machine correctness**: `CheckExecution` transitions from `queued` → `running` → `completed` (or `failed`) through real subprocess execution
- **Provenance preservation**: `executionSource: "real"` is correctly propagated from transport through executor to final `CheckResult`
- **Exit code propagation**: Non-zero exit codes from subprocess correctly produce `failed` check status
- **Result assembly**: `mapSandboxJobResultToCheckResult` correctly maps sandbox results to domain `CheckResult` with content hash and metrics

### What Batch 40 does NOT prove

- **Real verify-sandbox binary**: The tests use the test harness fixture (`sandbox-harness.mjs`), not the production verify-sandbox binary
- **Real toolchain execution**: Commands are not actually executed by TypeScript/Rust toolchains
- **Sandbox process lifecycle**: No Docker, no network isolation, no resource enforcement

### How to run

```bash
# Run with test harness (spawns Node.js subprocess)
pnpm test -- tests/check-executor.integration.test.ts

# Run with real verify-sandbox binary (requires environment setup)
VERIFY_SANDBOX_PROCESS=/path/to/verify-sandbox \
VERIFY_SANDBOX_SNAPSHOT_ROOT=/path/to/snapshots \
VERIFY_SANDBOX_DOCKER_EXECUTABLE=/usr/bin/docker \
VERIFY_SANDBOX_DOCKER_HOST=unix:///var/run/docker.sock \
VERIFY_SANDBOX_SYSTEM_ROOT=/system \
VERIFY_SANDBOX_TEMP_ROOT=/tmp \
pnpm test -- tests/check-executor.integration.test.ts
```

### Test coverage

- 3 integration tests (gated behind `VERIFY_SANDBOX_INTEGRATION=1` or `VERIFY_SANDBOX_PROCESS`)
- Tests are skipped when gate environment variables are not set
- No network, GitHub, or external sandbox required for basic gating

---

## 17. Batch 41: Canonical sandbox contract integration & lifecycle validation

Batch 41 validates the canonical sandbox request/result protocol and subprocess/lifecycle boundary using the controlled Node harness by default. Real external `verify-sandbox` execution is covered by gated tests and is NOT executed in the current environment.

### What Batch 41 proves

- **Canonical contract compliance**: VerifyAgent's request/result types conform to `verify-contracts/schemas/sandbox/sandbox-job-request.schema.json` and `sandbox-job-result.schema.json` (version 1.0.0)
- **Command representation**: `SandboxCommand` objects are correctly serialized to JSON `ApprovedCommand` records matching the sandbox backend's expected format (executable, args, workingDirectory, environment)
- **Opaque snapshot semantics**: `snapshot` is passed as an opaque identity string from `sourceState.value`, never a filesystem path
- **Source identity binding**: `jobId`, `source`, and `snapshot` are bound to the same immutable verification source
- **Resource limits**: Deterministic defaults (120s timeout, 512 MiB memory) conform to contract constraints and backend caps
- **Network/artifact policy**: `none` is the only safe default; `restricted`/`allowlist` and `declared` are correctly not requested
- **Result validation**: Real sandbox results are validated at the boundary against the canonical schema; malformed/mismatched/oversized responses are rejected
- **Job identity verification**: Mismatched `jobId` between request and result is rejected
- **Transport protocol purity**: One JSON request per line on stdin, one JSON result per line on stdout; diagnostics on stderr only; premature EOF, extra output, and malformed JSON are handled fail-closed
- **Fail-closed process exit handling**: Non-zero process exit codes are rejected as transport failures before stdout is trusted; valid JSON emitted by a non-zero-exiting process is never accepted as a successful result
- **Signal termination rejection**: Processes terminated by signal are rejected as transport failures
- **URI-reference validation**: `logsRef` and `artifactRefs` are validated as canonical URI-references; malformed references are rejected
- **Security properties**: `shell: false`, no host environment inheritance, no credential forwarding, bounded I/O, process cleanup
- **Provenance propagation**: `executionSource: "real"` (subprocess) vs `"simulated"` (fake) correctly propagated through the pipeline
- **Terminal status mapping**: All sandbox statuses (`completed`, `failed`, `timed_out`, `cancelled`, `error`) map to correct check statuses
- **JSON-lines protocol behavior**: Controlled local subprocess harness integration proves protocol correctness

### What Batch 41 did NOT prove

- **Real production Verify Sandbox execution** — Tests use `tests/fixtures/sandbox-harness.mjs` (a controlled Node.js subprocess), NOT the real `verify-sandbox` process. Real Verify Sandbox execution remains GATED / NOT EXECUTED IN CURRENT ENVIRONMENT.
- **Docker isolation** — No Docker orchestration or container isolation is exercised
- **Real TypeScript/Rust toolchain execution inside Verify Sandbox** — Commands are simulated by the test harness, not executed by real toolchains
- **Network/resource enforcement under Docker** — Not tested; requires real sandbox infrastructure
- **Production sandbox deployment** — The test harness is a controlled local subprocess, not a production sandbox
- **Hardened multi-tenant isolation** — Requires separate security review of the real sandbox
- **Truth-matrix end-to-end validation** — This remains for Batches 42-44
- **Production deployment security** — Durable queue, retry, monitoring are Batch 45+

### Files changed

| File                                                         | Change                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/sandbox-contract.integration.test.ts`                 | New: 50+ contract validation, transport, security, provenance, and integration tests                                                                                                                                                           |
| `tests/fixtures/sandbox-harness.mjs`                         | Enhanced: 10+ new failure modes (wrong-version, job-mismatch, missing-fields, wrong-type, extra-output, error-result, timed_out-result, cancelled-result, resource-usage, exit-code-nonzero, with-artifacts, eof-no-output, error-exit-code-2) |
| `docs/decisions/0009-verify-sandbox-contract-integration.md` | New: ADR documenting canonical contract ownership, request/result mapping, command representation, snapshot semantics, resource/network/artifact policy, transport responsibility, lifecycle ownership, provenance, and security properties    |
| `docs/verification-readiness.md`                             | Updated: Batch 41 marked DONE with description                                                                                                                                                                                                 |

### Canonical contract fields used

**Request** (`sandbox-job-request.schema.json`):

| Field                             | Value                        | Source                         |
| --------------------------------- | ---------------------------- | ------------------------------ |
| `schemaVersion`                   | `"1.0.0"`                    | Constant                       |
| `jobId`                           | `execution.jobId`            | CheckExecution                 |
| `source`                          | `{provider, reference}`      | RepositorySnapshot.source      |
| `snapshot`                        | `sourceState.value`          | RepositorySnapshot.sourceState |
| `commands`                        | `["{JSON ApprovedCommand}"]` | Trusted execution spec         |
| `resourceLimits.timeoutMs`        | 120,000 (default)            | ExecutionLimits                |
| `resourceLimits.memoryLimitBytes` | 536,870,912 (default)        | ExecutionLimits                |
| `networkPolicy`                   | `"none"`                     | Hardcoded safe default         |
| `artifactPolicy`                  | `"none"`                     | Hardcoded safe default         |

**Result** (`sandbox-job-result.schema.json`):

| Field           | Mapping                       |
| --------------- | ----------------------------- |
| `schemaVersion` | Validated as `"1.0.0"`        |
| `jobId`         | Must match request.jobId      |
| `status`        | Mapped to CheckStatus         |
| `exitCode`      | Optional; 0=passed, ≠0=failed |
| `durationMs`    | Pass-through                  |
| `logsRef`       | Pass-through as rawOutputRef  |
| `artifactRefs`  | Pass-through                  |
| `resourceUsage` | Mapped to CheckResult.metrics |
| `errors`        | Joined into summary           |

### How to run

```bash
# Mode A: Test harness (spawns Node.js subprocess, no Docker required)
pnpm test -- tests/sandbox-contract.integration.test.ts

# Mode B: Real verify-sandbox (requires full environment)
VERIFY_SANDBOX_INTEGRATION=1 \
VERIFY_SANDBOX_PROCESS=/path/to/verify-sandbox-process \
VERIFY_SANDBOX_SNAPSHOT_ROOT=/path/to/snapshots \
VERIFY_SANDBOX_DOCKER_EXECUTABLE=/usr/bin/docker \
VERIFY_SANDBOX_DOCKER_HOST=unix:///var/run/docker.sock \
VERIFY_SANDBOX_SYSTEM_ROOT=/system \
VERIFY_SANDBOX_TEMP_ROOT=/tmp \
pnpm test -- tests/sandbox-contract.integration.test.ts
```

### Test coverage

- 50+ tests across 13 describe blocks
- Contract validation: request and result schema compliance
- Job identity: mismatched jobId rejection
- Transport protocol: JSON-lines, malformed, EOF, extra output, timeout, cancellation, process failure
- Security: shell:false, env isolation, command format, snapshot opacity, policy defaults, resource bounds
- Result handling: all terminal status mappings, resource usage, errors, artifacts
- Command representation: spec→command→JSON argv, trusted spec registry
- Snapshot semantics: opaque identity, no host paths
- Source identity: immutable reference binding
- Resource limits: defaults, bounds, pass-through
- Provenance: real vs simulated, producer propagation
- Schema edge cases: null, wrong types, missing fields, boundary values
- Mode A integration: full pipeline through test harness
- Mode B integration: gated against real verify-sandbox
- Harness scenarios: 10+ enhanced failure modes

---

## 18. Batch 42: Policy + VerificationResult validation against the truth matrix

Batch 42 validates the policy and VerificationResult layers against the 7 known-truth fixtures, proving that evidence interpretation, aggregation, deterministic policy decisions, and VerificationResult assembly produce the correct outcomes for every scenario.

### What Batch 42 proves

- **Policy truth**: Every fixture scenario triggers the correct policy rule(s) and produces the expected policy outcome
- **Evidence traceability**: All evidence references link back to executed check results; findings reference their source evidence
- **VerificationResult completeness**: Result fields (status, coverage, evidenceReferences, findingReferences, policyDecision, summary, contentHash) are preserved correctly
- **Failure propagation**: Failing checks propagate through findings → policy block → VerificationResult blocked status
- **Healthy fixture safety**: Healthy fixtures with simulated execution produce `needs_changes`, never `pass`
- **Policy determinism**: Identical inputs produce identical policy decisions and content hashes
- **Policy rule priority**: `required-check-failure` takes precedence over `non-real-required-execution` when both apply
- **Coverage categories**: Coverage categories (verified, partial, simulated, fixture, unsupported, notApplicable) are mutually exclusive per capability
- **Edge cases**: Incomplete evidence (applicable checks with no results) produces partial coverage; empty plans produce pass; error status overrides policy block; multiple failures aggregate correctly

### What Batch 42 does NOT prove

- **Real sandbox execution** — Tests use `createDeterministicTestExecutor()` (simulated), not real command execution
- **Arbitrary repository correctness** — Fixtures are controlled known-truth snapshots
- **Policy customization** — Tests use the default policy; custom policies are not validated

### Test categories (53 tests)

| Category                            | Tests | Focus                                                                                   |
| ----------------------------------- | ----- | --------------------------------------------------------------------------------------- |
| Policy truth validation             | 10    | Policy rule triggering, outcome correctness, determinism, priority, edge rules          |
| VerificationResult truth validation | 7     | Status correctness, field preservation, coverage, summary, determinism                  |
| Evidence integrity                  | 4     | Content hashes, source references, finding links, cross-run determinism                 |
| Edge cases                          | 10    | Empty results, incomplete evidence, error override, multiple failures, contradictions   |
| Full pipeline integration           | 21    | Complete traceability (7), determinism (7), coverage matching (7) across all 7 fixtures |

### Policy truth requirements validated

| Requirement                                                                | Fixture(s)                       | Assertion                                                                   |
| -------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| CASE 1: Healthy fixture with non-real execution stays needs_changes        | typescript-healthy, rust-healthy | `outcome === "needs_changes"`, rule `non-real-required-execution` triggered |
| CASE 2: Failing typecheck propagates through evidence to policy to result  | typescript-failing-typecheck     | findings > 0, high severity, policy block, result blocked                   |
| CASE 3: Failing test propagates through evidence to policy to result       | typescript-failing-test          | findings > 0, policy block, result blocked                                  |
| CASE 4: Failing build propagates through evidence to policy to result      | typescript-failing-build         | findings > 0, policy block, result blocked                                  |
| CASE 5: Rust failing build propagates through evidence to policy to result | rust-failing-build               | findings > 0, policy block, result blocked                                  |

### Files added

| File                                              | Change                                                                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `tests/batch-42-policy-result-validation.test.ts` | New: 53 tests covering policy truth, VerificationResult, evidence integrity, edge cases, full pipeline integration |

### How to run

```bash
pnpm test -- tests/batch-42-policy-result-validation.test.ts
```

---

## 19. Batch 43: TypeScript/JavaScript end-to-end verification (host-subprocess + real sandbox)

Batch 43 proves a genuine end-to-end verification path through the actual `SubprocessSandboxTransport`, executing real TypeScript/JavaScript toolchain commands against known-truth fixtures and producing real evidence, policy decisions, and `VerificationResult` objects.

### Two execution levels

Batch 43 has two distinct test suites that prove different levels of execution:

| Test suite                        | Gate                                             | What it proves                                                                             | What it does NOT prove                                  |
| --------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `batch-43-typescript-e2e.test.ts` | `VERIFY_REAL_SANDBOX=1`                          | Real toolchain execution on the host machine via a local Node.js subprocess                | Sandbox isolation, Docker, network enforcement          |
| `batch-43-real-sandbox.test.ts`   | `VERIFY_SANDBOX_PROCESS` + all required env vars | Real sandbox execution inside a Docker container via the external `verify-sandbox` process | Arbitrary repository correctness, production deployment |

### Host-subprocess E2E tests (10 tests)

What the host-subprocess tests prove:

- **Genuine E2E path**: Truth fixture → source/project detection → check planning → real TypeScript/JavaScript execution → sandbox transport boundary → evidence → policy → `VerificationResult` with `executionSource: "real"`
- **Real toolchain execution**: `pnpm exec tsc --noEmit`, `pnpm exec vitest run`, `pnpm exec tsc --build` execute against real TypeScript fixture code through the actual `SubprocessSandboxTransport`
- **Transport correctness**: `SubprocessSandboxTransport` spawns the real execution harness, communicates via JSON-lines stdin/stdout, correctly captures exit codes, and validates results against the canonical sandbox contract
- **Harness correctness**: The host-subprocess execution harness (`sandbox-real-execution-harness.mjs`) correctly reads `SandboxJobRequest` from stdin, executes commands with `shell: false` and explicit environment, captures stdout/stderr/exit code, and writes valid `SandboxJobResult` to stdout
- **Status mapping**: `sandboxResult.status === "completed"` with `exitCode === 0` maps to `CheckStatus: "passed"`; non-zero exit codes map to `CheckStatus: "failed"`; `sandboxResult.status === "error"` maps to `CheckStatus: "error"`
- **Evidence provenance**: All evidence has `executionSource: "real"`, never `"simulated"` or `"fixture"`
- **Evidence traceability**: Evidence preserves `checkId`, `exitCode`, `durationMs`, `contentHash`, `sourceReferences`, and `findingReferences`
- **Policy correctness with real execution**: Healthy fixtures with real execution produce `allow` policy outcome (not `needs_changes`); failing fixtures produce `block` with `required-check-failure` rule
- **VerificationResult completeness**: Result preserves `status`, `coverage.verified`, `coverage.partial`, `evidenceReferences`, `findingReferences`, and `policyDecision`
- **Semantic determinism**: Repeated real runs produce semantically identical outcomes (status, policy decision, evidence count, findings count) — content hashes may differ due to non-deterministic `durationMs`

What the host-subprocess tests do NOT prove:

- **Sandbox isolation** — The harness is a local Node.js subprocess, not a Docker-containerized sandbox
- **Network/resource enforcement under Docker** — Not tested; requires real sandbox infrastructure
- **Arbitrary repository correctness** — Fixtures are controlled known-truth snapshots
- **Production deployment** — No durable queue, worker loop, or GitHub feedback
- **Rust/Soroban execution** — Batch 44 covers Rust ecosystem

### Real sandbox E2E tests (16 tests)

What the real sandbox tests prove:

- **Real sandbox execution**: Commands executed by the external `verify-sandbox` process inside a Docker container
- **Clean snapshot provisioning**: The test host provisions the configured snapshot store with an explicit allowlist of fixture source/config files and tracked `sandbox-wrappers/` scripts
- **Opaque snapshot identity**: The `snapshot` field is an opaque branded identity string (`batch43-real-sandbox-...`), not a filesystem path; the sandbox process performs the subsequent lookup/materialization into the isolated workspace
- **No host-side dependency installation**: The provisioning helper copies only approved files; no npm/pnpm install is run on the host
- **Repository-controlled wrapper scripts**: The snapshot includes Git-tracked `sandbox-wrappers/` scripts (Node.js shebangs that delegate to globally installed tools); during provisioning these are materialized as executable `node_modules/.bin/tsc` and `node_modules/.bin/vitest`
- **Snapshot reproducibility**: A clean snapshot contains all prerequisites for check execution (source files, config files, executable wrapper scripts) without host-generated state
- **Executable permissions**: Materialized wrapper scripts receive mode `0o755` for `pnpm exec` resolution on the Linux sandbox
- **Sandbox identity verification**: `VERIFY_SANDBOX_IDENTITY` must match the expected value (`verify-sandbox-process-0.1.0`); this is an operator-controlled gate, not a filename check
- **Deterministic build failure**: `tsc --noEmit` passes (exit 0), `tsc --build` fails (exit 2) — deterministic, no machine-specific state
- **Snapshot cleanliness**: Provisioned snapshots contain no node_modules, dist, tsbuildinfo, caches, or generated files

What the real sandbox tests do NOT prove:

- **Sandbox isolation** — Isolation is provided by the external `verify-sandbox` process, not by this test suite
- **Arbitrary repository correctness** — Fixtures are controlled known-truth snapshots
- **Production deployment** — No durable queue, worker loop, or GitHub feedback
- **Rust/Soroban execution** — Batch 44 covers Rust ecosystem

### Bugs fixed during Batch 43

| Issue                                                         | Root cause                                                                                              | Fix                                                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All checks returned `error` status                            | Harness returned `status: "failed"` for command failures; `checkStatus()` mapped `"failed"` → `"error"` | Harness now always returns `status: "completed"` (matching simulated harness contract)                                                                                     |
| Windows `.CMD` files can't be spawned with `shell: false`     | `pnpm` is a `.CMD` wrapper; `spawn("pnpm", ..., {shell:false})` throws `EINVAL`                         | Harness wraps non-existing executables with `cmd.exe /s /c <name>`                                                                                                         |
| `tsc --noEmit` failed for healthy fixture                     | Fixture had no vitest config; vitest walked up to root `vitest.config.mjs` with wrong `include` pattern | Added `vitest.config.ts` with correct `include: ["src/**/*.test.ts"]` to each TypeScript fixture with tests                                                                |
| `tsc --noEmit` failed for failing-build fixture               | Fixture code had `const result: string = add(1, 2)` (type error), making typecheck also fail            | Fixed fixture code to be type-safe; used project references to cause build-only failure deterministically                                                                  |
| Content hash non-determinism in determinism test              | `durationMs` varies between real runs and is included in content hash                                   | Removed `contentHash` comparison; semantic equivalence is captured by status/outcome/structure assertions                                                                  |
| Host-subprocess tests labeled as "real sandbox"               | Tests were mislabeled, creating confusion about execution boundary                                      | Renamed to "host-subprocess" and created separate `batch-43-real-sandbox.test.ts` for actual sandbox tests                                                                 |
| Snapshot provisioning copied all files including node_modules | `cp -r` copied everything including generated/host state                                                | Batch 43B: Allowlist-based provisioning copies only approved source/config files                                                                                           |
| No positive sandbox identity verification                     | Gate only checked env var presence and filename patterns                                                | Batch 43B: `VERIFY_SANDBOX_IDENTITY` must match expected value; operator-controlled gate                                                                                   |
| Real-sandbox snapshots excluded dependency artifacts          | Clean snapshot excluded node_modules, but sandbox has no network and doesn't install packages           | Batch 43D: Sandbox Docker image provisions typescript/vitest globally; fixture `sandbox-wrappers/` provide executable wrapper scripts materialized to `node_modules/.bin/` |

### Files changed

| File                                                               | Change                                                                                                                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/batch-43-typescript-e2e.test.ts`                            | New: 10 host-subprocess E2E tests gated behind `VERIFY_REAL_SANDBOX=1`                                                                                                                  |
| `tests/batch-43-real-sandbox.test.ts`                              | Updated: 16 real sandbox E2E tests with wrapper-script-based allowlist provisioning, `VERIFY_SANDBOX_IDENTITY` gate, snapshot reproducibility tests, executable permission verification |
| `tests/fixtures/sandbox-real-execution-harness.mjs`                | Fixed: `status` mapping, Windows `.CMD` resolution, PATH passthrough, error+close double-write prevention; labeled as host-subprocess harness                                           |
| `fixtures/truth-matrix/typescript/healthy/vitest.config.ts`        | New: Local vitest config for fixture test discovery                                                                                                                                     |
| `fixtures/truth-matrix/typescript/failing-test/vitest.config.ts`   | New: Local vitest config for fixture test discovery                                                                                                                                     |
| `fixtures/truth-matrix/typescript/failing-build/lib/src/index.ts`  | New: Deliberate type error for deterministic build-only failure                                                                                                                         |
| `fixtures/truth-matrix/typescript/failing-build/lib/tsconfig.json` | New: Project with `composite: true`                                                                                                                                                     |
| `fixtures/truth-matrix/typescript/failing-build/tsconfig.json`     | New: References `lib` project for deterministic build failure                                                                                                                           |
| `fixtures/truth-matrix/typescript/failing-build/README.md`         | New: Documents deterministic failure approach                                                                                                                                           |
| `docs/verification-readiness.md`                                   | Updated: Documented dependency strategy (image-provisioned tools + repository-controlled wrapper scripts)                                                                               |

### How to run

```bash
# Run host-subprocess E2E tests (requires working TypeScript toolchain in fixtures)
$env:VERIFY_REAL_SANDBOX="1"
pnpm test -- tests/batch-43-typescript-e2e.test.ts

# Run host-subprocess E2E tests without gating (tests skip with explicit message)
pnpm test -- tests/batch-43-typescript-e2e.test.ts

# Run real sandbox E2E tests (requires external verify-sandbox process + identity)
VERIFY_SANDBOX_PROCESS=/path/to/verify-sandbox \
VERIFY_SANDBOX_IDENTITY=verify-sandbox-process-0.1.0 \
VERIFY_SANDBOX_SNAPSHOT_ROOT=/path/to/snapshots \
VERIFY_SANDBOX_DOCKER_EXECUTABLE=/usr/bin/docker \
VERIFY_SANDBOX_DOCKER_HOST=unix:///var/run/docker.sock \
VERIFY_SANDBOX_SYSTEM_ROOT=/system \
VERIFY_SANDBOX_TEMP_ROOT=/tmp \
pnpm test -- tests/batch-43-real-sandbox.test.ts

# Run real sandbox E2E tests without gating (tests skip with explicit message)
pnpm test -- tests/batch-43-real-sandbox.test.ts
```

### Test coverage

- 26 tests across 2 describe blocks
- Host-subprocess (10 tests): Healthy fixture, failing-test, failing-typecheck, failing-build, transport boundary, no fallback, evidence provenance, policy/result, determinism, explicit skip
- Real sandbox (16 tests): Healthy fixture, failing-test, failing-typecheck, failing-build, execution provenance, snapshot identity/opaque, no host-side install, snapshot exclusion (all fixtures), snapshot content (all fixtures), executable permissions, snapshot reproducibility, explicit skip, no fallback, identity gate, determinism, wrapper git tracking
- Provisioning and gating tests run locally without the external sandbox
- Actual Docker-backed execution tests remain gated/skipped when the external Verify Sandbox is unavailable
- All tests skip with clear messages when environment is not configured

### Architecture

```text
fixture source files + sandbox-wrappers/ (Git-tracked wrapper scripts)
  ↓
clean snapshot provisioning (allowlist-based, materializes wrappers to node_modules/.bin/)
  ↓
createFileSystemDetectionContext()  [real, from @verify-agent/adapters-lang]
  ↓
createProjectDetectionService()    [real, from @verify-agent/adapters-lang]
  ↓
createCheckPlanner()               [real, from @verify-agent/checks]
  ↓
createSandboxExecutorFromTransport()  [real, from @verify-agent/engine]
  ↓
SubprocessSandboxTransport         [real — spawns sandbox-real-execution-harness.mjs]
  ↓
sandbox-real-execution-harness.mjs [real — executes pnpm exec tsc/vitest with shell:false]
  ↓
createCheckExecutor()              [real, from @verify-agent/engine]
  ↓
createVerificationPipeline()       [real, from @verify-agent/engine]
  ↓
aggregateVerification()            [real, from @verify-agent/engine]
  ↓
evaluateDefaultPolicy()            [real, from @verify-agent/policy]
  ↓
VerificationResult                 [executionSource: "real", content-hashed]
```

For real sandbox tests, the architecture is the same but the `SubprocessSandboxTransport` spawns the external `verify-sandbox` process instead of the local harness. The host provisions the snapshot store with clean allowlisted contents (source files + `sandbox-wrappers/` scripts); during provisioning, wrapper scripts are materialized as executable `node_modules/.bin/tsc` and `node_modules/.bin/vitest`. The sandbox Docker image provides pinned TypeScript 5.8.3 and Vitest 2.1.9 globally, so the sandbox can execute `pnpm exec tsc` and `pnpm exec vitest` without network access or runtime package installation.

---

## 20. Overclaim warning

> Passing VerifyAgent's unit/integration tests does not by itself prove that VerifyAgent correctly verifies arbitrary repositories.

The test suite proves:

- **Implementation correctness**: Each boundary works as designed (validators, parsers, mappers, aggregators)
- **Contract compliance**: Interfaces are satisfied, data flows correctly
- **Security properties**: Credential isolation, path safety, signature verification

The test suite does **not** prove:

- **Verification-system correctness**: That running VerifyAgent against a real repository produces the correct verification result
- **Sandbox reliability**: That the external sandbox correctly executes commands and returns structured results
- **GitHub integration correctness**: That the full webhook → source → verification → feedback path works in production

These can only be proven by the truth-test matrix against known repository outcomes with real sandbox execution.
