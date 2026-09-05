# VerifyAgent

VerifyAgent is an evidence-first software-change verification platform. It turns a pull request or repository change into a structured verification flow that detects the project, plans relevant checks, executes them in a secure boundary, collects evidence, and applies policy before returning a final result.

## Current status

Phase 0 bootstrap is in progress. This repository establishes the product architecture, the internal domain model, the package boundaries, and the compile-safe interfaces required before later feature phases.

### Currently implemented

- Domain model with branded IDs, validation, and immutability
- Verification pipeline (detection → planning → execution → evidence → policy → result)
- GitHub webhook authentication (HMAC-SHA256 with timing-safe comparison)
- Replay protection (TTL-based reserve/commit/rollback)
- GitHub App authentication (RS256 JWT, installation token acquisition)
- GitHub API source provider (commit/tree/blob fetching at exact SHA)
- PR event parsing and immutable source reference construction
- Static project detection (TypeScript/JavaScript, Rust/Soroban)
- Deterministic check planning with dependency ordering
- Check definitions with trusted execution commands
- Subprocess-based sandbox transport boundary
- Dependency provisioning (offline pnpm artifacts)
- Generated artifact preparation
- Evidence aggregation and finding creation
- Deterministic policy evaluation (5 rules)
- VerificationResult assembly
- HTTP API server (health + verify endpoints)
- In-memory verification job queue

### Not yet implemented

- Background worker loop (no job polling, retry, or graceful shutdown)
- Durable job queue (Redis, SQS, etc.)
- GitHub feedback posting (PR comments, status checks)
- Docker/Kubernetes sandbox orchestration (lives in `verify-sandbox`)
- AI provider integrations (service layer exists, no provider SDK)
- GOAT integration
- Dashboard or marketplace features
- Database persistence

## Product flow

```text
GitHub Pull Request
       ↓
VerifyAgent
       ↓
Project Detection
       ↓
Check Planning
       ↓
Secure Execution
       ↓
Evidence
       ↓
AI reasoning where appropriate
       ↓
Policy
       ↓
VerificationResult
       ↓
GitHub feedback
```

## Supported ecosystems

Initial supported ecosystems are intentionally limited to the Phase 0 architecture boundary:

- TypeScript / JavaScript
- Rust / Soroban

The architecture is designed to support future ecosystems without changing the core engine, including:

- Python
- Go
- Solidity / EVM
- Java / Kotlin
- C#
- C / C++
- other ecosystems based on product need

## Repository relationships

```text
VerifyAgentHQ
│
├── verify-contracts
│     public contracts
│
├── verify-sandbox
│     secure execution
│
└── verify-agent
      verification product
```

This repository depends on the approved boundary contracts from `verify-contracts` and the isolated execution boundary from `verify-sandbox`. Those sibling repositories are authoritative; this repository does not modify them.

## Architecture overview

The product uses a ports-and-adapters structure with a central domain model and orchestration engine:

```text
DOMAIN
   ↓
ENGINE
   ↓
CHECKS / POLICY / AI
   ↓
APPLICATIONS
   ↓
EXTERNAL ADAPTERS
```

The system separates:

- immutable verification facts
- versioned definitions such as checks and policies
- external public contracts
- internal semantic models
- secure execution boundary concerns

## Phase 0 structure

```text
verify-agent/
├── README.md
├── AGENTS.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── pnpm-workspace.yaml
├── vitest.config.ts
├── apps/
│   ├── api/
│   ├── worker/
│   └── github-bot/
├── packages/
│   ├── domain/
│   ├── engine/
│   ├── checks/
│   ├── policy/
│   ├── adapters-lang/
│   ├── adapters-source/
│   ├── ai/
│   ├── goat/
│   └── config/
├── tests/
├── fixtures/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── DOMAIN-MODEL.md
│   ├── VERIFICATION-PIPELINE.md
│   └── decisions/
├── scripts/
├── infrastructure/
└── .github/
```

## Development commands

```bash
pnpm install --frozen-lockfile
pnpm format
pnpm format:check
pnpm typecheck
pnpm test
```

## Security statement

This Phase 0 bootstrap intentionally does not execute untrusted code inside the product repository. Execution is delegated to the external `verify-sandbox` boundary, which is the security-controlled environment. The product remains evidence-first and must not bypass public contracts or security boundaries.

## Roadmap summary

- Phase 0: architecture, boundaries, compile safety, contracts integration guidance, GitHub webhook/app auth, source acquisition, detection, planning, evidence, policy (IN PROGRESS)
- Phase 1: sandbox orchestration integration, real execution against target repositories
- Phase 2: durable worker/queue, GitHub feedback, production workflow
- Phase 3: AI reasoning provider integration, GOAT, ecosystem expansion
- later phases: additional ecosystems, operational maturity

For a detailed capability audit and verification readiness assessment, see `docs/verification-readiness.md`.
