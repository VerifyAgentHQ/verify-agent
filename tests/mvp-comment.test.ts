import { describe, expect, it } from "vitest";
import { renderMvpComment } from "../apps/api/src/github-pr-comment.js";
import { evaluatePullRequestRequirements } from "../apps/api/src/pr-requirements.js";

describe("MVP comment composition", () => {
  it("does not render legacy sandbox check failures in an MVP PASS", () => {
    const body = renderMvpComment({
      commitSha: "a".repeat(40),
      resultId: "mvp-result-1",
      policyId: "mvp-policy-1",
      verdict: "pass",
      checks: ["✅ Build", "✅ Typecheck", "✅ Lint", "✅ Tests"],
      requirements: [{ text: "Pin CI actions", status: "passed" }],
      findings: [],
    });
    expect(body).toContain("✅ PASS");
    expect(body).not.toContain("typescript.build");
    expect(body).not.toContain("legacy-verification");
    expect(body).not.toContain("legacy-policy");
  });

  it("renders only current CI and requirement evidence without duplicate checks", () => {
    const body = renderMvpComment({
      commitSha: "b".repeat(40),
      resultId: "mvp-result-2",
      policyId: "mvp-policy-2",
      verdict: "pass",
      checks: [
        "✅ Build",
        "✅ Typecheck",
        "✅ Typecheck",
        "✅ Lint",
        "✅ Tests",
      ],
      requirements: [
        { text: "Pin CI actions to immutable commits", status: "passed" },
        { text: "Disable persisted checkout credentials", status: "passed" },
      ],
      findings: [],
    });
    expect(body.match(/✅ Typecheck/g)).toHaveLength(1);
    expect(body).toContain(
      "✅ Requirement 1: Pin CI actions to immutable commits",
    );
    expect(body).toContain(
      "✅ Requirement 2: Disable persisted checkout credentials",
    );
    expect(body).toContain("No action required.");
    expect(body).toContain("MVP result: `mvp-result-2`");
    expect(body).toContain("MVP policy: `mvp-policy-2`");
    expect(body).not.toContain("mvp-aaaaaaaaaaaa");
    expect(body).not.toContain("mvp-policy-aaaaaaaaaaaa");
  });

  it("renders only MVP findings for a BLOCKED verdict", () => {
    const body = renderMvpComment({
      commitSha: "c".repeat(40),
      resultId: "mvp-result-3",
      policyId: "mvp-policy-3",
      verdict: "blocked",
      checks: ["❌ Tests"],
      requirements: [
        {
          text: "Add tests",
          status: "failed",
          finding: "No test file was changed.",
        },
      ],
      findings: ["No test file was changed."],
    });
    expect(body).toContain("❌ BLOCKED");
    expect(body).toContain("- No test file was changed.");
    expect(body).not.toContain("typescript.test");
    expect(body).not.toContain("legacy-finding");
  });

  it("renders precise evidence locations and patch fallback", () => {
    const evidence = evaluatePullRequestRequirements({
      description: "Pin CI actions to immutable commits.",
      changedFiles: [".github/workflows/ci.yml"],
      patches: {
        ".github/workflows/ci.yml":
          "@@ -1,1 +13,1 @@\n+      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      },
    })[0]?.evidence;
    expect(evidence?.locations[0]).toMatchObject({
      file: ".github/workflows/ci.yml",
      startLine: 13,
      endLine: 13,
      side: "RIGHT",
    });

    const fallback = renderMvpComment({
      commitSha: "d".repeat(40),
      resultId: "mvp-result-4",
      policyId: "mvp-policy-4",
      verdict: "blocked",
      checks: ["⚠️ CI"],
      requirements: [],
      findings: ["Evidence unavailable."],
      evidence: [
        {
          ...evidence!,
          locations: [
            {
              file: ".github/workflows/ci.yml",
              patchHunk: "@@ -1,1 +13,1 @@",
            },
          ],
        },
      ],
    });
    expect(fallback).toContain(
      "Evidence: `.github/workflows/ci.yml (patch @@ -1,1 +13,1 @@)`",
    );
  });
});
