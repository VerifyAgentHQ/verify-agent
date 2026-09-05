# ADR-0007: GitHub Webhook Verification Orchestration

## Status

Accepted

## Decision

The GitHub webhook boundary may inject a `GitHubVerificationOrchestrator` after
webhook authentication. The orchestrator accepts only the authenticated
`GitHubPullRequestEvent`, delegates action handling to
`decideGitHubPullRequestEvent`, and (as of Batch 38) enqueues a supported
immutable snapshot as a provider-neutral `VerificationQueueJob` instead of
verifying synchronously. See ADR-0008 for the queue and worker boundary.

The HTTP transport remains responsible for authentication, raw-body handling,
and safe acknowledgement responses. The orchestrator does not authenticate,
resolve sources, access GitHub, execute checks, or aggregate results. The
current invocation is synchronous and has no retry, queue, or persistence
behavior.

Low-level HTTP handler `createGitHubWebhookHttpHandler` remains a reusable
transport primitive: its `orchestrator` stays optional for transport-only,
authentication, parser, and deterministic unit tests.

Production composition `createConfiguredGitHubWebhookHandler` is stricter:
the orchestrator is mandatory and its omission fails fast during composition
with `GitHubWebhookConfigurationError`. This removes the silent
authenticated-but-no-verification path. The composition root owns
`SourceResolver` → `VerificationApplicationService` →
`GitHubVerificationOrchestrator` → webhook handler construction and passes
the already-constructed orchestrator; the request handler never constructs
the application service.

## Consequences

- Unsupported pull-request actions are ignored without creating a verification
  result.
- Supported actions pass the Batch 31 head-SHA snapshot identity to the
  provider-neutral application-service boundary.
- The existing engine remains provider-neutral and authoritative for
  verification.
- A future batch may introduce asynchronous delivery without changing the
  trust or service boundaries established here.
