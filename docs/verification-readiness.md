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

> **Current status**: The source fixtures are deterministic inputs with known expected outcomes. TypeScript fixtures depend on packages (TypeScript, Vitest, etc.) without committed lockfiles or approved dependency artifacts, so they currently require dependency provisioning before execution. Offline/reproducible execution will be established later as part of real sandbox/execution integration. The truth matrix is currently a specification/fixture set, not yet a completed end-to-end execution harness.

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

| Batch     | Focus                                                              | Rationale                                                                                                                                                                 |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **39**    | Truth-matrix execution harness + verification-pipeline integration | **DONE.** Deterministic harness exercises detection → planning → execution-boundary → evidence → policy → result against 7 known-truth fixtures with simulated execution. |
| **40**    | Real verify-sandbox lifecycle integration                          | Integrate external sandbox process for real command execution                                                                                                             |
| **41**    | Evidence/provenance validation using real execution results        | Validate evidence model against actual sandbox output                                                                                                                     |
| **42**    | Policy + VerificationResult validation against the truth matrix    | Prove policy decisions and final results match known expected outcomes                                                                                                    |
| **43**    | Real TypeScript/JavaScript end-to-end verification                 | Run `tsc --noEmit`, `eslint`, `vitest` against real snapshot in sandbox, produce real evidence                                                                            |
| **44**    | Real Rust/Soroban end-to-end verification                          | Extend to Rust ecosystem with real `cargo check`, `cargo test`, `cargo clippy`                                                                                            |
| **45+**   | Durable queue + worker lifecycle + production hardening            | Redis/SQS/BullMQ, retry, backoff, graceful shutdown, monitoring                                                                                                           |
| **Later** | GitHub feedback                                                    | PR comments, status checks                                                                                                                                                |
| **Later** | AI-assisted reasoning                                              | Provider integration, prompt optimization                                                                                                                                 |
| **Later** | Additional ecosystem support                                       | Python, Go, Solidity, etc.                                                                                                                                                |

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

## 16. Overclaim warning

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
