# Domain model

The domain is deterministic, provider-independent, runtime-independent, and persistence-independent. Its implementation is split into focused modules under `packages/domain/src/`.

## Entities

| Entity                            | Purpose                                                          | Semantics            |
| --------------------------------- | ---------------------------------------------------------------- | -------------------- |
| `Project`                         | Stable product identity and repository root                      | Reference data       |
| `SourceReference` / `SourceState` | Provider-neutral source identity and exact commit/snapshot state | Read-only values     |
| `RepositorySnapshot`              | Exact source state evaluated for a run                           | Immutable fact       |
| `ChangeSet` / `ChangedFile`       | Normalized changes between source states                         | Immutable fact       |
| `ProjectProfile`                  | Detection output for one snapshot                                | Immutable snapshot   |
| `VerificationRequest`             | Requested scope, actor, mode, checks, and policy                 | Immutable request    |
| `VerificationJob`                 | Lifecycle and attempt for a request                              | Immutable record     |
| `CheckDefinition`                 | Versioned description of a check                                 | Versioned definition |
| `CheckExecution`                  | Lifecycle of one check attempt                                   | Immutable record     |
| `CheckResult`                     | Factual output from one execution                                | Immutable fact       |
| `Evidence`                        | Traceable factual or derived observation                         | Immutable fact       |
| `Finding` / `FindingLocation`     | Evidence-backed issue and source location                        | Immutable fact       |
| `Policy` / `PolicyRule`           | Versioned policy definition                                      | Versioned definition |
| `PolicyDecision`                  | Policy interpretation of evidence and findings                   | Immutable fact       |
| `VerificationCoverage`            | Capability-oriented coverage categories                          | Immutable value      |
| `VerificationResult`              | Final result for one request, job, and source state              | Immutable fact       |

Batch 6 adds deterministic producers around these existing models. Each `CheckResult` becomes `check.result` evidence whose hash excludes generation time. Failed, timed-out, errored, or cancelled results produce evidence-backed findings; skipped checks do not create findings but leave partial coverage. Cancellation is treated as an unverified high-severity condition and is blocked by the default policy.

## Identity and invariants

Branded IDs (`ProjectId`, `RepositorySnapshotId`, `ChangeSetId`, `VerificationId`, `VerificationRequestId`, `VerificationJobId`, `CheckId`, `CheckExecutionId`, `CheckResultId`, `EvidenceId`, `FindingId`, `PolicyId`, and `PolicyDecisionId`) prevent accidental identifier interchange at compile time. `brandId` applies the identifier character constraints without importing the public schema validator.

The `validate*` helpers enforce deterministic semantic rules:

- required identifiers, names, references, summaries, and provenance are non-empty;
- timestamps require ISO 8601 date-times with an explicit `Z` or numeric offset;
- hashes are 64-character hexadecimal values and result versions are semantic versions;
- source states are only `commit` or `snapshot`;
- repository paths are normalized, relative, and cannot escape the repository;
- counts, durations, lines, columns, priorities, and confidence values have valid ranges;
- check execution, check result, finding, verification, and policy statuses are validated separately;
- findings require evidence references;
- coverage capabilities cannot occur in conflicting categories;
- renamed/copied files require a safe previous path and locations have ordered ranges.

Validation is separate from public JSON Schema validation. `verify-contracts` owns wire compatibility; this package owns internal semantic invariants.

## Traceability

```text
Project + SourceState
        |
RepositorySnapshot + ChangeSet
        |
VerificationRequest -> VerificationJob
        |
CheckDefinition -> CheckExecution -> CheckResult
        |
Evidence -> Finding
        |
Policy -> PolicyDecision
        |
VerificationResult
```

`VerificationResult` identifies the request, job, project, snapshot, change set, check results, evidence, findings, and policy decision. A new source commit creates a new snapshot and result; historical facts expose no mutation or setter API.

`CheckResult.executionSource` is required and is one of `real`, `simulated`, or `fixture`. The source is copied to derived `Evidence`; findings retain it through their evidence references. Execution provenance is fail-closed: a transport must declare its source explicitly, and missing or unknown provenance is rejected rather than defaulted to `real`. Only `real` results can populate internal `VerificationCoverage.verified`. Synthetic successful results are recorded in `simulated` or `fixture` coverage and cannot satisfy required production policy.

