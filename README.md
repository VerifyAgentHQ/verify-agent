# VerifyAgent

VerifyAgent is an evidence-first verification engine for software changes. It replaces vague "looks good" judgments with reproducible checks, traceable evidence, explicit policy, and machine-readable verification results.

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
Verification planning
        |
        v
Checks / isolated execution
        |
        v
Evidence collection
        |
        v
Policy evaluation
        |
        v
VerificationResult
```

## What VerifyAgent does

A pull request arrives. VerifyAgent authenticates it, resolves the exact source revision, detects the project type, plans applicable checks, executes them in an isolated boundary, collects structured evidence, applies deterministic policy, and produces an immutable `VerificationResult`.

This is not an AI code review tool. VerifyAgent gathers **evidence** about a software change and applies **explicit policy** to determine whether the change meets verifiable criteria. AI reasoning, when present, interprets evidence but never overrides deterministic facts.

## Current status

The verification core is implemented and tested. The pipeline from webhook authentication through source acquisition, project detection, check planning, sandbox transport, evidence aggregation, policy evaluation, and `VerificationResult` assembly is functional. Real TypeScript/JavaScript end-to-end verification is covered by host-subprocess tests and a gated external-sandbox test suite; Docker-backed execution requires the external `verify-sandbox` environment.

### Implemented

| Capability                  | Status      | Detail                                                            |
| --------------------------- | ----------- | ----------------------------------------------------------------- |
| Domain model                | Implemented | Branded IDs, validation, immutability, entity model (~750+ lines) |
| Verification pipeline       | Implemented | Detection, planning, execution, evidence, policy, result          |
| GitHub webhook auth         | Implemented | HMAC-SHA256 with timing-safe comparison                           |
| Replay protection           | Implemented | TTL-based reserve/commit/rollback                                 |
| GitHub App auth             | Implemented | RS256 JWT, installation token acquisition                         |
| Source snapshot acquisition | Implemented | Commit/tree/blob fetching at exact SHA                            |
| Project detection           | Implemented | TypeScript/JavaScript and Rust/Soroban static detection           |
| Check planning              | Implemented | Deterministic, content-hashed, dependency-ordered                 |
| Check definitions           | Implemented | 11 definitions, 8 with executable specs                           |
| Sandbox transport           | Implemented | Subprocess-based with bounded I/O, timeout, abort                 |
| Evidence aggregation        | Implemented | Deterministic, content-hashed findings                            |
| Policy evaluation           | Implemented | 5 deterministic rules, provider-independent                       |
| VerificationResult          | Implemented | Immutable, content-hashed result assembly                         |
| TypeScript E2E tests        | Implemented | 10 host-subprocess tests, 16 real sandbox tests                   |
| Truth-matrix fixtures       | Implemented | 7 known-truth TypeScript and Rust snapshots                       |
| API server                  | Implemented | HTTP health + verify endpoints                                    |
| Worker boundary             | Implemented | Validates and delegates to application service                    |

### Partial / conditional

| Capability       | Status  | Blocker                                              |
| ---------------- | ------- | ---------------------------------------------------- |
| Secure execution | Partial | Requires external `verify-sandbox` process or Docker |
| Worker loop      | Partial | No background polling, retry, or graceful shutdown   |
| Queue durability | Partial | In-memory only; no Redis/SQS                         |

### Not yet implemented

- Background worker loop (job polling, retry, graceful shutdown)
- Durable job queue (Redis, SQS, BullMQ)
- GitHub feedback posting (PR comments, status checks)
- AI provider SDK integration (service layer exists; no provider installed)
- GOAT integration
- Dashboard, marketplace, or payment features
- Database persistence

## Repository structure

```text
verify-agent/
  apps/
    api/                    HTTP server (health + verify endpoints)
    github-bot/             Webhook auth, replay guard, orchestrator
    worker/                 Job processor boundary
  packages/
    domain/                 Branded IDs, validation, immutability
    engine/                 Pipeline, execution, aggregation, sandbox transport
    checks/                 Check definitions, planner, execution specs
    policy/                 Deterministic policy evaluator (5 rules)
    ai/                     Provider-neutral reasoning boundary (no SDK)
    adapters-lang/          TypeScript + Rust project detection
    adapters-source/        GitHub API source provider, App JWT auth
    config/                 Configuration type definitions
    goat/                   Reserved namespace (placeholder)
  tests/                    41 test files covering all boundaries
  fixtures/truth-matrix/    Known-truth TypeScript and Rust snapshots
  docs/                     Architecture, readiness audit, ADRs
