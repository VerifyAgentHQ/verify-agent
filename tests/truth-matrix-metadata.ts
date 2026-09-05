import { resolve } from "node:path";
import type {
  CheckId,
  VerificationStatus,
} from "../packages/domain/src/index.js";

export type FixtureScenario =
  | "typescript-healthy"
  | "typescript-failing-test"
  | "typescript-failing-typecheck"
  | "typescript-failing-build"
  | "rust-healthy"
  | "rust-failing-test"
  | "rust-failing-build";

export type ExpectedCheckOutcome = "passed" | "failed";

export interface FixtureMetadata {
  readonly scenario: FixtureScenario;
  readonly ecosystem: "typescript" | "rust";
  readonly fixturePath: string;
  readonly expectedStatus: VerificationStatus;
  /** Expected policy rule(s) triggered. First match is sufficient for assertion. */
  readonly expectedPolicyRules: readonly string[];
  /** Per-check expected outcomes. Checks not listed default to "passed". */
  readonly expectedCheckOutcomes: Readonly<
    Record<string, ExpectedCheckOutcome>
  >;
}

const TRUTH_ROOT = resolve("fixtures", "truth-matrix");

export const truthMatrixFixtures: readonly FixtureMetadata[] = [
  {
    scenario: "typescript-healthy",
    ecosystem: "typescript",
    fixturePath: resolve(TRUTH_ROOT, "typescript", "healthy"),
    expectedStatus: "needs_changes",
    expectedPolicyRules: ["non-real-required-execution"],
    expectedCheckOutcomes: {
      "typescript.typecheck": "passed",
      "typescript.test": "passed",
    },
  },
  {
    scenario: "typescript-failing-test",
    ecosystem: "typescript",
    fixturePath: resolve(TRUTH_ROOT, "typescript", "failing-test"),
    expectedStatus: "blocked",
    expectedPolicyRules: ["required-check-failure"],
    expectedCheckOutcomes: {
      "typescript.typecheck": "passed",
      "typescript.test": "failed",
    },
  },
  {
    scenario: "typescript-failing-typecheck",
    ecosystem: "typescript",
    fixturePath: resolve(TRUTH_ROOT, "typescript", "failing-typecheck"),
    expectedStatus: "blocked",
    expectedPolicyRules: ["required-check-failure"],
    expectedCheckOutcomes: {
      "typescript.typecheck": "failed",
    },
  },
  {
    scenario: "typescript-failing-build",
    ecosystem: "typescript",
    fixturePath: resolve(TRUTH_ROOT, "typescript", "failing-build"),
    expectedStatus: "blocked",
    expectedPolicyRules: ["required-check-failure"],
    expectedCheckOutcomes: {
      "typescript.typecheck": "passed",
      "typescript.build": "failed",
    },
  },
  {
    scenario: "rust-healthy",
    ecosystem: "rust",
    fixturePath: resolve(TRUTH_ROOT, "rust", "healthy"),
    expectedStatus: "needs_changes",
    expectedPolicyRules: ["non-real-required-execution"],
    expectedCheckOutcomes: {
      "rust.check": "passed",
      "rust.test": "passed",
      "rust.clippy": "passed",
    },
  },
  {
    scenario: "rust-failing-test",
    ecosystem: "rust",
    fixturePath: resolve(TRUTH_ROOT, "rust", "failing-test"),
    expectedStatus: "blocked",
    expectedPolicyRules: ["required-check-failure"],
    expectedCheckOutcomes: {
      "rust.check": "passed",
      "rust.test": "failed",
      "rust.clippy": "passed",
    },
  },
  {
    scenario: "rust-failing-build",
    ecosystem: "rust",
    fixturePath: resolve(TRUTH_ROOT, "rust", "failing-build"),
    expectedStatus: "blocked",
    expectedPolicyRules: ["required-check-failure"],
    expectedCheckOutcomes: {
      "rust.check": "failed",
    },
  },
];

export function getFixtureMetadata(scenario: FixtureScenario): FixtureMetadata {
  const fixture = truthMatrixFixtures.find((f) => f.scenario === scenario);
  if (!fixture) throw new Error(`Unknown fixture scenario: ${scenario}`);
  return fixture;
}
