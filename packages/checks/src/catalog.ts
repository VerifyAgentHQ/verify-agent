import { brandId } from "@verify-agent/domain";
import type { CheckDefinition } from "@verify-agent/domain";

const definition = (
  id: string,
  name: string,
  category: string,
  description: string,
  determinism: "deterministic" | "probabilistic" | "hybrid",
  languages: readonly string[],
  frameworks: readonly string[] = [],
  requirements: readonly string[] = [],
): CheckDefinition => ({
  id: brandId<"CheckId">(id),
  name,
  version: "1.0.0",
  category,
  description,
  determinism,
  supportedLanguages: languages,
  supportedFrameworks: frameworks,
  requirements,
});

export const initialCheckDefinitions: readonly CheckDefinition[] = [
  definition(
    "typescript.typecheck",
    "TypeScript typecheck",
    "correctness",
    "Checks the statically configured TypeScript project.",
    "deterministic",
    ["typescript", "javascript"],
    [],
    ["tsconfig.json"],
  ),
  definition(
    "typescript.lint",
    "TypeScript lint",
    "quality",
    "Applies the repository's statically detected lint tooling.",
    "deterministic",
    ["typescript", "javascript"],
    [],
    ["eslint-signal"],
  ),
  definition(
    "typescript.test",
    "TypeScript tests",
    "correctness",
    "Runs the repository's statically detected JavaScript test framework.",
    "deterministic",
    ["typescript", "javascript"],
    [],
    ["test-framework-signal"],
  ),
  definition(
    "typescript.build",
    "TypeScript build",
    "correctness",
    "Builds the statically configured JavaScript/TypeScript project.",
    "deterministic",
    ["typescript", "javascript"],
    [],
    ["build-signal"],
  ),
  definition(
    "rust.check",
    "Cargo check",
    "correctness",
    "Checks the Rust workspace or package.",
    "deterministic",
    ["rust"],
    [],
    ["Cargo.toml"],
  ),
  definition(
    "rust.test",
    "Cargo tests",
    "correctness",
    "Tests the Rust workspace or package.",
    "deterministic",
    ["rust"],
    [],
    ["Cargo.toml"],
  ),
  definition(
    "rust.clippy",
    "Clippy analysis",
    "quality",
    "Analyzes Rust code with Clippy when Rust is detected.",
    "deterministic",
    ["rust"],
    [],
    ["Cargo.toml"],
  ),
  definition(
    "soroban.contract-test",
    "Soroban contract tests",
    "correctness",
    "Tests statically detected Soroban contract capabilities.",
    "deterministic",
    ["rust"],
    ["soroban"],
    ["soroban-signal"],
  ),
  definition(
    "dependency.audit",
    "Dependency audit",
    "security",
    "Audits dependencies when a supported manifest or package manager is detected.",
    "deterministic",
    ["typescript", "javascript", "rust"],
  ),
  definition(
    "security.analysis",
    "Security analysis",
    "security",
    "Performs a configured security analysis.",
    "hybrid",
    ["typescript", "javascript", "rust"],
  ),
  definition(
    "license.analysis",
    "License analysis",
    "compliance",
    "Performs a configured license analysis.",
    "deterministic",
    ["typescript", "javascript", "rust"],
  ),
];

export interface CheckDefinitionRegistry {
  readonly definitions: readonly CheckDefinition[];
  find(checkId: string): CheckDefinition | undefined;
}

export function createCheckDefinitionRegistry(
  definitions: readonly CheckDefinition[] = initialCheckDefinitions,
): CheckDefinitionRegistry {
  const ordered = [...definitions].sort((a, b) =>
    String(a.id).localeCompare(String(b.id)),
  );
  return {
    definitions: ordered,
    find(checkId) {
      return ordered.find((definition) => definition.id === checkId);
    },
  };
}
