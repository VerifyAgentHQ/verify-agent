import type { RequirementResult } from "./pr-requirements.js";

export type MvpCiStatus = "PASS" | "FAIL" | "PENDING" | "ERROR";

export function calculateMvpVerdict(input: {
  readonly ci: MvpCiStatus;
  readonly requirements: readonly RequirementResult[];
  /** Legacy sandbox status is intentionally not consulted. */
  readonly legacyStatus?: string;
}): "pass" | "blocked" {
  return input.ci === "PASS" &&
    input.requirements.length > 0 &&
    input.requirements.every((item) => item.status === "passed")
    ? "pass"
    : "blocked";
}
