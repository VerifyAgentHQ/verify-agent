import { createHash } from "node:crypto";
import { brandId } from "@verify-agent/domain";
import type {
  CheckDefinition,
  CheckId,
  CheckPlan,
  CheckPlanItem,
  ProjectProfile,
} from "@verify-agent/domain";
import { initialCheckDefinitions } from "./catalog.js";

export interface PlannerOverride {
  readonly required?: boolean;
  readonly optional?: boolean;
  readonly disabled?: boolean;
  readonly reason?: string;
}

export interface PlannerConfig {
  readonly requiredChecks?: readonly CheckId[];
  readonly optionalChecks?: readonly CheckId[];
  readonly disabledChecks?: readonly CheckId[];
  readonly overrides?: Readonly<Record<string, PlannerOverride>>;
}

export interface CheckPlanner {
  plan(profile: ProjectProfile, config?: PlannerConfig): CheckPlan;
}

export const PLANNER_VERSION = "1.0.0";
const PLANNING_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const priorities: Record<string, number> = {
  "typescript.typecheck": 10,
  "rust.check": 10,
  "typescript.lint": 20,
  "rust.clippy": 20,
  "typescript.test": 30,
  "rust.test": 30,
  "typescript.build": 40,
  "dependency.audit": 50,
  "security.analysis": 60,
  "license.analysis": 70,
  "soroban.contract-test": 80,
};

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hasConfig(config: PlannerConfig, id: string): boolean {
  return Boolean(
    config.requiredChecks?.some((checkId) => checkId === id) ||
    config.optionalChecks?.some((checkId) => checkId === id) ||
    config.disabledChecks?.some((checkId) => checkId === id) ||
    config.overrides?.[id],
  );
}

function reasonFor(
  definition: CheckDefinition,
  profile: ProjectProfile,
): string {
  const id = definition.id as string;
  if (id === "typescript.typecheck")
    return "TypeScript configuration detected; typecheck capability is applicable.";
  if (id === "typescript.lint")
    return "ESLint detected in static project metadata.";
  if (id === "typescript.test")
    return "A supported JavaScript test framework was detected.";
  if (id === "typescript.build")
    return "A static JavaScript/TypeScript build signal was detected.";
  if (id === "rust.check") return "Rust Cargo manifest detected.";
  if (id === "rust.test")
    return "Rust detected; Rust tests remain applicable unless later configuration changes this.";
  if (id === "rust.clippy")
    return "Rust detected; Clippy is an applicable default Rust analysis.";
  if (id === "soroban.contract-test")
    return "Soroban-related metadata detected in the Rust project.";
  if (id === "dependency.audit")
    return `A supported dependency manager or manifest was detected: ${profile.packageManagers.join(", ")}.`;
  return `${definition.name} was requested by planner configuration.`;
}

function dependenciesFor(id: string): readonly CheckId[] {
  if (id === "typescript.build")
    return [brandId<"CheckId">("typescript.typecheck")];
  if (id === "soroban.contract-test") return [brandId<"CheckId">("rust.test")];
  return [];
}

export function validatePlanDependencies(plan: Pick<CheckPlan, "items">): void {
  const positions = new Map(
    plan.items.map((item, index) => [String(item.checkId), index]),
  );
  for (const [index, item] of plan.items.entries()) {
    for (const dependency of item.dependencies) {
      const dependencyIndex = positions.get(String(dependency));
      if (dependencyIndex === undefined || dependencyIndex >= index) {
        throw new Error(
          `Plan dependency must appear earlier: ${String(dependency)} -> ${String(item.checkId)}`,
        );
      }
    }
  }
}

export function createCheckPlanner(
  definitions: readonly CheckDefinition[] = initialCheckDefinitions,
): CheckPlanner {
  return {
    plan(profile, config = {}): CheckPlan {
      const capabilities = new Set(profile.supportedCapabilities);
      const items: CheckPlanItem[] = [];
      for (const definition of definitions) {
        const id = definition.id as string;
        const override = config.overrides?.[id];
        const disabled =
          config.disabledChecks?.some((checkId) => checkId === id) ||
          override?.disabled;
        const configured = hasConfig(config, id);
        const applicable = capabilities.has(id);
        if (!applicable && !configured) continue;
        const status = disabled
          ? "not_applicable"
          : applicable
            ? "applicable"
            : "unsupported";
        const hasOverrideRequired = override?.required !== undefined;
        const hasOverrideOptional = override?.optional !== undefined;
        if (!disabled && hasOverrideRequired && hasOverrideOptional) {
          throw new Error(
            `Planner override cannot be both required and optional: ${id}`,
          );
        }
        const listedRequired =
          config.requiredChecks?.some((checkId) => checkId === id) ?? false;
        const listedOptional =
          config.optionalChecks?.some((checkId) => checkId === id) ?? false;
        if (!disabled && listedRequired && listedOptional) {
          throw new Error(
            `Planner configuration cannot list both required and optional: ${id}`,
          );
        }
        const defaultRequired =
          applicable &&
          [
            "typescript.typecheck",
            "typescript.lint",
            "typescript.test",
            "typescript.build",
            "rust.check",
            "rust.test",
            "rust.clippy",
            "soroban.contract-test",
          ].includes(id);
        let required = false;
        if (!disabled) {
          if (hasOverrideRequired) required = override.required === true;
          else if (hasOverrideOptional) required = override.optional !== true;
          else if (listedRequired) required = true;
          else if (listedOptional) required = false;
          else required = defaultRequired;
        }
        items.push({
          checkId: definition.id,
          checkVersion: definition.version,
          applicability: status,
          required,
          reason:
            override?.reason ??
            (disabled
              ? "Disabled by planner configuration."
              : applicable
                ? reasonFor(definition, profile)
                : "Requested by configuration but no applicable capability was detected."),
          priority: priorities[id] ?? 100,
          dependencies: disabled ? [] : dependenciesFor(id),
          scope: "repository",
        });
      }
      items.sort(
        (a, b) =>
          a.priority - b.priority ||
          String(a.checkId).localeCompare(String(b.checkId)),
      );
      validatePlanDependencies({ items });
      const content = {
        plannerVersion: PLANNER_VERSION,
        projectId: profile.projectId,
        snapshotId: profile.snapshotId,
        items,
      };
      return {
        planId: brandId<"CheckPlanId">(
          `plan-${stableHash(content).slice(0, 24)}`,
        ),
        plannerVersion: PLANNER_VERSION,
        projectId: profile.projectId,
        snapshotId: profile.snapshotId,
        items,
        createdAt: PLANNING_TIMESTAMP,
        contentHash: stableHash(content),
      };
    },
  };
}
