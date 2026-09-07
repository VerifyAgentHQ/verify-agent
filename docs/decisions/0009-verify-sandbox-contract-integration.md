# ADR-0009: Verify Sandbox Contract Integration

Date: 2026-09-05
Status: Accepted (Batch 41)

---

## Context

VerifyAgent needs to execute untrusted repository code (TypeScript typechecking, Rust builds, etc.) as part of its verification pipeline. The execution boundary must be:

- **Isolated** — untrusted code runs outside the VerifyAgent process
- **Contract-governed** — wire format is defined by canonical JSON Schemas in `verify-contracts`
- **Fail-closed** — malformed or unsafe requests/results are rejected
- **Observable** — execution source and provenance are tracked

The canonical sandbox contracts live in `verify-contracts/schemas/sandbox/`:

- `sandbox-job-request.schema.json` (version 1.0.0)
- `sandbox-job-result.schema.json` (version 1.0.0)

The sandbox execution backend is `verify-sandbox`, a Rust workspace that implements:

- Protocol validation (`crates/protocol`)
- Docker-based isolation (`crates/isolation`)
- JSON-lines process entrypoint (`crates/runner`)

VerifyAgent communicates with the sandbox process via a single JSON request on stdin and a single JSON result on stdout per process invocation.

---

## Decision

### 1. Contract ownership

The **public wire contract** belongs to `verify-contracts`. VerifyAgent maintains internal typed representations (`SandboxJobRequest` with typed `SandboxCommand[]`) for compile-safe domain logic, but the wire format uses JSON-serialized command strings matching the canonical schema exactly.

### 2. Request mapping

```
CheckExecutor
  → CheckExecutionRequest
  → mapCheckExecutionToSandboxJobRequest()
  → SandboxJobRequest (internal, typed commands)
  → toPublicSandboxJobRequest()
  → PublicSandboxJobRequest (wire format, JSON-stringified commands)
  → SubprocessSandboxTransport.execute()
  → verify-sandbox process
```

Key mapping decisions:

| VerifyAgent field            | Canonical field  | Mapping                                                        |
| ---------------------------- | ---------------- | -------------------------------------------------------------- |
| `execution.jobId`            | `jobId`          | Direct pass-through (branded VerificationJobId)                |
| `snapshot.sourceState.value` | `snapshot`       | Opaque identity string — never a filesystem path               |
| `snapshot.source`            | `source`         | `{provider, reference}` pass-through                           |
| Trusted execution spec       | `commands[0]`    | JSON-serialized `ApprovedCommand` record                       |
| `DEFAULT_EXECUTION_LIMITS`   | `resourceLimits` | Deterministic defaults: 120s timeout, 512 MiB memory           |
| Hardcoded policy             | `networkPolicy`  | `"none"` — only safe default for Docker backend                |
| Hardcoded policy             | `artifactPolicy` | `"none"` — declared artifacts not supported in public contract |

### 3. Command representation

Each `commands[]` string is a JSON-serialized `ApprovedCommand` record:

```json
{
  "executable": "pnpm",
  "args": ["exec", "tsc", "--noEmit"],
  "workingDirectory": ".",
  "environment": {}
}
```

The sandbox backend parses this JSON and validates:

- Only `pnpm` or `cargo` executables
- No shell metacharacters
- No path-containing executables
- No inherited environment variables
- `workingDirectory` must be `"."`

### 4. Snapshot semantics

The `snapshot` field is an **opaque identity**, not a filesystem path. VerifyAgent uses the immutable `sourceState.value` from `RepositorySnapshot`. The sandbox operator resolves this identity to a materialized source directory via `VERIFY_SANDBOX_SNAPSHOT_ROOT`.

VerifyAgent must NOT send:

- Absolute filesystem paths
- Host environment paths
- `VERIFY_SANDBOX_SNAPSHOT_ROOT`
- Docker mount information

### 5. Resource limits

| Parameter          | Default               | Contract max              | Backend max           |
| ------------------ | --------------------- | ------------------------- | --------------------- |
| `timeoutMs`        | 120,000               | none (integer >= 1)       | 3,600,000 (1 hour)    |
| `memoryLimitBytes` | 536,870,912 (512 MiB) | 1,099,511,627,776 (1 TiB) | 4,294,967,296 (4 GiB) |

VerifyAgent expresses requested limits; the sandbox enforces caps.

### 6. Network policy

The Docker backend explicitly rejects `restricted` and `allowlist` network policies because it cannot enforce them safely. Only `none` is supported in the current integration.

VerifyAgent hardcodes `networkPolicy: "none"`. This is the only safe default for Batch 41.

### 7. Artifact policy

The public contract declares `artifactPolicy: "none" | "declared"`, but the sandbox backend rejects `declared` because the public contract does not carry declared artifact paths. VerifyAgent uses `artifactPolicy: "none"`.

### 8. Result mapping