```

## Security model

- **Webhook integrity**: GitHub webhook signatures are verified over exact received bytes using HMAC-SHA256 with timing-safe comparison.
- **Replay protection**: TTL-based reserve/commit/rollback prevents webhook replay at the application boundary.
- **Source identity**: The PR head SHA is extracted, validated as 40-char hex, and used as the immutable source snapshot identity.
- **Sandbox isolation**: Untrusted code execution is delegated to the external `verify-sandbox` boundary. VerifyAgent does not execute repository commands itself.
- **Fail-closed transport**: `SubprocessSandboxTransport` uses `shell: false`, no host environment inheritance, bounded I/O, timeout enforcement, and JSON-lines protocol validation.
- **Provenance tracking**: Execution source (`real`, `simulated`, `fixture`) is immutable per transport instance and propagated through the entire evidence chain.

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

# Run tests
pnpm test
```

### Running E2E verification tests

```bash
# Host-subprocess TypeScript E2E (no Docker required)
$env:VERIFY_REAL_SANDBOX="1"
pnpm test -- tests/batch-43-typescript-e2e.test.ts

# Real sandbox E2E (requires external verify-sandbox + Docker)
$env:VERIFY_SANDBOX_PROCESS="/path/to/verify-sandbox"
$env:VERIFY_SANDBOX_IDENTITY="verify-sandbox-process-0.1.0"
pnpm test -- tests/batch-43-real-sandbox.test.ts
```

Tests skip with clear messages when environment gates are not configured.

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
        |
        v
Source snapshot at exact SHA
        |
        v
VerificationQueueJob
        |
        v
Worker -> ApplicationService.verifySource()
        |
        v
Project detection (TypeScript/JavaScript, Rust/Soroban)
        |
        v
Check planning (deterministic, dependency-ordered)
        |
        v
Sandbox execution (isolated boundary)
        |
        v
Evidence aggregation
        |
        v
Policy evaluation (5 deterministic rules)
        |
        v
VerificationResult (immutable, content-hashed)
```

## Supported ecosystems

| Ecosystem               | Checks                             | Commands                                                    |
| ----------------------- | ---------------------------------- | ----------------------------------------------------------- |
| TypeScript / JavaScript | typecheck, lint, test, build       | `tsc --noEmit`, `eslint .`, `vitest run`, `tsc -b`          |
| Rust / Soroban          | check, test, clippy, contract-test | `cargo check`, `cargo test`, `cargo clippy`, `soroban test` |

The architecture supports adding new ecosystems by implementing a `ProjectDetector` and execution specs without changing the domain, engine, checks, or policy packages.

## Roadmap

### Current

- Verification core (domain, engine, checks, policy)
- Sandbox integration architecture and E2E test coverage
- Real TypeScript/JavaScript sandbox E2E verification
- Truth-matrix fixtures (7 known-truth snapshots)

### Next

- Real Rust/Soroban E2E verification
- Further sandbox validation
- Durable execution infrastructure (workers, queue)
- Production hardening (monitoring, rate limiting, credential management)
- GitHub developer feedback loop (PR comments, status checks)

### Longer-term

- AI-assisted reasoning after deterministic evidence
- Additional ecosystem support (Python, Go, Solidity, Java, C/C++)
- Agent interfaces, specialist verification agents

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
pnpm test
```

## License

See `LICENSE`.
