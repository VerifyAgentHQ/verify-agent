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

`packages/engine` provides the application-side execution foundation. `CheckExecutor` selects a trusted structured execution specification from `packages/checks`, maps it to a sandbox request with explicit resource limits, no network, no artifacts, and an empty environment, then delegates through the `SandboxExecutor` port. Sandbox status and check status remain distinct: a completed zero exit code passes, a completed non-zero exit code fails, and timeout, cancellation, or sandbox errors retain their corresponding check status.

The current `EXECUTE` stage is orchestration only. Tests use an in-memory fake executor; no repository code, package manager, Cargo process, Docker runtime, or real sandbox is invoked.

## Later stages

- `PLAN`: convert applicable profile capabilities into an explicit, explainable check plan. Implemented in Phase 1 Batch 3; it does not execute checks.
- `EXECUTE`: application-side orchestration foundation implemented in Batch 4 Part 1; real untrusted-code execution through `verify-sandbox` remains a later phase.
- `COLLECT`, `ANALYZE`, `POLICY`, and `RESULT`: assemble evidence, findings, decisions, and final results in later phases.
