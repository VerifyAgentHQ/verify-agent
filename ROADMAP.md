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

## CURRENT PHASE

### Phase 3 — GitHub checkpoint / synchronization

Goal:

**Get the clean working implementation and this roadmap safely committed and pushed to GitHub.**

Tasks:

1. Inspect `git status`.
2. Inspect the full diff.
3. Identify secrets/generated/local-only files.
4. Confirm `.env`, private keys and local credentials are NOT committed.
5. Review the changed source/test/docs files.
6. Create an appropriate checkpoint commit.
7. Push using the repository's normal workflow.
8. Ensure `ROADMAP.md` is included.
9. Confirm GitHub and local HEAD are synchronized.
10. Run CI after the push.

Do NOT start Phase 4 until this checkpoint is complete.

## Future phases

### Phase 4 — Precise evidence locations

Extract actual line numbers where possible, retaining patch-hunk fallback.

### Phase 5 — Expand deterministic requirement rules

Add required files, forbidden files, required tests, and required text/configuration.

### Phase 6 — Better requirement extraction

Improve pattern-based extraction while preserving original wording and provenance.

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

Phase 3 is complete only when the coherent Phase 0–2 implementation and this roadmap are committed, pushed, visible on GitHub, locally synchronized, and CI has run successfully.

## Architectural decisions

- GitHub Actions is authoritative for CI execution.
- Deterministic evidence is authoritative for requirement verdicts.
- The sandbox and related repositories remain frozen source.
- One stable marker identifies the VerifyAgent PR comment.
- Durable result storage preserves the detailed MVP result and requirement evidence.

## Dogfood proof cases

- `StellarForgeDev/stellar-forge#11`: PASS with six pinned action references and two disabled checkout credential settings.

## CURRENT ACTION

Execute Phase 3. Do not implement new product functionality until the checkpoint is complete.
