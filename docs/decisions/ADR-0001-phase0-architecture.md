# ADR 0001: Phase 0 bootstrap architecture

Date: 2026-08-31

## Status

Accepted

## Context

The VerifyAgent product repository must establish a clear architecture boundary without implementing the entire verification engine, GitHub integration, AI providers, or sandbox execution. It must remain compatible with the public contracts in `verify-contracts` and the isolated execution boundary in `verify-sandbox`.

## Decision

Create a lightweight TypeScript monorepo with a strict dependency direction and minimal compile-safe skeletons only. The domain package owns the semantic model; the engine orchestrates but does not own external technology. Public contracts remain authoritative and are read as external boundaries, while internal models evolve separately.

## Consequences

- The core remains free from provider-specific SDKs and execution runtime dependencies during Phase 0.
- The startup architecture is strong enough to support later modules without reworking the central boundaries.
- The bootstrap intentionally avoids speculative implementation and keeps the product repository focused on architecture and compile safety.
