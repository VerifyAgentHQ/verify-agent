import type {
  MvpCheckRunEvidence,
  VerificationResult,
} from "@verify-agent/domain";
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

function safeMarkdownUrl(value: string | undefined): string | undefined {
  if (value === undefined || /[\r\n\s]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export interface MvpReview {
  readonly ci: "PASS" | "FAIL" | "PENDING" | "ERROR";
  readonly checks: readonly string[];
  readonly requirements: readonly RequirementResult[];
  readonly findings: readonly string[];
  readonly evidence: readonly RequirementEvidence[];
  readonly checkEvidence: readonly MvpCheckRunEvidence[];
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

export type MvpCheckCategory = "Build" | "Typecheck" | "Lint" | "Tests";

export type GitHubCheckRunInput = {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly status?: unknown;
  readonly conclusion?: unknown;
  readonly html_url?: unknown;
  readonly head_sha?: unknown;
};

export type MvpCiEvaluation = {
  readonly state: "PASS" | "FAIL" | "PENDING" | "ERROR";
  readonly lines: readonly string[];
  readonly evidence: readonly MvpCheckRunEvidence[];
};

function checkCategory(name: string): MvpCheckCategory | undefined {
  const lower = name.toLowerCase();
  if (lower.includes("type") && lower.includes("check")) return "Typecheck";
  if (lower.includes("lint")) return "Lint";
  if (lower.includes("test")) return "Tests";
  if (lower.includes("build")) return "Build";
  return undefined;
}

export function evaluateMvpCheckRuns(input: {
  readonly commitSha: string;
  readonly runs: readonly GitHubCheckRunInput[];
  readonly requiredCategories?: readonly MvpCheckCategory[];
}): MvpCiEvaluation {
  const selected = new Map<MvpCheckCategory, GitHubCheckRunInput>();
  for (const run of input.runs) {
    if (
      typeof run.head_sha === "string" &&
      run.head_sha.toLowerCase() !== input.commitSha.toLowerCase()
    )
      continue;
    const name = typeof run.name === "string" ? run.name : "";
    const category = checkCategory(name);
    if (category === undefined) continue;
    const prior = selected.get(category);
    const id = typeof run.id === "number" ? run.id : 0;
    const priorId = typeof prior?.id === "number" ? prior.id : -1;
    if (prior === undefined || id >= priorId) selected.set(category, run);
  }

  const required = [...new Set(input.requiredCategories ?? [])];
  const missing = required.filter((category) => !selected.has(category));
  const categories = [...selected.keys()].sort();
  const evidence: MvpCheckRunEvidence[] = categories.flatMap((category) => {
    const run = selected.get(category)!;
    if (
      typeof run.id !== "number" ||
      !Number.isSafeInteger(run.id) ||
      run.id <= 0
    )
      return [];
    const name = typeof run.name === "string" ? run.name : "unnamed check";
    const url =
      typeof run.html_url === "string"
        ? safeMarkdownUrl(run.html_url)
        : undefined;
    return [
      {
        id: run.id,
        name,
        category,
        status: typeof run.status === "string" ? run.status : "unknown",
        ...(typeof run.conclusion === "string"
          ? { conclusion: run.conclusion }
          : {}),
        headSha: input.commitSha,
        ...(url === undefined ? {} : { url }),
      },
    ];
  });

  const lines = [
    ...categories.map((category) => {
      const run = selected.get(category)!;
      const url =
        typeof run.html_url === "string"
          ? safeMarkdownUrl(run.html_url)
          : undefined;
      const link = url === undefined ? "" : ` ([check](${url}))`;
      if (run.status !== "completed") return `⏳ ${category} (PENDING)${link}`;
      return run.conclusion === "success"
        ? `✅ ${category}${link}`
        : `❌ ${category} (${String(run.conclusion ?? "ERROR").toUpperCase()})${link}`;
    }),
    ...missing.map((category) => `⏳ ${category} (MISSING)`),
  ];
  if (lines.length === 0)
    return {
      state: "PENDING",
      lines: ["⏳ CI/check results pending (no relevant checks found)"],
      evidence,
    };
  if (
    missing.length > 0 ||
    [...selected.values()].some((run) => run.status !== "completed")
  )
    return { state: "PENDING", lines, evidence };
  if ([...selected.values()].some((run) => run.conclusion !== "success"))
    return { state: "FAIL", lines, evidence };
  return { state: "PASS", lines, evidence };
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
        const label = `\`${location.file}${line}\``;
        const url = safeMarkdownUrl(location.url);
        return url === undefined ? label : `[${label}](${url})`;
      })
      .filter((location, index, all) => all.indexOf(location) === index)
      .slice(0, 10);
    if (locations.length > 0) return locations.join(", ");
    return item.matchedFiles.map((file) => `\`${file}\``).join(", ");
  };
  return evidence.flatMap((item) => {
    const icon =
      item.status === "passed" ? "✅" : item.status === "failed" ? "❌" : "⚠️";
    const sourceUrl = safeMarkdownUrl(item.source.url);
    const source =
      sourceUrl === undefined ? "" : ` ([requirement source](${sourceUrl}))`;
    const lines = [`${icon} ${item.requirementText}${source}`];
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
          : item.rule === "checkout-persist-credentials-disabled"
            ? "`actions/checkout` sets `persist-credentials: false`"
            : "the required file appears in the changed-file set";
      lines.push(`Rule: ${rule}`);
      if (item.observedText.length > 0)
        lines.push(
          `Verified: ${item.observedText.length} ${
            item.rule === "github-action-pinned"
              ? "action references"
              : item.rule === "checkout-persist-credentials-disabled"
                ? "checkout steps"
                : "required file(s)"
          }`,
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
}

export function createGitHubPrCommentPublisher(options: {
  appConfig: GitHubAppConfig;
  installationResolver: GitHubInstallationResolver;
  installationTokenClient: GitHubAppInstallationTokenClient;
  apiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
  requiredCheckCategories?: readonly MvpCheckCategory[];
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
        evidence: MvpCheckRunEvidence[];
      } = {
        state: "ERROR",
        lines: ["⚠️ CI/check results unavailable"],
        evidence: [],
      };
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
          id?: unknown;
          html_url?: unknown;
          head_sha?: unknown;
        }> = Array.isArray(data?.check_runs) ? data.check_runs : [];
        const relevantRuns = runs.filter((run) => {
          if (
            typeof run?.head_sha === "string" &&
            run.head_sha.toLowerCase() !== input.commitSha.toLowerCase()
          )
            return false;
          const name =
            typeof run?.name === "string" ? run.name.toLowerCase() : "";
          return /build|type[- ]?check|lint|test/.test(name);
        });
        const categoryFor = (rawName: string): string => {
          const lowerName = rawName.toLowerCase();
          return lowerName.includes("type") && lowerName.includes("check")
            ? "Typecheck"
            : lowerName.includes("lint")
              ? "Lint"
              : lowerName.includes("test")
                ? "Tests"
                : "Build";
        };
        const selected = new Map<string, (typeof relevantRuns)[number]>();
        for (const run of relevantRuns) {
          const rawName =
            typeof run?.name === "string" ? run.name : "unnamed check";
          const category = categoryFor(rawName);
          const prior = selected.get(category);
          const id = typeof run.id === "number" ? run.id : 0;
          const priorId =
            typeof prior?.id === "number" ? prior.id : Number.MAX_SAFE_INTEGER;
          if (prior === undefined || id >= priorId) selected.set(category, run);
        }
        const checkEvidence: MvpCheckRunEvidence[] = [
          ...selected.entries(),
        ].flatMap(([category, run]) => {
          if (
            typeof run.id !== "number" ||
            !Number.isSafeInteger(run.id) ||
            run.id <= 0
          )
            return [];
          return [
            {
              id: run.id,
              name: typeof run.name === "string" ? run.name : "unnamed check",
              category: category as MvpCheckRunEvidence["category"],
              status: typeof run.status === "string" ? run.status : "unknown",
              ...(typeof run.conclusion === "string"
                ? { conclusion: run.conclusion }
                : {}),
              headSha: input.commitSha,
              ...(typeof run.html_url === "string"
                ? (() => {
                    const url = safeMarkdownUrl(run.html_url);
                    return url === undefined ? {} : { url };
                  })()
                : {}),
            },
          ];
        });
        const lines = [...selected.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([category, run]) => {
            const checkUrl =
              typeof run?.html_url === "string"
                ? safeMarkdownUrl(run.html_url)
                : undefined;
            const link =
              checkUrl === undefined ? "" : ` ([check](${checkUrl}))`;
            if (run?.status !== "completed")
              return `⏳ ${category} (PENDING)${link}`;
            return run?.conclusion === "success"
              ? `✅ ${category}${link}`
              : `❌ ${category} (${String(run?.conclusion ?? "ERROR").toUpperCase()})${link}`;
          });
        const missing = (options.requiredCheckCategories ?? []).filter(
          (category) => !selected.has(category),
        );
        lines.push(...missing.map((category) => `⏳ ${category} (MISSING)`));
        if (selected.size === 0)
          ci = {
            state: "PENDING",
            lines: ["⏳ CI/check results pending (no completed checks found)"],
            evidence: [],
          };
        else if (
          missing.length > 0 ||
          [...selected.values()].some((run) => run?.status !== "completed")
        )
          ci = { state: "PENDING", lines, evidence: checkEvidence };
        else if (
          [...selected.values()].some((run) => run?.conclusion !== "success")
        )
          ci = { state: "FAIL", lines, evidence: checkEvidence };
        else ci = { state: "PASS", lines, evidence: checkEvidence };
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
          commitSha: input.commitSha,
          repositoryUrl: `https://github.com/${input.owner}/${input.repository}`,
          collectedAt: new Date().toISOString(),
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
        checkEvidence: ci.evidence,
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
