import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  domainImmutability,
  publicContract,
  toPublicSourceReference,
} from "../packages/domain/src/index.js";
import { createEngine } from "../packages/engine/src/runtime.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contractsRoot = join(repoRoot, "..", "verify-contracts");

describe("Phase 0 architecture", () => {
  it("exposes immutable fact and versioned definition boundaries", () => {
    expect(domainImmutability.immutableFacts).toEqual(
      expect.arrayContaining([
        "RepositorySnapshot",
        "ChangeSet",
        "CheckResult",
        "Evidence",
        "PolicyDecision",
        "VerificationResult",
      ]),
    );
    expect(domainImmutability.versionedDefinitions).toEqual([
      "CheckDefinition",
      "Policy",
    ]);
  });

  it("maps internal source references to the public wire shape explicitly", () => {
    expect(toPublicSourceReference({ kind: "git", ref: "abc123" })).toEqual({
      provider: "git",
      reference: "abc123",
    });
  });

  it("keeps the engine usable through orchestration abstractions", () => {
    const engine = createEngine();
    expect(typeof engine.run).toBe("function");
  });

  it("tracks the sibling repository's authoritative contract metadata", () => {
    const requestSchema = JSON.parse(
      readFileSync(
        join(
          contractsRoot,
          "schemas",
          "verification",
          "verification-request.schema.json",
        ),
        "utf8",
      ),
    ) as { $id: string; properties: { schemaVersion: { const: string } } };
    const sandboxSchema = JSON.parse(
      readFileSync(
        join(
          contractsRoot,
          "schemas",
          "sandbox",
          "sandbox-job-request.schema.json",
        ),
        "utf8",
      ),
    ) as { $id: string; properties: { schemaVersion: { const: string } } };

    expect(publicContract.schemaVersion).toBe(
      requestSchema.properties.schemaVersion.const,
    );
    expect(publicContract.verificationRequestSchema).toBe(requestSchema.$id);
    expect(publicContract.sandboxJobRequestSchema).toBe(sandboxSchema.$id);
  });

  it("contains no forbidden provider or runtime dependencies in core manifests", () => {
    const corePackages = ["domain", "engine", "checks", "policy", "ai"];
    const forbidden =
      /github|docker|openai|anthropic|gemini|goat|redis|database/i;

    for (const name of corePackages) {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(Object.keys(manifest.dependencies ?? {})).not.toContainEqual(
        expect.stringMatching(forbidden),
      );
      expect(Object.keys(manifest.devDependencies ?? {})).not.toContainEqual(
        expect.stringMatching(forbidden),
      );
    }
  });
});
