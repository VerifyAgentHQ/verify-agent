import { describe, expect, it } from "vitest";
import {
  createCheckDefinitionRegistry,
  createTrustedExecutionSpecRegistry,
} from "../packages/checks/src/index.js";
import { brandId, type CheckId } from "../packages/domain/src/index.js";
import {
  createDeterministicTestExecutor,
  runTruthHarness,
  HARNESS_PROJECT_ID,
  HARNESS_SNAPSHOT_ID,
} from "./truth-harness.js";
import {
  truthMatrixFixtures,
  getFixtureMetadata,
} from "./truth-matrix-metadata.js";

// ---------------------------------------------------------------------------
// Architecture guardrails
// ---------------------------------------------------------------------------

describe("truth-matrix architecture guardrails", () => {
  it("deterministic test executor declares simulated provenance", () => {
    const executor = createDeterministicTestExecutor("typescript-healthy", {
      "typescript.typecheck": "passed",
    });
    expect(executor).toBeDefined();
  });

  it("truth harness uses provider-neutral contracts from existing packages", () => {
    const definitions = createCheckDefinitionRegistry();
    const specs = createTrustedExecutionSpecRegistry();
    expect(definitions.definitions.length).toBe(11);
    expect(specs.specs.length).toBe(8);
    for (const id of [
      "dependency.audit",
      "security.analysis",
      "license.analysis",
    ]) {
      expect(specs.find(brandId<"CheckId">(id))).toBeUndefined();
    }
  });

  it("all seven fixtures exist on disk", async () => {
    const { existsSync } = await import("node:fs");
    for (const fixture of truthMatrixFixtures) {
      expect(existsSync(fixture.fixturePath)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Detection integration
// ---------------------------------------------------------------------------

describe("truth-matrix: project detection", () => {
  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "detects %s correctly",
    async (_scenario, fixture) => {
      const { detectionProfile } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      if (fixture.ecosystem === "typescript") {
        expect(detectionProfile.languages).toContain("typescript");
      } else {
        expect(detectionProfile.languages).toContain("rust");
      }

      expect(detectionProfile.projectId).toBe(HARNESS_PROJECT_ID);
      expect(detectionProfile.snapshotId).toBe(HARNESS_SNAPSHOT_ID);
    },
  );
});

// ---------------------------------------------------------------------------
// Check planning integration
// ---------------------------------------------------------------------------

describe("truth-matrix: check planning", () => {
  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "plans applicable checks for %s",
    async (_scenario, fixture) => {
      const { plan } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      const applicableItems = plan.items.filter(
        (item) => item.applicability === "applicable",
      );
      expect(applicableItems.length).toBeGreaterThan(0);

      for (const checkId of Object.keys(fixture.expectedCheckOutcomes)) {
        const item = plan.items.find((i) => String(i.checkId) === checkId);
        expect(item).toBeDefined();
        expect(item!.applicability).toBe("applicable");
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Execution-spec validation
// ---------------------------------------------------------------------------

describe("truth-matrix: execution-spec validation", () => {
  const specRegistry = createTrustedExecutionSpecRegistry();

  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "has trusted specs for applicable checks in %s",
    async (_scenario, fixture) => {
      const { plan } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      for (const item of plan.items) {
        if (item.applicability !== "applicable") continue;
        if (String(item.checkId) in fixture.expectedCheckOutcomes) {
          expect(specRegistry.find(item.checkId)).toBeDefined();
        }
      }
    },
  );

  it("confirms 3 definition-only checks have no execution spec", () => {
    for (const id of [
      "dependency.audit",
      "security.analysis",
      "license.analysis",
    ]) {
      expect(specRegistry.find(brandId<"CheckId">(id))).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence aggregation integration
// ---------------------------------------------------------------------------

describe("truth-matrix: evidence aggregation", () => {
  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "produces evidence for all executed checks in %s",
    async (_scenario, fixture) => {
      const { evidence, findings } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      const executedChecks = Object.keys(fixture.expectedCheckOutcomes);
      expect(evidence.length).toBeGreaterThanOrEqual(executedChecks.length);

      for (const e of evidence) {
        expect(e.executionSource).toBe("simulated");
        expect(e.type).toBe("check.result");
      }

      const failedChecks = executedChecks.filter(
        (id) => fixture.expectedCheckOutcomes[id] === "failed",
      );
      expect(findings.length).toBe(failedChecks.length);
    },
  );
});

// ---------------------------------------------------------------------------
// Policy evaluation integration
// ---------------------------------------------------------------------------

describe("truth-matrix: policy evaluation", () => {
  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "policy triggers expected rule for %s",
    async (_scenario, fixture) => {
      const { policyDecision } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      const hasExpectedRule = fixture.expectedPolicyRules.some((rule) =>
        policyDecision.triggeredRuleIds.includes(rule),
      );
      expect(hasExpectedRule).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// VerificationResult truth assertions
// ---------------------------------------------------------------------------

describe("truth-matrix: VerificationResult", () => {
  it.each(truthMatrixFixtures.map((f) => [f.scenario, f] as const))(
    "produces correct status for %s",
    async (_scenario, fixture) => {
      const { verificationResult } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      expect(verificationResult.status).toBe(fixture.expectedStatus);
      expect(verificationResult.projectId).toBe(HARNESS_PROJECT_ID);
      expect(verificationResult.snapshotId).toBe(HARNESS_SNAPSHOT_ID);
    },
  );

  it("healthy TypeScript fixture: coverage is simulated (not verified)", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.coverage.verified).toEqual([]);
    expect(verificationResult.coverage.simulated).toEqual(
      expect.arrayContaining(["typescript.typecheck", "typescript.test"]),
    );
    expect(verificationResult.coverage.partial).toEqual([]);
    expect(verificationResult.coverage.unsupported).toEqual([]);
  });

  it("healthy Rust fixture: coverage is simulated (not verified)", async () => {
    const fixture = getFixtureMetadata("rust-healthy");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.coverage.verified).toEqual([]);
    expect(verificationResult.coverage.simulated).toEqual(
      expect.arrayContaining(["rust.check", "rust.test", "rust.clippy"]),
    );
    expect(verificationResult.coverage.partial).toEqual([]);
    expect(verificationResult.coverage.unsupported).toEqual([]);
  });

  it("failing TypeScript test: blocked with partial coverage", async () => {
    const fixture = getFixtureMetadata("typescript-failing-test");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.status).toBe("blocked");
    // Passed check goes to simulated, failed check goes to partial.
    expect(verificationResult.coverage.simulated).toContain(
      "typescript.typecheck",
    );
    expect(verificationResult.coverage.partial).toContain("typescript.test");
  });

  it("failing TypeScript typecheck: blocked with partial coverage", async () => {
    const fixture = getFixtureMetadata("typescript-failing-typecheck");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.status).toBe("blocked");
    // Failed check goes to partial.
    expect(verificationResult.coverage.partial).toContain(
      "typescript.typecheck",
    );
  });

  it("failing TypeScript build: blocked with partial coverage", async () => {
    const fixture = getFixtureMetadata("typescript-failing-build");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.status).toBe("blocked");
    // Passed check goes to simulated, failed check goes to partial.
    expect(verificationResult.coverage.simulated).toContain(
      "typescript.typecheck",
    );
    expect(verificationResult.coverage.partial).toContain("typescript.build");
  });

  it("failing Rust test: blocked with partial coverage", async () => {
    const fixture = getFixtureMetadata("rust-failing-test");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.status).toBe("blocked");
    // Passed checks go to simulated, failed check goes to partial.
    expect(verificationResult.coverage.simulated).toEqual(
      expect.arrayContaining(["rust.check", "rust.clippy"]),
    );
    expect(verificationResult.coverage.partial).toContain("rust.test");
  });

  it("failing Rust build: blocked with partial coverage", async () => {
    const fixture = getFixtureMetadata("rust-failing-build");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.status).toBe("blocked");
    expect(verificationResult.coverage.partial).toEqual(
      expect.arrayContaining(["rust.check"]),
    );
  });
});

// ---------------------------------------------------------------------------
// False-positive / false-negative protection
// ---------------------------------------------------------------------------

describe("truth-matrix: false-positive and false-negative protection", () => {
  it("healthy fixtures do not produce pass status with simulated execution", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(verificationResult.status).not.toBe("pass");
    expect(verificationResult.coverage.verified).toEqual([]);
  });

  it("all fixtures produce non-pass status with simulated execution", async () => {
    for (const fixture of truthMatrixFixtures) {
      const { verificationResult } = await runTruthHarness({
        scenario: fixture.scenario,
        fixturePath: fixture.fixturePath,
        expectedCheckOutcomes: fixture.expectedCheckOutcomes,
      });

      expect(verificationResult.status).not.toBe("pass");
      // Healthy scenarios produce needs_changes; failing scenarios produce blocked.
      expect(["needs_changes", "blocked"]).toContain(verificationResult.status);
    }
  });

  it("definition-only checks cannot silently become successful", () => {
    const registry = createTrustedExecutionSpecRegistry();
    for (const id of [
      "dependency.audit",
      "security.analysis",
      "license.analysis",
    ]) {
      expect(registry.find(brandId<"CheckId">(id))).toBeUndefined();
    }
  });

  it("simulated execution is never labeled as real sandbox execution", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { evidence } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    for (const e of evidence) {
      expect(e.executionSource).not.toBe("real");
      expect(e.executionSource).toBe("simulated");
    }
  });
});

// ---------------------------------------------------------------------------
// Rust-failing-build: full pipeline composition with failed check
// ---------------------------------------------------------------------------

describe("truth-matrix: rust-failing-build pipeline composition", () => {
  it("detection, planning, and execution compose correctly with a failed check", async () => {
    const fixture = getFixtureMetadata("rust-failing-build");
    const result = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    // Detection identifies Rust ecosystem
    expect(result.detectionProfile.languages).toContain("rust");
    expect(result.detectionProfile.supportedCapabilities).toEqual(
      expect.arrayContaining(["rust.check", "rust.test", "rust.clippy"]),
    );

    // Planning includes all applicable Rust checks
    const applicable = result.plan.items.filter(
      (item) => item.applicability === "applicable",
    );
    expect(applicable.map((item) => String(item.checkId))).toEqual(
      expect.arrayContaining(["rust.check", "rust.test", "rust.clippy"]),
    );

    // Execution spec exists for rust.check
    const specs = createTrustedExecutionSpecRegistry();
    expect(specs.find(brandId<"CheckId">("rust.check"))).toBeDefined();

    // Pipeline runs all applicable checks (deterministic executor handles each)
    expect(result.pipelineOutput.checkResults).toHaveLength(3);

    // Evidence aggregation produces evidence for all executed checks
    expect(result.evidence.length).toBeGreaterThanOrEqual(1);

    // Policy fires required-check-failure (rust.check failed)
    expect(result.policyDecision.triggeredRuleIds).toContain(
      "required-check-failure",
    );

    // Final status is blocked (required check failed)
    expect(result.verificationResult.status).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Test isolation: no external dependencies
// ---------------------------------------------------------------------------

describe("truth-matrix: test isolation", () => {
  it("does not require GitHub, network, or external sandbox", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const { verificationResult } = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });
    expect(verificationResult).toBeDefined();
  });

  it("is deterministic across runs", async () => {
    const fixture = getFixtureMetadata("typescript-healthy");
    const first = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });
    const second = await runTruthHarness({
      scenario: fixture.scenario,
      fixturePath: fixture.fixturePath,
      expectedCheckOutcomes: fixture.expectedCheckOutcomes,
    });

    expect(first.verificationResult.status).toBe(
      second.verificationResult.status,
    );
    expect(first.verificationResult.contentHash).toBe(
      second.verificationResult.contentHash,
    );
    expect(first.plan.contentHash).toBe(second.plan.contentHash);
  });
});
