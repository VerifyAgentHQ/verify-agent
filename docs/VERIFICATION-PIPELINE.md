# Verification pipeline

The pipeline is staged so that static project detection is separated from check planning and execution.

```text
INGEST
  |
DETECT  <-- Phase 1 Batch 2 ends here
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

## Later stages

- `PLAN`: convert applicable profile capabilities into check definitions. Not implemented in this batch.
- `EXECUTE`: run approved checks through the external sandbox boundary. Not implemented here.
- `COLLECT`, `ANALYZE`, `POLICY`, and `RESULT`: assemble evidence, findings, decisions, and final results in later phases.
