# VerifyAgent architecture

## Purpose

VerifyAgent is an evidence-first verification platform for software changes. The product consumes public contract semantics from `verify-contracts`, communicates with the isolated execution boundary in `verify-sandbox`, and keeps its internal semantic model separate from public wire formats.

## Layering

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

## Package responsibilities

- `packages/domain`: internal semantic model, types, provenance, immutability rules, and contract mapping guidance.
- `packages/engine`: orchestration boundaries for project detection, check planning, execution coordination, evidence assembly, and final result shaping.
- `packages/checks`: check definitions and execution model. Checks establish facts; they do not decide policy.
- `packages/policy`: policy evaluation that interprets evidence and determines a decision.
- `packages/ai`: provider-neutral reasoning boundary. AI interprets evidence; it does not establish deterministic truth.
- `packages/adapters-source`: source-of-truth adapter boundary for repository metadata and change set extraction.
- `packages/adapters-lang`: language detection and project profile abstraction for TypeScript, Rust, and future ecosystems.
- `packages/config`: runtime configuration abstraction without environment-specific runtime dependencies.
- `packages/goat`: reserved future boundary; intentionally absent from implementation logic in Phase 0.
- `apps/api`, `apps/worker`, `apps/github-bot`: service and integration shell boundaries only.

## Dependency direction

The runtime dependency direction is intentionally one-way and should be maintained by reviewers:

```text
domain
  ↓
engine
  ↓
checks / policy / ai
  ↓
applications
  ↓
external adapters
```

This means domain entities and engine orchestration avoid importing GitHub, AI-provider, GOAT, Docker, and sandbox implementation libraries.

## Ports and adapters

- Source adapters satisfy the `SourceProvider` contract and provide repository metadata, source state, and change data.
- Language adapters satisfy `LanguageAdapter` and provide project detection and ecosystem capabilities.
- The engine depends on stable interfaces instead of concrete provider code.
- The sandbox boundary is expressed as an internal `SandboxExecutor` interface; execution details remain outside this repository.

### Check execution boundary

`packages/checks` owns trusted, structured execution specifications for catalogued checks. `packages/engine` maps a queued `CheckExecution` to an internal sandbox request and delegates through `SandboxExecutor` and `SandboxTransport`:

```text
CheckExecutor
     ↓
SandboxExecutor interface
     ↓
future verify-sandbox implementation
```

Batch 4 Part 1 provides application-side orchestration; Batch 4 Part 3 adds the transport boundary and a bounded local subprocess adapter. VerifyAgent still does not execute commands itself, invoke Docker, or implement sandbox isolation.

### Evidence and result boundary

```text
CheckResult[]
     ↓
Evidence
     ↓
Finding
     ↓
PolicyEvaluator
     ↓
PolicyDecision
     ↓
VerificationResult
```

Evidence and findings are deterministic, traceable facts. Policy interprets those facts but cannot rewrite check results. The Batch 6 default evaluator is provider-independent and does not call AI or execute code.

## External boundaries

### `verify-contracts`

This repository consumes public contract definitions from the sibling repository. Public contracts remain stable and should be treated as the source of truth for wire semantics. Internal domain types may be similar but are not identical and are allowed to evolve independently.

### `verify-sandbox`

The sandbox is an external execution boundary. This repository communicates with it through `SandboxTransport` using the approved request/result contract, never by importing sandbox implementation code or calling Docker directly. The local adapter launches a trusted configured sandbox process using one JSON document per line; it does not provide sandbox isolation itself.

### Future GitHub / AI / GOAT boundaries

- GitHub integration is a future application integration, not part of the core engine.
- AI reasoning is a separate provider-neutral layer. It interprets evidence but does not establish deterministic fact.
- GOAT remains a later phase and must not be required by the domain or engine packages.

## Architectural notes

- verification is evidence-first
- deterministic checks remain distinct from policy decisions
- immutable facts are documented and preserved by the domain model
- internal semantics may map onto public contract values explicitly and deliberately
