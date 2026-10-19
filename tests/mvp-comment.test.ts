import { describe, expect, it } from "vitest";
import {
  evaluateMvpCheckRuns,
  renderMvpComment,
} from "../apps/api/src/github-pr-comment.js";
import { evaluatePullRequestRequirements } from "../apps/api/src/pr-requirements.js";

describe("MVP comment composition", () => {
  const sha = "a".repeat(40);

  it("requires explicitly configured CI categories and rejects wrong-SHA runs", () => {
    const result = evaluateMvpCheckRuns({
      commitSha: sha,
      requiredCategories: ["Build", "Typecheck", "Tests"],
      runs: [
        {
          id: 1,
          name: "CI / Typecheck",
          status: "completed",
          conclusion: "success",
          head_sha: sha,
        },
        {
          id: 2,
          name: "CI / Build",
          status: "completed",
          conclusion: "success",
          head_sha: "b".repeat(40),
        },
        {
          id: 3,
          name: "CI / Tests",
          status: "completed",
          conclusion: "success",
          head_sha: sha,
        },
      ],
    });
    expect(result.state).toBe("PENDING");
    expect(result.lines).toContain("⏳ Build (MISSING)");
    expect(result.evidence.map((item) => item.category)).toEqual([
      "Tests",
      "Typecheck",
    ]);
  });

  it("classifies failed, pending, and successful authoritative checks", () => {
    const base = [
      {
        id: 1,
        name: "Build",
        status: "completed",
        conclusion: "success",
        head_sha: sha,
      },
      {
        id: 2,
        name: "Typecheck",
        status: "completed",
        conclusion: "failure",
        head_sha: sha,
      },
      { id: 3, name: "Tests", status: "queued", head_sha: sha },
    ];
    expect(evaluateMvpCheckRuns({ commitSha: sha, runs: base }).state).toBe(
      "PENDING",
    );
    expect(
      evaluateMvpCheckRuns({ commitSha: sha, runs: base.slice(0, 2) }).state,
    ).toBe("FAIL");
    expect(
      evaluateMvpCheckRuns({
        commitSha: sha,
        runs: [
          {
            id: 4,
            name: "Build",
            status: "completed",
            conclusion: "success",
            head_sha: sha,
          },
          {
            id: 5,
            name: "Typecheck",
            status: "completed",
            conclusion: "success",
            head_sha: sha,
          },
        ],
      }).state,
    ).toBe("PASS");
  });

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

  it("renders required-file evidence with its own rule", () => {
    const evidence = evaluatePullRequestRequirements({
      description: "Add `docs/verifyagent-phase5.md`.",
      changedFiles: ["docs/verifyagent-phase5.md"],
      patches: { "docs/verifyagent-phase5.md": "@@ -0,0 +1 @@\n+# Phase 5" },
    })[0]?.evidence;
    const body = renderMvpComment({
      commitSha: "e".repeat(40),
      resultId: "mvp-result-5",
      policyId: "mvp-policy-5",
      verdict: "pass",
      checks: ["✅ Typecheck"],
      requirements: [],
      findings: [],
      evidence: evidence ? [evidence] : [],
    });
    expect(body).toContain(
      "Rule: the required file appears in the changed-file set",
    );
    expect(body).not.toContain("persist-credentials");
  });

  it("renders immutable requirement and evidence links", () => {
    const body = renderMvpComment({
      commitSha: "f".repeat(40),
      resultId: "mvp-result-links",
      policyId: "mvp-policy-links",
      verdict: "pass",
      checks: [
        "✅ Build ([check](https://github.com/example/repo/actions/runs/1))",
      ],
      requirements: [],
      findings: [],
      evidence: [
        {
          id: "requirement-evidence-links" as never,
          requirementId: "requirement-links",
          source: {
            kind: "pull_request",
            owner: "example",
            repository: "repo",
            number: 1,
            field: "body",
            url: "https://github.com/example/repo/pull/1",
          },
          requirementText: "Add the required workflow change",
          rule: "required-file-changed",
          status: "passed",
          explanation: "The required file is changed.",
          matchedFiles: [".github/workflows/ci.yml"],
          locations: [
            {
              file: ".github/workflows/ci.yml",
              side: "RIGHT",
              startLine: 10,
              url: "https://github.com/example/repo/blob/ffffffffffffffffffffffffffffffffffffffff/.github/workflows/ci.yml#L10",
            },
          ],
          observedText: [".github/workflows/ci.yml"],
          evidenceHash: "a".repeat(64),
          commitSha: "f".repeat(40),
          collectedAt: "2026-10-19T00:00:00.000Z",
        },
      ],
    });
    expect(body).toContain(
      "[requirement source](https://github.com/example/repo/pull/1)",
    );
    expect(body).toContain(
      "https://github.com/example/repo/blob/ffffffffffffffffffffffffffffffffffffffff/.github/workflows/ci.yml#L10",
    );
    expect(body).toContain(
      "✅ Build ([check](https://github.com/example/repo/actions/runs/1))",
    );
  });

  it("does not render malformed evidence URLs as Markdown links", () => {
    const body = renderMvpComment({
      commitSha: "a".repeat(40),
      resultId: "mvp-result-safe-links",
      policyId: "mvp-policy-safe-links",
      verdict: "blocked",
      checks: [],
      requirements: [],
      findings: [],
      evidence: [
        {
          id: "requirement-evidence-safe-links" as never,
          source: {
            kind: "pull_request",
            owner: "example",
            repository: "repo",
            number: 1,
            field: "body",
            url: "javascript:alert(1)",
          },
          requirementText: "Unsafe link",
          rule: "required-file-changed",
          status: "unknown",
          explanation: "Evidence unavailable.",
          matchedFiles: [],
          locations: [],
          observedText: [],
          evidenceHash: "b".repeat(64),
        },
      ],
    });
    expect(body).toContain("⚠️ Unsafe link");
    expect(body).not.toContain("javascript:");
  });
});
