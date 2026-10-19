# Contributor-ready issue backlog

These are local issue briefs. They are not GitHub issues and must not be
published without maintainer approval.

## 1. Add wrong-SHA check-run fixtures

- Problem: stale or wrong-commit checks must never support a PASS.
- Scope: `apps/api/src/github-pr-comment.ts`, check-run fixtures, tests.
- Acceptance: wrong `head_sha` is ignored and produces PENDING/ERROR evidence.
- Tests: matching SHA, wrong SHA, duplicate rerun, missing identity.
- Security: never broaden SHA acceptance. Difficulty: small. Dependencies: none.
- Out of scope: new CI providers.

## 2. Improve missing-evidence explanations

- Problem: UNKNOWN needs a precise contributor action.
- Scope: requirement evaluators and comment renderer.
- Acceptance: every UNKNOWN names the missing source, file, patch, or mapping.
- Tests: missing patch, truncated patch, unavailable issue, unsupported wording.
- Security: do not expose tokens or raw exceptions. Difficulty: small.
- Dependencies: evidence-quality baseline.
- Out of scope: AI interpretation.

## 3. Add diff-link regression coverage

- Problem: line links must remain correct across new, modified, deleted, and
  renamed files.
- Scope: patch parser, evidence locations, comment tests.
- Acceptance: correct LEFT/RIGHT side and immutable commit URL for each case.
- Tests: multiple hunks, deleted lines, rename metadata, patch fallback.
- Security: reject malformed URLs. Difficulty: medium.
- Dependencies: current RequirementEvidence model.
- Out of scope: hosting a diff service.

## 4. Add deterministic comment truncation

- Problem: a large PR can exceed GitHub comment limits.
- Scope: comment renderer.
- Acceptance: bounded output preserves verdict, failures, IDs, and a truncation
  notice without duplicate markers.
- Tests: many requirements, long observed text, control characters.
- Security: sanitize Markdown control input. Difficulty: medium.
- Dependencies: none. Out of scope: external report storage.

## 5. Add duplicate webhook delivery fixtures

- Problem: replay behavior needs durable-looking regression coverage.
- Scope: webhook replay guard and orchestration tests.
- Acceptance: duplicate delivery creates no second queue job; new SHA does.
- Tests: reserve/commit/rollback and expiry cases.
- Security: authenticate before reservation. Difficulty: small.
- Dependencies: current webhook boundary. Out of scope: Redis.

## 6. Add atomic result-store failure tests

- Problem: interrupted writes must not leave a partial result file.
- Scope: `apps/worker/src/result-registry.ts`.
- Acceptance: temp-file failure leaves the previous valid snapshot readable.
- Tests: write failure, restart, bounded eviction, duplicate processing.
- Security: mode 0600 and traversal-safe configured paths. Difficulty: medium.
- Dependencies: local file store. Out of scope: P2 database replacement.

## 7. Add contract compatibility fixtures

- Problem: internal evidence and public schema fields can drift.
- Scope: `verify-contracts` examples and compatibility tests.
- Acceptance: optional RequirementEvidence remains backward compatible and
  round-trips required fields.
- Tests: old result, new result, invalid hash/URL/SHA.
- Security: reject credential-bearing URLs. Difficulty: small.
- Dependencies: current schema addition. Out of scope: version 2 migration.

## 8. Add provider-specific GitHub error fixtures

- Problem: rate limits, permission failures, and unavailable checks need clear
  UNKNOWN/ERROR behavior.
- Scope: source adapter and publisher tests.
- Acceptance: safe user-facing explanation with no token or stack trace.
- Tests: 401, 403, 404, 429, timeout, malformed JSON.
- Security: redact bearer credentials. Difficulty: medium.
- Dependencies: GitHub adapter. Out of scope: automatic retry infrastructure.
