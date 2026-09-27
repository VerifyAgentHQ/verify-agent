import type {
  CheckId,
  CheckPlan,
  VerificationCheckSelection,
} from "@verify-agent/domain";

/**
 * Batch 53 — deterministic "all applicable" check selection.
 *
 * Selects every planner item that is BOTH applicable AND backed by a trusted
 * executable specification, preserving deterministic planner order (which
 * already encodes dependency ordering — e.g. `typescript.build` follows
 * `typescript.typecheck`, `soroban.contract-test` follows `rust.test`).
 *
 * Excluded, never silently executed:
 * - `not_applicable` / `unsupported` planner items (disabled or undetected);
 * - applicable items with no trusted executable specification (e.g.
 *   `dependency.audit`, `security.analysis`, `license.analysis`), which
 *   retain the repository's existing "no trusted execution specification"
 *   execution semantics instead of becoming passing results.
 *
 * The predicate keeps this helper decoupled from any concrete spec
 * registry; callers pass `(checkId) => registry.find(checkId) !== undefined`.
 */
export function selectApplicableExecutableChecks(
  plan: Pick<CheckPlan, "items">,
  hasExecutableSpec: (checkId: CheckId) => boolean,
): readonly CheckId[] {
  return Object.freeze(
    plan.items
      .filter(
        (item) =>
          item.applicability === "applicable" &&
          hasExecutableSpec(item.checkId),
      )
      .map((item) => item.checkId),
  );
}

/**
 * Resolves the effective check selection for a verification run.
 *
 * Precedence (backwards compatible):
 * 1. Explicit `selectedCheckIds` / `selectedCheckId` win exactly as before.
 * 2. Otherwise `selection: "all-applicable"` selects every applicable
 *    executable check in planner order.
 * 3. Otherwise (absent selection, `"default"`, or legacy callers) the
 *    generic pipeline fallback applies and the caller-supplied default is
 *    used unchanged.
 *
 * Returns `undefined` when the caller-supplied default should apply, so the
 * historical fallback stays in exactly one place (the pipeline).
 */
export function resolveCheckSelection(input: {
  readonly plan: Pick<CheckPlan, "items">;
  readonly selection?: VerificationCheckSelection;
  readonly selectedCheckIds?: readonly CheckId[];
  readonly selectedCheckId?: CheckId;
  readonly hasExecutableSpec: (checkId: CheckId) => boolean;
}): readonly CheckId[] | undefined {
  if (input.selectedCheckIds !== undefined) return input.selectedCheckIds;
  if (input.selectedCheckId !== undefined) return [input.selectedCheckId];
  if (input.selection === "all-applicable") {
    return selectApplicableExecutableChecks(
      input.plan,
      input.hasExecutableSpec,
    );
  }
  return undefined;
}
