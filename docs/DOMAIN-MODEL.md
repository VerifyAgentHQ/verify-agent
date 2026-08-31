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

The default policy blocks required failures and high/critical findings, requests changes for unsupported required capabilities, and requests review for medium findings. With no blocking condition, incomplete coverage produces `partial`; complete successful required coverage produces `pass`. An explicit check-result infrastructure error maps to result status `error`, which has precedence over policy outcomes. Result and evidence content hashes exclude `createdAt`.

## Provenance and public mapping

`Provenance` records only a provider-neutral type, name, and optional version. `public-contracts.ts` maps internal source/reference and source-state values to the authoritative `verify-contracts` wire shapes. Schemas are not copied or re-exported as application types.
