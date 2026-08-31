# AGENTS.md

## Required workflow

- Read the architecture docs in this repository before making code changes.
- Respect the dependency direction: domain -> engine -> checks/policy/ai -> applications -> external adapters.
- Do not bypass public contract boundaries from `verify-contracts`.
- Do not add provider SDK dependencies or service integrations without explicit approval.
- Do not move business logic into application entry points.
- Do not execute untrusted code in `verify-agent` itself.
- Do not implement sandbox logic or Docker orchestration in this repository.
- Do not add GOAT, AI provider dependencies, or GitHub integrations before the designated phase.
- Do not create new packages without architectural justification.
- Use ADRs for architecture changes, recording the decision and the tradeoff.
- Run the required checks before completing work.

## Architecture guardrails

- Treat `verify-contracts` as the public, approved contract boundary.
- Treat `verify-sandbox` as an external execution boundary, not local implementation.
- Keep the domain model independent from runtime and provider code.
- Preserve the distinction between immutable facts and versioned definitions.
- Prefer small, compile-safe abstractions over speculative implementation.

## Required checks

Before completion, run:

- `pnpm install --frozen-lockfile`
- `pnpm format:check`
- `pnpm typecheck`
- `pnpm test`

## Prohibited actions

- importing GitHub SDKs into domain or engine
- installing GOAT SDKs in Phase 0
- introducing AI provider integrations before approval
- adding database, Docker, or queueing libraries before the required phase
- creating a dashboard, marketplace, or payment layer during bootstrap
- committing or pushing changes