```
verify-sandbox process
  → SandboxJobResult (JSON on stdout)
  → validateSandboxJobResult()
  → SandboxJobResult (validated)
  → mapSandboxJobResultToCheckResult()
  → CheckResult (domain model)
```

Terminal status mapping:

| Sandbox status           | Check status |
| ------------------------ | ------------ |
| `completed` + exitCode=0 | `passed`     |
| `completed` + exitCode≠0 | `failed`     |
| `failed`                 | `error`      |
| `timed_out`              | `timed_out`  |
| `cancelled`              | `cancelled`  |
| `error`                  | `error`      |

### 9. Transport responsibility

`SubprocessSandboxTransport` is responsible for:

- `shell: false` — no command injection
- Bounded I/O — max message size, max stderr
- Timeout enforcement
- Cancellation via AbortSignal
- JSON-lines protocol purity (one request, one result)
- Result validation at the boundary
- Cleanup of spawned process

### 10. Lifecycle ownership

VerifyAgent does NOT reproduce the sandbox lifecycle internally:

```
RECEIVED → VALIDATING → ACCEPTED → PROVISIONING → RUNNING → COLLECTING → CLEANUP → RESULT
```

This lifecycle belongs entirely to `verify-sandbox`. VerifyAgent only:

1. Starts the external process
2. Submits the request
3. Reads the result
4. Distinguishes protocol failure from valid result
5. Enforces transport timeout/cancellation
6. Cleans up the process

---

## Provenance

| Execution path                      | `executionSource` |
| ----------------------------------- | ----------------- |
| `SubprocessSandboxTransport`        | `"real"`          |
| `FakeSandboxTransport`              | `"simulated"`     |
| `createDeterministicTestExecutor()` | `"simulated"`     |

The `executionSource` is immutable per transport instance and propagated through:

```
transport.executionSource → executor.executionSource → execution.executionSource → result.executionSource
```

---

## Security properties preserved

- `shell: false` in `spawn()` — no command injection
- No host environment inheritance to sandbox process
- No credential forwarding (GitHub tokens, keys, etc.)
- Immutable snapshot identity binding
- Bounded resource limits (timeout, memory)
- Fail-closed protocol validation
- Job identity verification (result.jobId must match request.jobId)
- Process cleanup after timeout/cancellation/failure

---

## Current limitations

1. **Docker is not production-grade multi-tenant isolation** — The verify-sandbox documentation explicitly identifies Docker residual risks. Hardened isolation requires a separate security review.

2. **Network policy limited to `none`** — `restricted` and `allowlist` are rejected by the Docker backend. Only `none` is safe.

3. **Artifact policy limited to `none`** — `declared` artifacts are not supported because the public contract does not carry declared artifact paths.

4. **One request per process invocation** — The documented model spawns a new process for each request. Persistent multi-request processes are not supported in Batch 41.

5. **Real sandbox not required for unit tests** — The test harness fixture (`sandbox-harness.mjs`) proves protocol behavior without Docker. Real integration requires `VERIFY_SANDBOX_PROCESS` environment.

---

## Testing

Batch 41 adds comprehensive test coverage in `tests/sandbox-contract.integration.test.ts`:

| Category               | Tests                                                           |
| ---------------------- | --------------------------------------------------------------- |
| Contract validation    | 25+ request/result validation cases                             |
| Job identity           | Mismatched jobId rejection                                      |
| Transport protocol     | JSON-lines, malformed, EOF, extra output, timeout, cancellation |
| Security               | shell:false, env isolation, command format, snapshot opacity    |
| Result handling        | All terminal status mappings, resource usage, errors, artifacts |
| Command representation | Spec→command→JSON argv mapping, trusted spec rejection          |
| Snapshot semantics     | Opaque identity verification                                    |
| Resource limits        | Default values, bounds, pass-through                            |
| Provenance             | Real vs simulated, producer propagation                         |
| Schema edge cases      | Null, wrong types, missing fields, boundary values              |
| Mode A (harness)       | Full pipeline through test fixture                              |
| Mode B (real)          | Gated against real verify-sandbox                               |
| Harness scenarios      | 10+ enhanced failure modes                                      |

---

## References

- `verify-contracts/schemas/sandbox/sandbox-job-request.schema.json`
- `verify-contracts/schemas/sandbox/sandbox-job-result.schema.json`
- `verify-contracts/schemas/common/common.schema.json`
- `verify-sandbox/crates/protocol/src/lib.rs`
- `verify-sandbox/crates/isolation/src/lib.rs`
- `verify-sandbox/crates/runner/src/lib.rs`
- `verify-sandbox/docs/EXECUTION-MODEL.md`
- `verify-sandbox/docs/SECURITY.md`
- `verify-sandbox/docs/THREAT-MODEL.md`
- `verify-agent/packages/engine/src/sandbox-transport.ts`
- `verify-agent/packages/engine/src/execution.ts`
- `verify-agent/packages/engine/src/interfaces.ts`