The default policy blocks required failures and high/critical findings, requests changes for unsupported required capabilities or required non-real execution, and requests review for medium findings. With no blocking condition, incomplete or synthetic coverage produces `partial`; complete successful real required coverage produces `pass`. An explicit check-result infrastructure error maps to result status `error`, which has precedence over policy outcomes. Result and evidence content hashes exclude `createdAt` and include execution source where it affects meaning.

AI reasoning is an optional interpretation layer. Its confidence describes the provider's confidence in an interpretation, not truth probability. AI claims require references to existing evidence and use explicit AI provenance. Provider output is validated before use; repository text is untrusted data, and contradictions with deterministic facts are recorded without changing those facts.

Batch 8.1 closes the dogfood distinction gap internally. Detection and planning remain separate from execution; `simulated` and `fixture` are explicit non-production sources, while `real` is assigned at the sandbox execution boundary. The public `verify-contracts` schemas do not yet expose execution provenance, so this semantic distinction remains internal until a future versioned contract decision.

Dependency artifact identity also records the operating system and CPU architecture. Provisioning rejects artifacts incompatible with the configured runner, and Linux package launchers containing Windows drive or UNC paths are rejected rather than rewritten.

## Provenance and public mapping

`Provenance` records only a provider-neutral type, name, and optional version. `public-contracts.ts` maps internal source/reference and source-state values to the authoritative `verify-contracts` wire shapes. Schemas are not copied or re-exported as application types.

## Dependency environments

Dependency provisioning is represented internally by immutable
`DependencyIdentityInput`, `DependencyArtifact`, `DependencyProvisioningRequest`,
and `DependencyEnvironment` values. An artifact identity includes the exact
repository snapshot, manifest and lockfile hashes, ecosystem, package-manager and
toolchain versions, provisioning configuration, and generated-artifact inputs.
Its semantic hash excludes timestamps and machine-specific ambient state.

The current proof supports an explicit offline-capable pnpm artifact. The
`PnpmDependencyArtifactBuilder` runs only in a trusted operator-controlled
build root, installs from the submitted manifest/lockfile with frozen-lockfile
and `--ignore-scripts`, and stores a dereferenced `node_modules` artifact. The
runtime provisioner never installs packages or executes lifecycle scripts.
`network_required` and `unavailable` artifacts are rejected in offline mode,
and artifact paths are confined to the trusted store with symlinks and
traversal rejected. Dependency provenance is distinct from
`CheckResult.executionSource`; it cannot upgrade a fixture or simulated
execution to `real`.

Artifact identity is a canonical SHA-256 over snapshot, manifest and lockfile
hashes, ecosystem, package-manager/version, toolchain, provisioning
configuration, and generated-artifact inputs. A separate artifact content hash
detects tampering before provisioning. Build-time network, when explicitly
enabled by the trusted operator, is not runtime network: execution consumes
only the built artifact with network disabled.

Stellar Forge demonstrated that generated project state can be a check prerequisite:
its root `next-env.d.ts` imports `.next/types`, while its dependencies are separate
from source. Generated artifacts therefore belong in the dependency-environment
identity and must be provisioned explicitly in a future implementation. The
current builder records generated inputs but does not create framework output
such as `.next/types`.

Batch 12 adds an internal `ExecutionEnvironment` boundary. It links a source
snapshot to an optional provisioned `DependencyEnvironment`, generated
artifact descriptors, and a stable environment identity. `CheckExecution`
records the dependency artifact identity, so changing dependency state changes
execution identity without changing `ExecutionSource`. Provisioning has
explicit `not_started`, `provisioning`, `ready`, and `failed` lifecycle
semantics; failures stop before sandbox execution.

Generated artifacts are separate immutable descriptors with a requirement,
input hash, output content hash, source snapshot, output paths, and producer.
The `PrebuiltGeneratedArtifactPreparer` is the current safe strategy: trusted
operator configuration selects a prebuilt artifact, while repository metadata
cannot select host paths or commands. Materialization is bounded and rejects
unsafe paths and symlinks. Generated artifacts do not become dependency state
or check results.
