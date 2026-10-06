import type { VerificationResult } from "@verify-agent/domain";
import type { RequirementEvidence } from "@verify-agent/domain";
import type {
  GitHubAppConfig,
  GitHubAppInstallationTokenClient,
  GitHubInstallationResolver,
} from "@verify-agent/adapters-source";
import {
  evaluatePullRequestRequirements,
  type RequirementResult,
  type RequirementSourceText,
} from "./pr-requirements.js";
import { calculateMvpVerdict } from "./mvp-verdict.js";

export const VERIFY_AGENT_COMMENT_MARKER = "<!-- verifyagent:pr-comment -->";

export interface MvpReview {
  readonly ci: "PASS" | "FAIL" | "PENDING" | "ERROR";
  readonly checks: readonly string[];
  readonly requirements: readonly RequirementResult[];
  readonly findings: readonly string[];
  readonly evidence: readonly RequirementEvidence[];
  readonly status: "pass" | "blocked";
}

export interface MvpCommentInput {
  readonly commitSha: string;
  readonly resultId: string;
  readonly policyId: string;
  readonly verdict: "pass" | "blocked";
  readonly checks: readonly string[];
  readonly requirements: readonly RequirementResult[];
  readonly findings: readonly string[];
  readonly evidence?: readonly RequirementEvidence[];
}

function renderRequirementEvidence(
  evidence: readonly RequirementEvidence[],
): string[] {
  const renderLocations = (item: RequirementEvidence): string => {
    const locations = item.locations
      .map((location) => {
        const line =
          location.startLine === undefined
            ? location.patchHunk === undefined
              ? ""
              : ` (patch ${location.patchHunk})`
            : `:${location.startLine}${
                location.endLine !== undefined &&
                location.endLine !== location.startLine
                  ? `-${location.endLine}`
                  : ""
              }${location.side === undefined ? "" : ` (${location.side})`}`;
        return `\`${location.file}${line}\``;
      })
      .filter((location, index, all) => all.indexOf(location) === index)
      .slice(0, 10);
    if (locations.length > 0) return locations.join(", ");
    return item.matchedFiles.map((file) => `\`${file}\``).join(", ");
  };
  return evidence.flatMap((item) => {
    const icon =
      item.status === "passed" ? "✅" : item.status === "failed" ? "❌" : "⚠️";
    const lines = [`${icon} ${item.requirementText}`];
    if (item.status === "unknown") {
      lines.push(`Evidence unavailable: ${item.explanation}`);
    } else {
      if (item.matchedFiles.length > 0)
        lines.push(`Evidence: ${renderLocations(item)}`);
      if (item.status === "failed") {
        lines.push(`Finding: ${item.explanation}`);
        return [...lines, ""];
      }
      const rule =
        item.rule === "github-action-pinned"
          ? "every relevant `uses:` reference is pinned to a full commit SHA"
          : "`actions/checkout` sets `persist-credentials: false`";
      lines.push(`Rule: ${rule}`);
      if (item.observedText.length > 0)
        lines.push(
          `Verified: ${item.observedText.length} ${item.rule === "github-action-pinned" ? "action references" : "checkout steps"}`,
        );
    }
    return [...lines, ""];
  });
}

export function renderMvpComment(input: MvpCommentInput): string {
  const requirements =
    input.evidence !== undefined
      ? renderRequirementEvidence(input.evidence)
      : input.requirements.length === 0
        ? [
            "No explicit, machine-checkable requirements found in the PR/issue text.",
          ]
        : input.requirements.map(
            (item, index) =>
              `${item.status === "passed" ? "✅" : item.status === "failed" ? "❌" : "⚠️"} Requirement ${index + 1}: ${item.text}`,
          );
  const findings =
    input.findings.length === 0
      ? ["None."]
      : input.findings.map((finding) => `- ${finding}`);
  const fixes = input.verdict === "pass" ? ["No action required."] : findings;
  return [
    VERIFY_AGENT_COMMENT_MARKER,
    "## 🤖 VerifyAgent",
    `**Verdict: ${input.verdict === "pass" ? "✅ PASS" : "❌ BLOCKED"}**`,
    "",
    "### Checks",
    ...[...new Set(input.checks)],
    "",
    "### Issue requirements",
    ...requirements,
    "",
    "### Findings",
    ...findings,
    "",
    "### What to fix",
    ...fixes,
    "",
    "### Verification",
    `Commit: \`${input.commitSha.slice(0, 12)}\``,
    `MVP result: \`${input.resultId}\``,
    `MVP policy: \`${input.policyId}\``,
  ].join("\n");
}

export interface GitHubPrCommentPublisher {
  publish(input: {
    result: VerificationResult;
    owner: string;
    repository: string;
    pullRequestNumber: number;
    commitSha: string;
  }): Promise<void | MvpReview>;
}

