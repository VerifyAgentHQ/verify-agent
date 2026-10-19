# VerifyAgent submission brief

## Positioning

VerifyAgent is a GitHub pull-request verification bot that evaluates whether a
pull request satisfies explicit requirements using authenticated source
identity, exact diffs, authoritative GitHub Actions evidence, deterministic
policy, and traceable machine-readable results.

It complements GitHub Actions. GitHub Actions remains authoritative for build,
test, lint, and typecheck execution. VerifyAgent does not replace CI, claim to
prove arbitrary security properties, or use AI as a verdict authority.

## Maintainer and contributor problem

CI can show that a repository builds and tests pass without showing that the
requested change was implemented. Maintainers need a concise, reviewable link
between the requirement, the changed code, the exact commit, and the CI facts.
Contributors need actionable explanations when a requirement is missing,
unsupported, or cannot be proven.

## Current proof

- StellarForge PR #11 proved the original MVP with pinned workflow actions and
  disabled checkout credentials.
- StellarForge PR #15 proved wrapped requirement extraction and changed-file
  evidence.
- The active path is webhook HMAC validation, replay protection, GitHub App
  access, exact PR head identity, PR/issue/diff/check-run inspection,
  deterministic evidence, a file-backed result, and one stable PR comment.
- Phase 7 now persists bounded requirement source URLs, immutable commit and
  line links, evidence timestamps/hashes, and selected exact-SHA check-run
  identities.

## Security boundaries and limitations

The active MVP does not execute repository code and does not depend on Docker
or the frozen `verify-sandbox`. Missing or ambiguous evidence is UNKNOWN and
blocks the merge-oriented verdict. Webhooks use HMAC-SHA256 and replay
protection; GitHub App installation tokens are not persisted or exposed.

The MVP supports a small deterministic rule set, a single-instance local
result store, and GitHub only. It does not provide universal natural-language
verification, malware detection, security certification, maintainer identity
verification, or production-grade arbitrary-code isolation.

## Drips Wave / GrantFox relevance

The strongest contributor work is deterministic GitHub integration: evidence
quality, exact check-run identity, webhook hardening, contract compatibility,
and reliability tests. The project has no payment execution or wallet
dependency. Contributors can work against focused fixtures and acceptance
criteria without access to production credentials.

## Readiness statement

VerifyAgent is an improve-then-submit project. The code path and local tests are
strong enough for contributor work, but a fresh public Phase 7 dogfood, hosted
operations, and maintainer-owned submission decisions remain outstanding.
