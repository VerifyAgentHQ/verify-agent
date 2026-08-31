# Verification pipeline

The pipeline is staged so that static project detection is separated from check planning and execution.

```text
INGEST
  |
DETECT
  |
PLAN
  |
EXECUTE
  |
COLLECT
  |
ANALYZE
  |
POLICY
  |
RESULT
```

## Detection boundary

`packages/adapters-lang` receives a provider-neutral `Project`, an exact source snapshot, and a constrained read-only `DetectionContext`. Static detectors inspect filenames and metadata only. They return `DetectionObservation` values; the detection service aggregates those observations into a validated `ProjectProfile`.

Detection never installs dependencies, resolves packages, executes scripts or tools, invokes a shell, accesses the network, or calls the sandbox. Package metadata and Cargo manifests are treated as untrusted data.

The initial static signals cover TypeScript/JavaScript, Rust, Soroban-related metadata, pnpm/npm/yarn/Cargo lock or manifest signals, Next.js, React, Vite, Vitest, Jest, ESLint, Prettier, and lightweight repository structure. Capabilities in the profile indicate applicability only; they do not indicate that a check passed.

Filesystem safety is enforced at the inspection boundary. Paths are normalized and repository-root constrained; symbolic links and Windows reparse-point entries are skipped rather than followed. Recursive discovery is deterministic, capped at eight directory levels, and skips `.git`, `node_modules`, `target`, `.next`, `dist`, `build`, and `coverage` because these are generated, dependency, or otherwise heavy trees that do not provide authoritative project metadata. A platform that cannot create junctions for tests still receives the production guard; the test suite covers the guard where the OS permits junction creation.

## Planning boundary

`packages/checks` converts a validated `ProjectProfile` into one deterministic `CheckPlan`. The static check catalog contains stable check IDs and versions but no commands. Plan items record applicability, required/optional classification, reason, priority, repository scope, and simple dependencies. Applicability means a check appears relevant; it is not an execution result.

Planner configuration can require, optionally select, or disable checks. A configured check without a detected capability is represented as `unsupported` with an explanation. Disabled checks are represented as `not_applicable`. Plan content is canonicalized through stable ordering and hashed with SHA-256; planner version and a fixed planning timestamp make identical inputs produce identical plans without wall-clock or network dependencies.

## Execution boundary

`packages/engine` provides the application-side execution foundation. `CheckExecutor` selects a trusted structured execution specification from `packages/checks`, maps it to a sandbox request with explicit resource limits, no network, no artifacts, and an empty environment, then delegates through the `SandboxExecutor` port. `createSandboxExecutorFromTransport` connects that port to the provider-neutral `SandboxTransport` boundary. The included local adapter uses a trusted subprocess executable, structured stdin/stdout framing (one bounded JSON document per line), explicit empty environment, request/response validation, timeout, cancellation, and cleanup. It does not implement isolation; a configured executable must expose a compatible sandbox service.

Sandbox status and check status remain distinct: a completed zero exit code passes, a completed non-zero exit code fails, and timeout, cancellation, or sandbox errors retain their corresponding check status. Transport and protocol failures are rejected as infrastructure errors and never converted to a passing result.

The current `EXECUTE` stage is an application-side boundary, not a claim that VerifyAgent owns isolation. Tests use an in-memory fake transport and a deterministic protocol harness; no repository code, package manager, Cargo process, Docker runtime, or real target repository is invoked. The sibling `verify-sandbox` process entrypoint is compatible with this transport when supplied through trusted configuration; Docker-backed integration is intentionally separate from the normal suite.

Batch 9 Part 1 provides an opt-in real-process handshake through `VERIFY_SANDBOX_PROCESS`. The configured executable is launched directly without a shell and receives no ambient host environment. A missing executable skips only the dedicated integration test; it does not select a fake transport. A started process that reports Docker/backend unavailability remains `real` provenance with an infrastructure error and cannot contribute to verified coverage.

Batch 9 Part 2 built the sandbox process from the sibling workspace and exercised the real VerifyAgent transport path. Docker was not installed/available, so the sandbox process could not create a container; this is a real infrastructure-error condition, not simulated or verified execution. No Stellar Forge command was run.

## Deterministic result boundary

After check execution, Batch 6 normalizes each factual `CheckResult` into immutable `Evidence`, derives only evidence-backed `Finding` objects, evaluates the default versioned policy, and assembles an immutable `VerificationResult`. Failed, timed-out, errored, and cancelled checks create high-severity findings; skipped checks create no finding and contribute to partial coverage. Cancellation is therefore explicit and does not silently disappear.

The default policy maps required failures and high/critical findings to `block`, unsupported required capabilities or required non-real execution to `needs_changes`, and medium findings to `needs_review`. If policy allows but applicable capabilities remain unchecked or only synthetic results are available, the result is `partial`; otherwise real successful execution produces `pass`. An infrastructure `CheckResult` error maps to result `error` above policy outcome. Content hashes exclude timestamps and include semantic execution provenance.

Batch 8 dogfood is read-only. `CheckResult.executionSource` makes the distinction explicit: `real` results come through the sandbox execution boundary, while `simulated` and `fixture` values are controlled non-production inputs. Transport provenance is explicit and fail-closed; missing provenance is rejected and never treated as real. Synthetic results can exercise aggregation but never enter `verified` coverage or satisfy required production policy. They are not evidence that Stellar Forge commands ran.

## Optional AI reasoning

Batch 7 adds an explicit `AiReasoningService` after deterministic evidence. It supports only scope alignment, failure relevance, architecture consistency, finding prioritization, and summary tasks. Inputs are bounded and split into trusted task instructions versus untrusted repository-derived context. Structured outputs must identify the task, rationale, confidence, provider, and existing evidence references. AI confidence never overrides deterministic status, and contradictory interpretations are returned as inspectable conflicts. AI is not called automatically by the deterministic pipeline and no provider or network is required for normal operation.

## Later stages

- `PLAN`: convert applicable profile capabilities into an explicit, explainable check plan. Implemented in Phase 1 Batch 3; it does not execute checks.
- `EXECUTE`: application-side orchestration and transport boundary implemented in Batch 4 Part 3; the real sandbox process can be selected through trusted configuration, while Docker-backed integration remains separately gated.
- `COLLECT`: deterministic evidence and finding aggregation implemented in Phase 1 Batch 6.
- `POLICY`: deterministic default policy evaluation and outcome mapping implemented in Phase 1 Batch 6; AI interpretation remains later.
- `RESULT`: immutable deterministic `VerificationResult` assembly implemented in Phase 1 Batch 6.