function bodyFor(
  input: Parameters<GitHubPrCommentPublisher["publish"]>[0],
  ci: { state: "PASS" | "FAIL" | "PENDING" | "ERROR"; lines: string[] },
  requirements: readonly RequirementResult[],
): string {
  const legacyPass =
    calculateMvpVerdict({ ci: ci.state, requirements }) === "pass";
  return renderMvpComment({
    commitSha: input.commitSha,
    resultId: String(input.result.id),
    policyId: String(input.result.policyDecision),
    verdict: legacyPass ? "pass" : "blocked",
    checks: [...new Set(ci.lines)],
    requirements,
    findings: requirements.flatMap((item) =>
      item.finding ? [item.finding] : [],
    ),
    evidence: requirements.flatMap((item) =>
      item.evidence === undefined ? [] : [item.evidence],
    ),
  });
  /* Legacy sandbox fields below are intentionally unreachable and retained
   * only in the old result model; they must never compose the MVP comment. */
  /* istanbul ignore next */
  const pass = calculateMvpVerdict({ ci: ci.state, requirements }) === "pass";
  const checkLines = input.result.coverage.verified.map((name) => `✅ ${name}`);
  const failed = input.result.coverage.partial.concat(
    input.result.coverage.unsupported,
  );
  checkLines.push(...failed.map((name) => `❌ ${name}`));
  if (checkLines.length === 0)
    checkLines.push(pass ? "✅ Verification" : "❌ Verification");
  return [
    VERIFY_AGENT_COMMENT_MARKER,
    "## 🤖 VerifyAgent",
    `**Verdict: ${pass ? "✅ PASS" : "❌ BLOCKED"}**`,
    "",
    "### Checks",
    ...checkLines,
    ...ci.lines,
    "",
    "### Issue requirements",
    ...(requirements.length === 0
      ? [
          "No explicit, machine-checkable requirements found in the PR/issue text.",
        ]
      : requirements.map(
          (item, index) =>
            `${item.status === "passed" ? "✅" : item.status === "failed" ? "❌" : "⚠️"} Requirement ${index + 1}: ${item.text}`,
        )),
    pass
      ? "✅ Deterministic repository policy"
      : "❌ Deterministic repository policy",
    "",
    "### Findings",
    ...requirements.flatMap((item) =>
      item.finding ? [`- ${item.finding}`] : [],
    ),
    ...(input.result.findingReferences.length > 0
      ? [
          `- ${input.result.findingReferences.length} deterministic finding(s) recorded in the verification result.`,
        ]
      : []),
    ...(requirements.every((item) => !item.finding) &&
    input.result.findingReferences.length === 0
      ? ["None."]
      : []),
    "",
    "### What to fix",
    ...(pass
      ? ["No action required."]
      : requirements
          .flatMap((item) => (item.finding ? [`- ${item.finding}`] : []))
          .concat(input.result.summary)),
    "",
    "### Verification",
    `Commit: \`${input.commitSha.slice(0, 12)}\``,
    `Result: \`${String(input.result.id)}\``,
    `Policy: \`${String(input.result.policyDecision)}\``,
  ].join("\n");
}

