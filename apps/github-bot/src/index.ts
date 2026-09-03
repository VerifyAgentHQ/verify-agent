export type {
  GitHubPullRequestDecision,
  GitHubPullRequestEvent,
  SupportedGitHubPullRequestAction,
} from "../../../packages/adapters-source/src/github-pr.js";
export {
  SUPPORTED_GITHUB_PR_ACTIONS,
  decideGitHubPullRequestEvent,
  isSupportedGitHubPullRequestAction,
} from "../../../packages/adapters-source/src/github-pr.js";

export const githubBotBoundary = {
  status: "implemented",
  purpose:
    "Deterministic GitHub PR event → immutable source reference boundary.",
};
