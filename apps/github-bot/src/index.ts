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
  ConfiguredGitHubWebhookHandlerOptions,
  GitHubWebhookHandlerOptions,
  GitHubWebhookHttpOptions,
  GitHubWebhookHttpResult,
  GitHubWebhookReplayGuard,
  GitHubWebhookRequest,
  GitHubWebhookSuccess,
  GitHubWebhookVerificationOptions,
} from "./webhook.js";
export type {
  GitHubVerificationOrchestrator,
  GitHubVerificationOrchestrationResult,
} from "./verification-orchestrator.js";
export {
  GitHubWebhookAuthenticationError,
  GitHubWebhookConfigurationError,
  GitHubWebhookPayloadError,
  GitHubWebhookReplayError,
  GitHubWebhookUnsupportedEventError,
  collectRawBody,
  createConfiguredGitHubWebhookHandler,
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
export { createGitHubVerificationOrchestrator } from "./verification-orchestrator.js";

export const githubBotBoundary = {
  status: "implemented",
  purpose:
    "Deterministic GitHub PR event → immutable source reference boundary with secure webhook trust boundary.",
};
