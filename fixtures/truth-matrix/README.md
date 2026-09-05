# Truth-Test Matrix

This document defines the known-truth test cases for VerifyAgent verification correctness.

## Purpose

Unit/integration tests prove implementation correctness. The truth-test matrix defines verification-system correctness: the expected results when VerifyAgent runs against known repository snapshots. These fixtures currently encode known expected outcomes; the execution harness to run them end-to-end is not yet complete.

## Design principle

Each fixture is a known-truth repository snapshot that:

1. Encodes a deterministic, known expected verification outcome
2. Is designed to be materialized by `ExecutionEnvironmentMaterializer`
3. Is intended to be provisioned with offline dependencies (or have no dependencies)
4. Is intended to be executed in the sandbox with `networkPolicy: none`

> **Current status (Batch 39)**: The source fixtures are deterministic inputs with known expected outcomes. Batch 39 provides a deterministic integration harness that exercises the existing detection → planning → execution-boundary → evidence → policy → result composition using controlled test execution results. This proves pipeline composition correctness but does not prove real sandbox execution. Batch 40 remains responsible for real `verify-sandbox` lifecycle integration.

## TypeScript / JavaScript fixtures

### `fixtures/truth-matrix/typescript/healthy/`

**Source**: Minimal TypeScript project with passing typecheck and tests.

**Expected result**: `pass` (all required checks executed with `real` provenance)

**Checks and expected outcomes**:

| Check                  | Command                  | Expected status |
| ---------------------- | ------------------------ | --------------- |
| `typescript.typecheck` | `pnpm exec tsc --noEmit` | passed          |
| `typescript.test`      | `pnpm exec vitest run`   | passed          |

**Verification result**: `pass` with `verified` coverage for both checks.

### `fixtures/truth-matrix/typescript/failing-test/`

**Source**: TypeScript project with a test that asserts `1 + 2 === 4`.

**Expected result**: `blocked` (required test check failed)

**Checks and expected outcomes**:

| Check                  | Command                  | Expected status |
| ---------------------- | ------------------------ | --------------- |
| `typescript.typecheck` | `pnpm exec tsc --noEmit` | passed          |
| `typescript.test`      | `pnpm exec vitest run`   | failed          |

**Verification result**: `blocked` with `required-check-failure` policy rule triggered.

### `fixtures/truth-matrix/typescript/failing-typecheck/`

**Source**: TypeScript project with a type error (`number + string`).

**Expected result**: `blocked` (required typecheck check failed)

**Checks and expected outcomes**:

| Check                  | Command                  | Expected status |
| ---------------------- | ------------------------ | --------------- |
| `typescript.typecheck` | `pnpm exec tsc --noEmit` | failed          |

**Verification result**: `blocked` with `required-check-failure` policy rule triggered.

### `fixtures/truth-matrix/typescript/failing-build/`

**Source**: TypeScript project with a build error (assigning `number` to `string`).

**Expected result**: `blocked` (required build check failed)

**Checks and expected outcomes**:

| Check              | Command            | Expected status |
| ------------------ | ------------------ | --------------- |
| `typescript.build` | `pnpm exec tsc -b` | failed          |

**Verification result**: `blocked` with `required-check-failure` policy rule triggered.

## Rust fixtures

### `fixtures/truth-matrix/rust/healthy/`

**Source**: Minimal Rust library with passing tests.

**Expected result**: `pass` (all required checks executed with `real` provenance)

**Checks and expected outcomes**:

| Check         | Command                       | Expected status |
| ------------- | ----------------------------- | --------------- |
| `rust.check`  | `cargo check`                 | passed          |
| `rust.test`   | `cargo test`                  | passed          |
| `rust.clippy` | `cargo clippy -- -D warnings` | passed          |

**Verification result**: `pass` with `verified` coverage for all checks.

### `fixtures/truth-matrix/rust/failing-test/`

**Source**: Rust library with a test that asserts `1 + 2 == 4`.

**Expected result**: `blocked` (required test check failed)

**Checks and expected outcomes**:

| Check         | Command                       | Expected status |
| ------------- | ----------------------------- | --------------- |
| `rust.check`  | `cargo check`                 | passed          |
| `rust.test`   | `cargo test`                  | failed          |
| `rust.clippy` | `cargo clippy -- -D warnings` | passed          |

**Verification result**: `blocked` with `required-check-failure` policy rule triggered.

### `fixtures/truth-matrix/rust/failing-build/`

**Source**: Rust library with a type error (adding `i32` to `String`).

**Expected result**: `blocked` (required check/build failed)

**Checks and expected outcomes**:

| Check         | Command                       | Expected status               |
| ------------- | ----------------------------- | ----------------------------- |
| `rust.check`  | `cargo check`                 | failed                        |
| `rust.test`   | `cargo test`                  | skipped (prerequisite failed) |
| `rust.clippy` | `cargo clippy -- -D warnings` | skipped (prerequisite failed) |

**Verification result**: `blocked` with `required-check-failure` policy rule triggered.

## How to use these fixtures

### 1. Deterministic integration harness (Batch 39)

The truth-matrix test suite (`tests/truth-matrix.test.ts`) exercises the existing verification pipeline against all 7 fixtures using a deterministic test adapter:

```bash
pnpm test -- tests/truth-matrix.test.ts
```

The harness wires:

- **Detection**: `createProjectDetectionService()` from `@verify-agent/adapters-lang`
- **Planning**: `createCheckPlanner()` from `@verify-agent/checks`
- **Execution**: Deterministic test adapter (`executionSource: "simulated"`)
- **Evidence**: `aggregateVerification()` from `@verify-agent/engine`
- **Policy**: `evaluateDefaultPolicy()` from `@verify-agent/policy`

This is integration validation, not real sandbox execution. The test adapter produces structured results based on fixture metadata.

### 2. Manual verification (requires external sandbox)

With a configured sandbox process:

```bash
VERIFY_SANDBOX_PROCESS=/path/to/verify-sandbox-process \
VERIFY_GITHUB_APP_ID=... \
VERIFY_GITHUB_APP_PRIVATE_KEY=... \
pnpm test
```

### 2. Integration tests (gated, currently skipped)

```bash
VERIFY_REAL_SANDBOX=1 \
VERIFY_SANDBOX_PROCESS=/path/to/verify-sandbox-process \
pnpm test -- --grep "truth-matrix"
```

### 3. Future CI

Automated runs against each fixture, asserting the expected `VerificationResult.status` and `VerificationCoverage`. This requires the execution harness and sandbox integration to be completed first.

## Extending the matrix

To add a new fixture:

1. Create a directory under `fixtures/truth-matrix/<ecosystem>/<scenario>/`
2. Include all necessary source files and configuration
3. Document the expected result in this file
4. Add a gated integration test that materializes and executes the fixture (requires sandbox integration)
5. Assert the expected `VerificationResult.status` and `VerificationCoverage`