export function createGitHubPrCommentPublisher(options: {
  appConfig: GitHubAppConfig;
  installationResolver: GitHubInstallationResolver;
  installationTokenClient: GitHubAppInstallationTokenClient;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}): GitHubPrCommentPublisher {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const base = (options.apiBaseUrl ?? "https://api.github.com").replace(
    /\/+$/,
    "",
  );
  const request = async (
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> => {
    const response = await fetchFn(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "verify-agent",
      },
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "verify-agent",
            },
          }),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(`GitHub comment request failed (${response.status})`);
    return response.status === 204 ? null : response.json();
  };
  return {
    async publish(input) {
      const installation =
        await options.installationResolver.resolveInstallationId(
          input.owner,
          input.repository,
        );
      const token = (
        await options.installationTokenClient.createInstallationToken(
          installation,
        )
      ).token;
      const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.pullRequestNumber}/comments`;
      let ci: {
        state: "PASS" | "FAIL" | "PENDING" | "ERROR";
        lines: string[];
      } = { state: "ERROR", lines: ["⚠️ CI/check results unavailable"] };
      try {
        const data = await request(
          token,
          "GET",
          `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${encodeURIComponent(input.commitSha)}/check-runs?per_page=100`,
        );
        const runs: Array<{
          name?: unknown;
          status?: unknown;
          conclusion?: unknown;
        }> = Array.isArray(data?.check_runs) ? data.check_runs : [];
        const relevantRuns = runs.filter((run) => {
          const name =
            typeof run?.name === "string" ? run.name.toLowerCase() : "";
          return /build|type[- ]?check|lint|test/.test(name);
        });
        const lines = relevantRuns.map((run) => {
          const rawName =
            typeof run?.name === "string" ? run.name : "unnamed check";
          const lowerName = rawName.toLowerCase();
          const name =
            lowerName.includes("type") && lowerName.includes("check")
              ? "Typecheck"
              : lowerName.includes("lint")
                ? "Lint"
                : lowerName.includes("test")
                  ? "Tests"
                  : "Build";
          if (run?.status !== "completed") return `⏳ ${name} (PENDING)`;
          return run?.conclusion === "success"
            ? `✅ ${name}`
            : `❌ ${name} (${String(run?.conclusion ?? "ERROR").toUpperCase()})`;
        });
        if (relevantRuns.length === 0)
          ci = {
            state: "PENDING",
            lines: ["⏳ CI/check results pending (no completed checks found)"],
          };
        else if (relevantRuns.some((run) => run?.status !== "completed"))
          ci = { state: "PENDING", lines };
        else if (relevantRuns.some((run) => run?.conclusion !== "success"))
          ci = { state: "FAIL", lines };
        else ci = { state: "PASS", lines };
      } catch {
        // A missing/unavailable check is never represented as a pass.
      }
      let requirements: readonly RequirementResult[] = [];
      try {
        const pullPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}`;
        const pull = await request(token, "GET", pullPath);
        const requirementSources: RequirementSourceText[] = [];
        if (typeof pull?.title === "string") {
          requirementSources.push({
            source: {
              kind: "pull_request",
              owner: input.owner,
              repository: input.repository,
              number: input.pullRequestNumber,
              field: "title",
            },
            text: pull.title,
          });
        }
        if (typeof pull?.body === "string") {
          requirementSources.push({
            source: {
              kind: "pull_request",
              owner: input.owner,
              repository: input.repository,
              number: input.pullRequestNumber,
              field: "body",
            },
            text: pull.body,
          });
        }
        const text = requirementSources.map((item) => item.text).join("\n\n");
        const linkedIssues = [
          ...new Set(
            [...text.matchAll(/(?:^|\s)#(\d+)\b/g)]
              .map((match) => match[1])
              .filter((value): value is string => value !== undefined),
          ),
        ].filter((number) => number !== String(input.pullRequestNumber));
        const descriptions = [...requirementSources];
        for (const issue of linkedIssues.slice(0, 5)) {
          try {
            const issueData = await request(
              token,
              "GET",
              `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${issue}`,
            );
            if (typeof issueData?.title === "string")
              descriptions.push({
                source: {
                  kind: "issue",
                  owner: input.owner,
                  repository: input.repository,
                  number: Number(issue),
                  field: "title",
                },
                text: issueData.title,
              });
            if (typeof issueData?.body === "string")
              descriptions.push({
                source: {
                  kind: "issue",
                  owner: input.owner,
                  repository: input.repository,
                  number: Number(issue),
                  field: "body",
                },
                text: issueData.body,
              });
          } catch {
            /* issue lookup is supplemental */
          }
        }
        const filesData = await request(
          token,
          "GET",
          `${pullPath}/files?per_page=100`,
        );
        const changedFiles: string[] = [];
        const patches: Record<string, string> = {};
        for (const file of Array.isArray(filesData) ? filesData : []) {
          if (typeof file?.filename !== "string") continue;
          changedFiles.push(file.filename);
          patches[file.filename] =
            typeof file.patch === "string" ? file.patch : "";
        }
        requirements = evaluatePullRequestRequirements({
          description: text,
          requirementSources: descriptions,
          changedFiles,
          patches,
        });
      } catch {
        // The comment still reports the deterministic CI result if review data is unavailable.
      }
      const mvpReview: MvpReview = {
        ci: ci.state,
        checks: [...new Set(ci.lines)],
        requirements,
        findings: requirements.flatMap((item) =>
          item.finding ? [item.finding] : [],
        ),
        evidence: requirements.flatMap((item) =>
          item.evidence === undefined ? [] : [item.evidence],
        ),
        status: calculateMvpVerdict({ ci: ci.state, requirements }),
      };
      try {
        const comments = await request(token, "GET", `${path}?per_page=100`);
        const existing = Array.isArray(comments)
          ? comments.find(
              (comment) =>
                typeof comment?.body === "string" &&
                comment.body.includes(VERIFY_AGENT_COMMENT_MARKER),
            )
          : undefined;
        const body = { body: bodyFor(input, ci, requirements) };
        if (existing && typeof existing.id === "number") {
          await request(
            token,
            "PATCH",
            `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/comments/${existing.id}`,
            body,
          );
        } else {
          try {
            await request(token, "POST", path, body);
          } catch (error) {
            // Some GitHub App installations grant pull-request write access but
            // omit the separate issues write permission. A review body is still
            // a visible PR comment and supports the same one-comment marker.
            const reviewsPath = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}/reviews`;
            const reviews = await request(token, "GET", reviewsPath);
            const review = Array.isArray(reviews)
              ? reviews.find(
                  (item) =>
                    typeof item?.body === "string" &&
                    item.body.includes(VERIFY_AGENT_COMMENT_MARKER),
                )
              : undefined;
            if (review && typeof review.id === "number") {
              await request(token, "PUT", `${reviewsPath}/${review.id}`, body);
            } else {
              await request(token, "POST", reviewsPath, {
                ...body,
                commit_id: input.commitSha,
                event: "COMMENT",
              });
            }
            void error;
          }
        }
      } catch (error) {
        throw new Error(
          `VerifyAgent PR comment publication failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      return mvpReview;
    },
  };
}
