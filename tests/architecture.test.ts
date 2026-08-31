import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CheckExecutionStatus,
  CheckStatus,
  VerificationStatus,
} from "../packages/domain/src/index.js";
import { publicContract } from "../packages/domain/src/index.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contractsRoot = join(repoRoot, "..", "verify-contracts");

describe("architecture boundaries", () => {
  it("tracks authoritative sibling contract metadata without copying schemas", () => {
    const schema = JSON.parse(
      readFileSync(
        join(contractsRoot, "schemas", "common", "common.schema.json"),
        "utf8",
      ),
    ) as {
      $id: string;
      $defs: { SourceReference: object; SourceState: object };
    };

    expect(schema.$id).toBe(
      "https://contracts.verifyagent.dev/schemas/common/common.schema.json",
    );
    expect(schema.$defs.SourceReference).toBeDefined();
    expect(schema.$defs.SourceState).toBeDefined();
    expect(publicContract.schemaVersion).toBe("1.0.0");
  });

  it("keeps core package manifests free of provider/runtime dependencies", () => {
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

  it("keeps execution, result, and verification status types distinct", () => {
    const executionStatus: CheckExecutionStatus = "queued";
    const resultStatus: CheckStatus = "timed_out";
    const verificationStatus: VerificationStatus = "needs_review";
    expect([executionStatus, resultStatus, verificationStatus]).toEqual([
      "queued",
      "timed_out",
      "needs_review",
    ]);
  });

  it("does not use a fabricated zero hash in the engine placeholder", () => {
    const runtime = readFileSync(
      join(repoRoot, "packages", "engine", "src", "runtime.ts"),
      "utf8",
    );
    expect(runtime).not.toContain("repeat(64)");
    expect(runtime).toContain("not implemented");
  });
});
