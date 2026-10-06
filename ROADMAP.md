# VerifyAgent Roadmap

## Product goal

VerifyAgent is a GitHub PR verification bot.

GitHub Actions/CI remains authoritative for build, test, lint, typecheck and other CI checks.

VerifyAgent's unique role is:

**Did this PR actually implement what the issue/PR requested, and what concrete evidence proves that?**

Active path:

GitHub webhook
→ queue/worker
→ GitHub App/source access
→ PR + issue + diff + CI evidence
→ deterministic requirement evaluation
→ PASS / FAIL / UNKNOWN
→ durable result
→ one VerifyAgent PR comment

The custom sandbox is frozen and is NOT part of the active MVP.

## Completed

### Phase 0 — Repository cleanup

DONE.

- Removed historical batch suites.
- Removed obsolete sandbox/engine/pipeline/CLI tests.
- Removed obsolete host CLI.
- Removed stale artifacts/debug/credential-bearing local launch material.
- Removed legacy Check Run publisher from active runtime.
- Preserved sandbox/engine/contract repositories as frozen source.
- Updated architecture documentation.

### Phase 1 — Working MVP runtime

DONE.

- GitHub App authentication.
- Webhook/queue/worker.
- PR/issue/diff/check-run retrieval.
- Deterministic MVP verdict.
- Durable result registry.
- Stable VerifyAgent PR comment create/update.
- MVP decoupled from sandbox execution.

Proof:

`StellarForgeDev/stellar-forge#11`

### Phase 2 — Requirement Evidence v1

DONE.

- RequirementEvidence model.
- PR/issue provenance.
- Compound PR #11 requirement split into two requirements.
- `github-action-pinned`.
- `checkout-persist-credentials-disabled`.
- PASS / FAIL / UNKNOWN.
- UNKNOWN blocks the merge-oriented verdict.
- Evidence persistence.
- Evidence-based comment rendering.
- PR #11 dogfood with real evidence.

PR #11 proof:

`.github/workflows/ci.yml`

- 6 changed action references verified against full commit SHAs.
- 2 checkout steps verified with `persist-credentials: false`.

### Phase 3 — GitHub checkpoint / synchronization

DONE.

- Roadmap and Phase 0-2 implementation committed and pushed.
- Local and GitHub `main` synchronized.
- Secrets, private keys, generated artifacts, and local result stores excluded.
- GitHub Actions formatting, typecheck, build, and test checks passed.

Checkpoint commits:

- `6d230c2` - MVP and roadmap checkpoint.
- `11ef2ca`, `0676eb0`, `e23576b` - formatting and CI regression fixes.

### Phase 4 — Precise evidence locations

DONE.

- Unified diff hunks map to exact new-file line numbers where available.
- Evidence records preserve `LEFT`/`RIGHT` diff side information.
- Patch hunks remain available as a bounded fallback.
- PR comments render file, line, side, or patch-hunk evidence.
- Focused evidence/comment tests cover precise locations and fallback output.
- GitHub Actions passed the complete Phase 4 test suite.

Implementation commit: `3c42309`.

## CURRENT PHASE

### Phase 5 — Expand deterministic requirement rules

DONE.

- Implemented `required-file-changed`.
- PASS when the explicitly requested file is in the changed-file set.
- FAIL when the requested file is absent.
- UNKNOWN when the required path cannot be extracted.
- Preserved provenance, evidence hash, changed-file evidence, durable persistence, and comment rendering.
- Added focused PASS, FAIL, persistence, verdict, and comment tests.
- Positive dogfood: `StellarForgeDev/stellar-forge#13`.
- Negative fixture: `StellarForgeDev/stellar-forge#14`.

Implementation commits: `348e3ea`, `42cc30b`, `9070dfe`.

## Future phases

### Phase 6 — Better requirement extraction

DONE.

- Extracted wrapped imperative requirements such as `Requirement: The PR must add ...`.
- Split compound requirement clauses without losing source provenance.
- Preserved original requirement wording alongside canonical evaluator text.
- Retained deterministic changed-file evidence and Phase 5 verdict behavior.
- Added focused extraction, provenance, persistence, verdict, and comment tests.
- Positive dogfood: `StellarForgeDev/stellar-forge#15` returned PASS from the real PR body and changed-file set.

Implementation commit: `d1efacd`.

## CURRENT PHASE

### Phase 7 — Evidence quality

Improve explanations, precise locations, missing-evidence messages, and GitHub links.

### Phase 8 — Policy

Introduce repository-specific policy after evidence is reliable.

### Phase 9 — AI assistance

AI may summarize and explain deterministic evidence but may not determine the verdict.

### Phase 10 — Broader dogfooding

Test satisfied, violated, missing, ambiguous, unrelated, multi-file, PASS + UNKNOWN, and PASS + FAIL cases.

## Explicitly NOT doing now

Do NOT revive sandbox execution, make Docker mandatory, restore batch suites or the old Check Run publisher, replace GitHub Actions, build universal natural-language verification, build generic AI code review, build broad multi-language execution infrastructure, or perform architecture rewrites without a demonstrated product need.

## Working rules

1. One phase at a time.
2. Read `ROADMAP.md` before implementation.
3. Do not begin a future phase early.
4. Every meaningful feature needs a real PR proof.
5. Every meaningful milestone gets committed and pushed.
6. Never revive frozen sandbox work because an old test fails.
7. If work stalls, stop and reassess against the roadmap.
8. Update this roadmap at the end of every completed phase.

## Success criteria

Phase 6 is complete only when deterministic extraction preserves normalized evaluation text, original source wording, provenance, unsupported UNKNOWN behavior, focused tests, and a real dogfood proof with CI green.

## Architectural decisions

- GitHub Actions is authoritative for CI execution.
- Deterministic evidence is authoritative for requirement verdicts.
- The sandbox and related repositories remain frozen source.
- One stable marker identifies the VerifyAgent PR comment.
- Durable result storage preserves the detailed MVP result and requirement evidence.

## Dogfood proof cases

- `StellarForgeDev/stellar-forge#11`: PASS with six pinned action references and two disabled checkout credential settings.
- `StellarForgeDev/stellar-forge#15`: PASS for wrapped `Requirement: The PR must add docs/verifyagent-phase6.md` wording, with the required file proven from the changed-file set.

## CURRENT ACTION

Execute Phase 7 only after reviewing this roadmap. Do not revive sandbox execution or expand the contract repository.
