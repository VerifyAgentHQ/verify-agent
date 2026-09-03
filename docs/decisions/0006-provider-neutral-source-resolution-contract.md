# ADR 0006: Provider-neutral source resolution contract in the domain package

## Decision

Move the provider-neutral source resolution contract — `SourceResolver`,
`ResolvedSource`, `SourceContents`, `SnapshotSourceReference`, and
`InvalidSourceReferenceError` — from `packages/adapters-source` into
`packages/domain`. `packages/adapters-source` re-exports the same contract so
its public surface is unchanged.

## Context

`VerificationApplicationService` must accept an injected provider-neutral
`SourceResolver` and resolve the source reference itself before invoking the
existing verification pipeline. The engine cannot import `adapters-source`
(engine sits above the external-adapter layer), so the contract must live in a
package both layers may depend on. The domain package already owns
`RepositorySnapshot`, `SourceReference`, and `SourceState`, making it the
natural home for the provider-neutral source-acquisition contract. The
GitHub-specific implementation (`GitHubSnapshotReference`,
`GitHubAppSourceProvider`, installation discovery, token client) remains below
the adapter boundary in `packages/adapters-source`.

## Consequences

- One provider-neutral resolver contract exists; callers never see
  GitHub-specific types at the application boundary.
- The engine's `VerificationApplicationService` can depend on `SourceResolver`
  without violating the dependency direction.
- `InvalidSourceReferenceError` remains the typed signal for client-caused
  source reference problems and is distinguishable from verification failures
  without string inspection.
- `packages/adapters-source` gains a re-export indirection for the contract but
  keeps its existing exports intact.

## Trade-off

`SourceResolver` is an application-layer port living in the domain package
rather than in a dedicated application package. This avoids creating a new
package and a second resolver interface during Phase 0; a dedicated application
boundary can be introduced later if the domain package grows ports beyond
source acquisition.
