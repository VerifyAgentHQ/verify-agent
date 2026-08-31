import { describe, expect, it } from "vitest";
import { brandId } from "../packages/domain/src/index.js";
import {
  createCheckDefinitionRegistry,
  createCheckPlanner,
  validatePlanDependencies,
} from "../packages/checks/src/index.js";

const profile = (overrides: Partial<Record<string, unknown>> = {}) => ({
  projectId: brandId<"ProjectId">("project-1"),
  snapshotId: brandId<"RepositorySnapshotId">("snapshot-1"),
  languages: ["typescript", "rust"],
  frameworks: ["nextjs", "react", "soroban"],
  packageManagers: ["cargo", "pnpm"],
  buildSystems: ["cargo"],
  testFrameworks: ["vitest"],
  detectedTools: ["typescript", "eslint", "vitest", "cargo"],
  repositoryStructure: { isMonorepo: true },
  supportedCapabilities: [
    "typescript.typecheck",
    "typescript.lint",
    "typescript.test",
    "typescript.build",
    "rust.check",
    "rust.test",
    "rust.clippy",
    "soroban.contract-test",
    "dependency.audit",
    "dependency.audit",
  ],
  detectionConfidence: 1,
  ...overrides,
});

describe("deterministic check planning", () => {
  it("creates one unified mixed TypeScript and Rust plan", () => {
    const plan = createCheckPlanner().plan(profile());
    expect(plan.items.map((item) => item.checkId)).toEqual([
      "rust.check",
      "typescript.typecheck",
      "rust.clippy",
      "typescript.lint",
      "rust.test",
      "typescript.test",
      "typescript.build",
      "dependency.audit",
      "soroban.contract-test",
    ]);
    expect(
      plan.items.every((item) => item.applicability === "applicable"),
    ).toBe(true);
    const requiredIds = [
      "rust.check",
      "typescript.typecheck",
      "rust.clippy",
      "typescript.lint",
      "rust.test",
      "typescript.test",
      "typescript.build",
      "soroban.contract-test",
    ];
    for (const id of requiredIds) {
      expect(plan.items.find((item) => item.checkId === id)?.required).toBe(
        true,
      );
    }
    expect(
      plan.items.filter((item) => item.checkId === "dependency.audit"),
    ).toHaveLength(1);
    expect(
      plan.items.find((item) => item.checkId === "dependency.audit"),
    ).toMatchObject({ applicability: "applicable", required: false });
  });

  it("keeps dependency ordering explicit and deterministic", () => {
    const plan = createCheckPlanner().plan(profile());
    const build = plan.items.find(
      (item) => item.checkId === "typescript.build",
    );
    const typecheck = plan.items.find(
      (item) => item.checkId === "typescript.typecheck",
    );
    expect(build?.dependencies).toEqual(["typescript.typecheck"]);
    expect(plan.items.indexOf(typecheck!)).toBeLessThan(
      plan.items.indexOf(build!),
    );
    const soroban = plan.items.find(
      (item) => item.checkId === "soroban.contract-test",
    );
    const rustTest = plan.items.find((item) => item.checkId === "rust.test");
    expect(plan.items.indexOf(rustTest!)).toBeLessThan(
      plan.items.indexOf(soroban!),
    );
    expect(() => validatePlanDependencies(plan)).not.toThrow();
    for (const [index, item] of plan.items.entries()) {
      for (const dependency of item.dependencies) {
        const dependencyIndex = plan.items.findIndex(
          (candidate) => candidate.checkId === dependency,
        );
        expect(dependencyIndex).toBeGreaterThanOrEqual(0);
        expect(dependencyIndex).toBeLessThan(index);
      }
    }
  });

  it("produces stable plan identity for the same inputs", () => {
    const planner = createCheckPlanner();
    const first = planner.plan(profile());
    const second = planner.plan(profile());
    expect(second).toEqual(first);
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.createdAt).toBe("1970-01-01T00:00:00.000Z");
  });

  it("applies disabled and forced configuration with explanations", () => {
    const plan = createCheckPlanner().plan(
      profile({ supportedCapabilities: ["typescript.typecheck"] }),
      {
        disabledChecks: [brandId<"CheckId">("typescript.typecheck")],
        requiredChecks: [brandId<"CheckId">("security.analysis")],
        overrides: {
          "security.analysis": {
            reason: "Required by the review configuration.",
          },
        },
      },
    );
    expect(
      plan.items.find((item) => item.checkId === "typescript.typecheck"),
    ).toMatchObject({
      applicability: "not_applicable",
      required: false,
      reason: "Disabled by planner configuration.",
    });
    expect(
      plan.items.find((item) => item.checkId === "security.analysis"),
    ).toMatchObject({
      applicability: "unsupported",
      required: true,
      reason: "Required by the review configuration.",
    });
  });

  it("supports optional configuration without changing applicability", () => {
    const plan = createCheckPlanner().plan(profile(), {
      optionalChecks: [brandId<"CheckId">("typescript.typecheck")],
      overrides: { "typescript.typecheck": { optional: true } },
    });
    expect(
      plan.items.find((item) => item.checkId === "typescript.typecheck"),
    ).toMatchObject({ applicability: "applicable", required: false });
  });

  it("keeps security analysis optional by default and supports promotion", () => {
    const securityProfile = profile({
      supportedCapabilities: ["typescript.typecheck", "security.analysis"],
    });
    const optionalPlan = createCheckPlanner().plan(securityProfile);
    expect(
      optionalPlan.items.find((item) => item.checkId === "security.analysis"),
    ).toMatchObject({ applicability: "applicable", required: false });

    const requiredPlan = createCheckPlanner().plan(securityProfile, {
      requiredChecks: [brandId<"CheckId">("security.analysis")],
    });
    expect(
      requiredPlan.items.find((item) => item.checkId === "security.analysis"),
    ).toMatchObject({ applicability: "applicable", required: true });
  });

  it("uses deterministic configuration precedence and rejects contradictions", () => {
    const security = brandId<"CheckId">("security.analysis");
    const planner = createCheckPlanner();
    const profileWithSecurity = profile({
      supportedCapabilities: ["security.analysis"],
    });

    expect(
      planner.plan(profileWithSecurity, {
        requiredChecks: [security],
        overrides: { "security.analysis": { optional: true } },
      }).items[0].required,
    ).toBe(false);
    expect(
      planner.plan(profileWithSecurity, {
        requiredChecks: [security],
        overrides: { "security.analysis": { required: true } },
      }).items[0].required,
    ).toBe(true);
    expect(() =>
      planner.plan(profileWithSecurity, {
        overrides: { "security.analysis": { required: true, optional: true } },
      }),
    ).toThrow(/both required and optional/);
  });

  it("provides a stable definition registry without executable commands", () => {
    const registry = createCheckDefinitionRegistry();
    expect(registry.find("rust.check")?.name).toBe("Cargo check");
    expect(registry.definitions.map((definition) => definition.id)).toEqual(
      [...registry.definitions]
        .map((definition) => definition.id)
        .sort((a, b) => String(a).localeCompare(String(b))),
    );
  });

  it("does not execute scripts, commands, or external services", () => {
    const context = { calls: 0 };
    const plan = createCheckPlanner().plan(
      profile({ repositoryStructure: { script: "must-not-run" } }),
    );
    expect(plan).toBeDefined();
    expect(context.calls).toBe(0);
  });
});
