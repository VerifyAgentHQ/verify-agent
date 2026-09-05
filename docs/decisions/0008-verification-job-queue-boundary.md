# ADR-0008: Verification Job Queue Boundary

## Status

Accepted

## Decision

Introduce a provider-neutral asynchronous boundary between the authenticated
GitHub webhook and verification execution:

```text
authenticated webhook
→ immutable VerificationQueueJob
→ VerificationJobQueue.enqueue()
→ worker processor
→ VerificationApplicationService.verifySource
```

`VerificationQueueJob` (`jobId`, provider-neutral `source`, `trigger`,
`deliveryId`, `createdAt`) and the `VerificationJobQueue` port live in
`packages/domain`. The deterministic in-memory adapter
`createInMemoryVerificationJobQueue` lives in `packages/engine` for
development and tests. `apps/github-bot` translates trusted GitHub events
into jobs; `apps/worker` consumes jobs through the existing application
service. No external queue, database, persistence, retry, Docker, or
background loop is introduced.

## Consequences

- The webhook never verifies synchronously; `202` means enqueued, not
  completed. Queue failure yields the existing safe `500` without leaking
  internals.
- Batch 31 remains authoritative; unsupported actions enqueue nothing.
  Batch 32 order is unchanged; no job is created before HMAC, replay,
  size, and parsing checks pass.
- The worker knows only the provider-neutral job and `verifySource`;
  it never sees webhook headers, HMAC, event parsing, or GitHub
  credentials. `SourceResolver` remains intact.
- The in-memory queue preserves insertion order and frozen jobs but is
  explicitly non-durable: no exactly-once, crash recovery, persistent
  idempotency, or retry guarantees. The webhook replay guard protects
  only the process boundary; `deliveryId` is preserved for future
  durable idempotency.

## Trade-off

The queue port lives in the domain package alongside `SourceResolver`
rather than in a dedicated application package. This follows ADR-0006
and avoids a new package during Phase 0; a dedicated application
boundary can be introduced later without changing the GitHub, worker,
or service boundaries established here.
