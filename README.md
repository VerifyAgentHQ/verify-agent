# VerifyAgent

VerifyAgent is a GitHub pull-request verification bot for explicit, machine-checkable requirements. It replaces vague "looks good" judgments with reproducible evidence, explicit policy, and machine-readable verification results.

```text
Software change / Pull Request
        |
        v
Authentication + source integrity
        |
        v
Exact revision acquisition
        |
        v
Project detection
        |
        v
PR/issue requirements + exact diff
        |
        v
GitHub Actions check-run evidence
        |
        v
Policy evaluation
        |
        v
VerificationResult
```

## What VerifyAgent does

A pull request arrives. VerifyAgent authenticates it, reads the issue/PR requirements and exact diff, consumes authoritative GitHub Actions check-runs, applies deterministic requirement rules, and publishes one evidence-linked result comment on the PR.

This is not an AI code review tool. VerifyAgent gathers **evidence** about a software change and applies **explicit policy** to determine whether the change meets verifiable criteria. AI reasoning, when present, interprets evidence but never overrides deterministic facts.

## Current MVP source of truth

```text
pull_request webhook -> queue/worker -> requirement and diff inspection
  -> GitHub Actions check-runs -> deterministic MVP verdict
  -> durable SQLite result -> one updated GitHub PR comment
```

GitHub Actions is authoritative for build, typecheck, lint, and test results. The custom `verify-sandbox` execution path and older local verification engine remain as frozen/legacy infrastructure; they are not authoritative for the GitHub PR MVP.

## Foundation Complete

The following capabilities are fully implemented and tested:

- GitHub webhook authentication (HMAC-SHA256 with timing-safe comparison)
- GitHub App authentication (RS256 JWT, installation token acquisition)
- Exact SHA source acquisition (commit/tree/blob fetching at exact SHA)
- Deterministic requirement evidence (file, diff, line, commit, and source links)
- Immutable durable MVP result (content-hashed, evidence-backed)
- Protected result observation (provider-neutral VerificationResultReader port, internal bearer token)
- GitHub Actions check-run consumption for authoritative CI evidence
- Real GitHub dogfood (single-process webhook → queue → requirement review → PR comment)
- Frozen sandbox and contract repositories retained separately for future work

## Current Product Status

> **VerifyAgent has a working GitHub PR MVP, validated against a real PR and GitHub App installation.**

The active path uses the authenticated webhook queue, deterministic PR requirement checks, GitHub check-run evidence, a durable SQLite result registry, and create-or-update PR comment publication. The legacy sandbox-backed engine is not part of the active verdict path. See [docs/RESULT-STORAGE.md](docs/RESULT-STORAGE.md) for the persistence and deployment contract.

## Repository structure

```text
verify-agent/
  apps/
    api/                    HTTP server (health + verify + async result endpoints)
    github-bot/             Webhook auth, replay guard, orchestrator
    worker/                 Job processor boundary
  packages/
    domain/                 Branded IDs, validation, immutability
    engine/                 Frozen legacy execution pipeline
    checks/                 Retained legacy check definitions
    policy/                 Retained policy model
    ai/                     Optional future explanation boundary (no SDK)
    adapters-lang/          Retained project detection abstractions
    adapters-source/        GitHub API source provider, App JWT auth
  tests/                    17 descriptive tests for the active boundary and retained models
  docs/                     Architecture, readiness audit, ADRs
```

The former host-execution CLI and truth-matrix fixtures were removed from the
active repository. The sandbox-backed engine remains only as frozen source for
future evaluation and compatibility work.

## Security model

- **Webhook integrity**: GitHub webhook signatures are verified over exact received bytes using HMAC-SHA256 with timing-safe comparison.
- **Replay protection**: TTL-based reserve/commit/rollback prevents webhook replay at the application boundary.
- **Source identity**: The PR head SHA is extracted, validated as 40-char hex, and used as the immutable source snapshot identity.
- **CI authority**: GitHub Actions is authoritative for build, typecheck, lint, and test results. VerifyAgent consumes those results and does not execute ordinary CI commands itself.
- **No active code execution**: the GitHub PR MVP does not execute repository code or depend on Docker/sandbox infrastructure.
- **Frozen boundary**: sandbox security claims apply only to the separate frozen sandbox project and are not claims about the active PR verifier.

The authenticated `POST /webhook` route is the GitHub production entrypoint.
The old synchronous `POST /verify` route is removed. Verification enters
through the authenticated GitHub webhook and queue; there is no unauthenticated
request path that can invoke verification directly.

See [docs/GITHUB-APP-DEPLOYMENT.md](docs/GITHUB-APP-DEPLOYMENT.md) for the
GitHub App installation contract, deployment requirements, and reproducible
local dogfood command.

The active API also has a reproducible container artifact (`Dockerfile`) and
an example single-instance deployment (`compose.example.yml`). The queue and
SQLite result store are durable across process restart, but multi-instance
coordination remains outside the current MVP.

### CI policy configuration

The `VERIFY_REQUIRED_CHECKS` environment variable defines the repository's
required GitHub check categories as a comma-separated list. If it is absent,
the fail-closed default is `Build,Typecheck,Lint,Tests`:

