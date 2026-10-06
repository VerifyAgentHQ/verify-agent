import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  brandId,
  type VerificationResult,
} from "../packages/domain/src/index.js";
import { createFileVerificationResultRegistry } from "../apps/worker/src/result-registry.js";
import { renderMvpComment } from "../apps/api/src/github-pr-comment.js";
import { evaluatePullRequestRequirements } from "../apps/api/src/pr-requirements.js";
import { calculateMvpVerdict } from "../apps/api/src/mvp-verdict.js";

const source = {
  kind: "pull_request" as const,
  owner: "StellarForgeDev",
  repository: "stellar-forge",
  number: 11,
  field: "body" as const,
};

const patch = `@@ -13,17 +13,18 @@
-      - uses: actions/checkout@v4
+      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
+          persist-credentials: false
-      - uses: pnpm/action-setup@v4
+      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1`;

function requirements(patchText = patch) {
  return evaluatePullRequestRequirements({
    description:
      "Pin CI actions to verified immutable commits and disable persisted checkout credentials.",
    requirementSources: [
      {
        source,
        text: "Pin CI actions to verified immutable commits and disable persisted checkout credentials.",
      },
    ],
    changedFiles: [".github/workflows/ci.yml"],
    patches: { ".github/workflows/ci.yml": patchText },
  });
}

describe("Requirement Evidence milestone", () => {
  it("splits PR #11 wording and preserves PR body provenance", () => {
    const result = requirements();
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.text)).toEqual([
      "Pin CI actions to verified immutable commits",
      "Disable persisted checkout credentials",
    ]);
    expect(result.every((item) => item.evidence?.source === source)).toBe(true);
  });

  it("passes pinned actions and checkout credentials with concrete evidence", () => {
    const result = requirements();
    expect(result.map((item) => item.status)).toEqual(["passed", "passed"]);
    expect(result[0]?.evidence?.rule).toBe("github-action-pinned");
    expect(result[0]?.evidence?.observedText.length).toBe(2);
    expect(
      result[0]?.evidence?.locations.map((location) => [
        location.startLine,
        location.side,
      ]),
    ).toEqual([
      [13, "RIGHT"],
      [15, "RIGHT"],
    ]);
    expect(result[1]?.evidence?.rule).toBe(
      "checkout-persist-credentials-disabled",
    );
    expect(result[1]?.evidence?.observedText).toEqual([
      "persist-credentials: false",
    ]);
    expect(
      result[1]?.evidence?.locations.map((location) => [
        location.startLine,
        location.side,
      ]),
    ).toEqual([
      [13, "RIGHT"],
      [14, "RIGHT"],
    ]);
  });

  it("fails an unpinned action and distinguishes unavailable evidence", () => {
    expect(
      requirements(
        patch.replace(/b906affcce14559ad1aafd4ab0e942779e9f58b1/, "v4"),
      )[0]?.status,
    ).toBe("failed");
    expect(requirements("")[0]?.status).toBe("unknown");
    expect(
      calculateMvpVerdict({
        ci: "PASS",
        requirements: [{ text: "unknown", status: "unknown" }],
      }),
    ).toBe("blocked");
  });

  it("persists and renders the same evidence", () => {
    const evidence = requirements().map((item) => item.evidence!);
    const result: VerificationResult = {
      id: brandId<"VerificationId">("mvp-evidence-test"),
      requestId: brandId<"VerificationRequestId">("request-evidence-test"),
      jobId: brandId<"VerificationJobId">("job-evidence-test"),
      projectId: brandId<"ProjectId">("project-evidence-test"),
      snapshotId: brandId<"RepositorySnapshotId">("snapshot-evidence-test"),
      changeSetId: brandId<"ChangeSetId">("changes-evidence-test"),
      status: "pass",
      coverage: {
        verified: [],
        partial: [],
        unsupported: [],
        notApplicable: [],
        simulated: [],
        fixture: [],
      },
      checkResults: [],
      evidenceReferences: [],
      findingReferences: [],
      policyDecision: brandId<"PolicyDecisionId">("mvp-policy-evidence-test"),
      summary: "MVP verdict: PASS",
      resultVersion: "1.0.0",
      contentHash: "a".repeat(64),
      createdAt: "2026-01-01T00:00:00.000Z",
      requirementEvidence: evidence,
    };
    const root = mkdtempSync(join(tmpdir(), "verifyagent-evidence-"));
    const path = join(root, "results.json");
    try {
      createFileVerificationResultRegistry({ filePath: path }).store(
        "queue-evidence-test",
        result,
      );
      const restarted = createFileVerificationResultRegistry({
        filePath: path,
      });
      expect(
        restarted.getByQueueJobId("queue-evidence-test")?.requirementEvidence,
      ).toEqual(evidence);
      const body = renderMvpComment({
        commitSha: "a".repeat(40),
        resultId: String(result.id),
        policyId: String(result.policyDecision),
        verdict: "pass",
        checks: ["✅ Build"],
        requirements: [],
        findings: [],
        evidence,
      });
      expect(body).toContain(".github/workflows/ci.yml");
      expect(body).toContain("full commit SHA");
      expect(body).toContain("persist-credentials: false");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
