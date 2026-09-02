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

- `packages/domain`: internal semantic model, execution provenance, types, immutability rules, and contract mapping guidance.
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
- The sandbox boundary is expressed as an internal `SandboxExecutor` interface; execution details remain outside this repository. The opt-in real process adapter is configured with the trusted `VERIFY_SANDBOX_PROCESS` executable path and never falls back to a fake transport.

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

### Offline dependency provisioning

Checks that require project dependencies have a separate provisioning concern:

```text
DETECT → PLAN → PROVISION DEPENDENCIES → MATERIALIZE SOURCE → EXECUTE → EVIDENCE
```

The internal proof-of-concept models a dependency environment as an immutable,
content-addressed artifact identified by the source snapshot, manifest and
lockfile hashes, package-manager/toolchain versions, provisioning configuration,
and generated-artifact inputs. The fixture adapter only copies an operator-provided
artifact; it never runs installers, package scripts, postinstall hooks, or network
requests. Missing, unavailable, mismatched, or unsafe artifacts fail closed.

Batch 11 adds a pnpm-specific trusted-stage builder for a controlled fixture.
It creates a frozen, `--ignore-scripts` dependency tree from the supplied
manifest and lockfile, records a separate materialized-content hash, and makes
that artifact available to offline execution. The builder's explicit operator
environment is separate from repository metadata; runtime does not inherit its
network, credentials, or host `node_modules`. This is a proof of the boundary,
not a universal dependency manager.

Project source, dependencies, generated artifacts, and execution outputs remain
separate inputs. Dependency provisioning does not alter `ExecutionSource`: a real
sandbox using a trusted offline artifact remains `real`, while a fake sandbox
remains `simulated`. This is a controlled architectural proof, not production
dependency management.

Generated framework state is a separate prerequisite class. The builder records
inputs such as a TypeScript configuration for identity, but does not silently
create `.next/types` or other project-generated outputs. A future preparatory
stage must produce and attest those outputs before checks that require them.

The Batch 12 execution-environment boundary makes provisioning explicit in the
engine: a source snapshot, optional dependency environment, generated-artifact
descriptors, and stable environment identity are prepared before execution.
Provisioning failure is a distinct pipeline failure and prevents sandbox
execution. Dependency provenance participates in execution identity but never
rewrites real/simulated/fixture execution provenance.

Generated-artifact preparation is a separate trusted boundary. Requirements
are declarative, but artifact references and preparation policy come from the
operator. The current prebuilt strategy copies bounded, integrity-checked
output without executing repository scripts. The resulting generated artifact
set is composed into `ExecutionEnvironment` before `CheckExecutor`; failures
prevent execution and are not target-code failures.

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

### Optional AI reasoning boundary

AI is an optional semantic interpreter after deterministic evidence exists:

```text
CheckResults[] → Evidence → ┬→ deterministic Findings ─┐
                            └→ optional AI Reasoning ───┴→ Policy → VerificationResult
```

`packages/ai` accepts bounded context and evidence, labels repository-derived content as untrusted, validates structured provider output, and records deterministic/AI conflicts. It cannot rewrite `CheckResult`, evidence, or deterministic findings. No provider SDK is installed; provider failures do not invalidate deterministic verification by default.

Execution provenance is internal semantic data and fail-closed. `SandboxTransport.executionSource` is required and `CheckResult.executionSource` is explicit (`real`, `simulated`, or `fixture`) and propagated into evidence. Missing or unknown provenance is rejected; it is never interpreted as real execution. Only real successful execution contributes to production verified coverage; the current public contract has no provenance field.

## External boundaries

### `verify-contracts`

This repository consumes public contract definitions from the sibling repository. Public contracts remain stable and should be treated as the source of truth for wire semantics. Internal domain types may be similar but are not identical and are allowed to evolve independently.

### `verify-sandbox`

The sandbox is an external execution boundary. This repository communicates with it through `SandboxTransport` using the approved request/result contract, never by importing sandbox implementation code or calling Docker directly. The local adapter launches a trusted configured sandbox process using one JSON document per line; it does not provide sandbox isolation itself.

Batch 9 Part 1 validates this boundary with an optional integration test. When configured, the child receives an explicitly empty environment, structured JSON-line input, bounded messages, and real provenance. If the process or Docker backend is unavailable, the result remains a real-source error or the test is skipped; it is never downgraded to simulation.

Batch 9 Part 3 validated the configured Windows process path against the locally built `verify-sandbox` `verify-sandbox-process` binary and the approved `verify-agent/runner:development` image. A harmless Cargo version request completed successfully through Docker, and a controlled invalid Cargo argument returned a real completed non-zero failure. A single Stellar Forge `typescript.typecheck` attempt reached a real container but timed out before producing a result because the staged snapshot intentionally had no dependency tree and the approved network-disabled environment cannot install dependencies. This is an infrastructure/runtime limitation, not a successful or simulated verification. The sandbox source tree was not changed. Runtime flags are configured in the external backend; this repository does not claim kernel-level guarantees beyond those observable in the sandbox implementation.

### Future GitHub / AI / GOAT boundaries

- GitHub integration is a future application integration, not part of the core engine.
- AI reasoning is a separate provider-neutral layer. It interprets evidence but does not establish deterministic fact.
- GOAT remains a later phase and must not be required by the domain or engine packages.

## Architectural notes

- verification is evidence-first
- deterministic checks remain distinct from policy decisions
- immutable facts are documented and preserved by the domain model
- internal semantics may map onto public contract values explicitly and deliberately

Batch 14 adds `ExecutionEnvironmentMaterializer`, which composes trusted source,
offline dependency, and generated-artifact trees into the existing workspace.
It preserves stable identity and rejects unsafe entries and conflicts. The
real Docker fixture remains explicitly gated and requires an operator-supplied
offline artifact; it is not run by the normal suite.

Dependency artifacts are target-platform artifacts. Their identity includes the
operating system and architecture. Offline provisioning can require the runner
platform and rejects incompatible artifacts; Linux package launchers containing
Windows paths are rejected rather than rewritten. The Linux launcher validator
distinguishes actual Windows paths (`C:\Users\...`, `D:\project\...`,
`\\server\share\...`) from harmless source-code literals, format strings, and
escaped sequences such as `%s:\`. It requires a drive-letter colon and slash
followed by path content and excludes `%`-prefixed format specifiers, so the
`jsesc` launcher (`jsesc@%s:\n`) no longer triggers a false positive while real
drive-letter and UNC references remain rejected.
