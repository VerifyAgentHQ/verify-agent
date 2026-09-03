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
export type {
  GitHubWebhookHandlerOptions,
  GitHubWebhookHttpOptions,
  GitHubWebhookHttpResult,
  GitHubWebhookReplayGuard,
  GitHubWebhookRequest,
  GitHubWebhookSuccess,
  GitHubWebhookVerificationOptions,
} from "./webhook.js";
export {
  GitHubWebhookAuthenticationError,
  GitHubWebhookPayloadError,
  GitHubWebhookReplayError,
  GitHubWebhookUnsupportedEventError,
  collectRawBody,
  createGitHubWebhookHttpHandler,
  createInMemoryGitHubWebhookReplayGuard,
  handleGitHubWebhookHttpRequest,
  handleGitHubWebhookRequest,
  parseTrustedGitHubPullRequestEvent,
  readGitHubWebhookSecret,
  readSingleHeader,
  readSingleHeaderFromIncomingMessage,
  verifyGitHubWebhookSignature,
} from "./webhook.js";

export const githubBotBoundary = {
  status: "implemented",
  purpose:
    "Deterministic GitHub PR event → immutable source reference boundary with secure webhook trust boundary.",
};
