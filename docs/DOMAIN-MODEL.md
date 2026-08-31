# Domain model

## Core principles

The domain package is the semantic heart of VerifyAgent. It defines stable internal entities and preserves the separation between immutable facts and versioned definitions.

## Immutable facts

The following are historical facts that should not be silently mutated once recorded:

- `RepositorySnapshot`
- `ChangeSet`
- `CheckResult`
- `Evidence`
- `PolicyDecision`
- `VerificationResult`

These represent the evidence trail and should be treated as append-only by the system. A new commit or new run creates a new verification result rather than editing a prior fact.

## Versioned definitions

These definitions are descriptive and evolve over time, with versioning and review:

- `CheckDefinition`
- `Policy`

Versioned definitions may change by design, but the resulting evidence remains linked to the definition version that produced it.

## Provenance

`Provenance` records the origin of a fact, the source of the data, and the relevant trace identifier. This is used to ensure traceability from the source repository state to the final result.

## Result traceability

The verification lifecycle should keep explicit relationships between:

1. `VerificationRequest`
2. `VerificationJob`
3. `CheckExecution`
4. `CheckResult`
5. `Evidence`
6. `Finding`
7. `PolicyDecision`
8. `VerificationResult`

This chain allows a reviewer to trace a high-level verification result back to the underlying facts and definition versions.

## Public vs internal model

Public contracts in `verify-contracts` are stable wire-facing definitions. Internal models in this repository may evolve to support product needs, but those mappings must be explicit and version-aware. Public contract semantics remain canonical, while internal models are semantic representations for the product engine.