```text
VERIFY_REQUIRED_CHECKS=Typecheck
```

Only categories explicitly listed are required. A missing or wrong-SHA check
is `PENDING`, never `PASS`. A combined GitHub job may be mapped to one
category only when the repository policy intentionally makes that mapping;
VerifyAgent does not claim separate Build, Lint, or Tests evidence from a
combined job automatically. The policy identifier and version are persisted
with the MVP result and rendered in the PR comment.

The sandbox is not yet represented as a production-grade arbitrary-code multi-tenant isolation guarantee. Docker backend limitations are documented in the threat model.

## Quickstart

```bash
# Install dependencies
pnpm install --frozen-lockfile

# Format
pnpm format

# Check formatting
pnpm format:check

# Typecheck
pnpm typecheck

# Build
pnpm build

# Run tests
pnpm test
```

### Running active MVP tests

```bash
# MVP verdict and comment rendering
pnpm test -- tests/mvp-verdict.test.ts tests/mvp-comment.test.ts

# Webhook authentication, replay protection, and queue orchestration
pnpm test -- tests/github-webhook.test.ts tests/github-webhook-http.test.ts tests/github-verification-orchestration.test.ts
```

Sandbox execution tests are frozen historical coverage and are no longer part
of the active test tree.

## Verification pipeline

```text
GitHub Pull Request
        |
        v
HMAC-SHA256 authentication
        |
        v
Replay guard
        |
        v
PR event parsing -> immutable head SHA
        |
        v
GitHub App JWT -> installation -> token
PR/issue requirements + exact changed files/diff
        |
        v
GitHub Actions check-runs
        |
        v
Deterministic requirement checks + MVP verdict
        |
        v
Durable local result
        |
        v
One create-or-update GitHub PR comment
```

## Supported ecosystems

| Ecosystem         | Evidence consumed                  | Authority                 |
| ----------------- | ---------------------------------- | ------------------------- |
| TypeScript / Node | PR diff and GitHub Actions results | Repository GitHub Actions |

Additional ecosystems are future work and are not part of the active MVP.

## Productization Roadmap

### P1 — Baseline cleanup and documentation reconciliation

_Repository hygiene, permanent test classification, documentation accuracy_ ✓ **COMPLETE**

### P2 — Distributed verification lifecycle

_Replace the single-instance SQLite lifecycle with a multi-instance durable store_

- Preserves: VerificationResult model, policy semantics, evidence semantics, source identity, snapshot identity, dependency identity, and the frozen sandbox/check-publication contracts
- Adds: coordinated database/queue storage, multi-instance worker recovery,
  retries, and dead-letter handling

### P3 — Worker recovery and idempotent retries

_Background job polling, retry with backoff, graceful shutdown, dead-letter handling_

### P4 — Deployable production composition

_Docker/Kubernetes deployment, credential management, health checks, monitoring_

### P5 — Developer-facing result experience

_PR comments, commit statuses, merge protection, result dashboard_

### P6 — Operational hardening

_Rate limiting, multi-repository support, policy configurability, audit logging_

## P2 Boundary

P2 will replace the current single-instance SQLite queue and result registry as
the authoritative multi-instance lifecycle store. P2 must preserve:

- VerificationResult model
- Policy semantics
- Evidence semantics
- Source identity
- Snapshot identity
- Dependency identity
- Sandbox execution contract
- GitHub Check Run contract

The current MVP already has restart-safe SQLite queue/result storage for one
service instance. It does not claim multi-instance coordination.

## Documentation

| Document                     | Path                                                                     | Description                                              |
| ---------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| Architecture                 | `docs/ARCHITECTURE.md`                                                   | Layering, package responsibilities, dependency direction |
| Verification readiness       | `docs/verification-readiness.md`                                         | Full capability audit, stage-by-stage classification     |
| Sandbox contract integration | `docs/decisions/0009-verify-sandbox-contract-integration.md`             | Canonical request/result mapping, security properties    |
| Domain model                 | `docs/DOMAIN-MODEL.md`                                                   | Entity model, branded IDs, immutability rules            |
| Verification pipeline        | `docs/VERIFICATION-PIPELINE.md`                                          | Pipeline stages and data flow                            |
| ADRs                         | `docs/decisions/`                                                        | Architecture decision records                            |
| Security/threat model        | `verify-sandbox/docs/SECURITY.md`, `verify-sandbox/docs/THREAT-MODEL.md` | Sandbox threat model and security properties             |

## Repository relationships

```text
VerifyAgentHQ
  verify-contracts    Public contracts (canonical JSON schemas)
  verify-sandbox      Secure execution boundary (Rust, Docker)
  verify-agent        This repository (verification product)
```

This repository consumes public contracts from `verify-contracts` and communicates with the execution boundary in `verify-sandbox`. It does not modify either sibling repository.

## Contributing

See `AGENTS.md` for development workflow, architecture guardrails, and required checks. All changes must pass:

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
git diff --check
```

A change is not considered complete until the corresponding GitHub Actions CI run passes after it is pushed.

## License

See `LICENSE`.
