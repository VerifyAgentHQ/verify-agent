import { InvalidSourceReferenceError } from "./resolver.js";
import {
  type GitHubSnapshotReference,
  validateGitHubSnapshotReference,
} from "./github.js";

export const SUPPORTED_GITHUB_PR_ACTIONS = [
  "opened",
  "synchronize",
  "reopened",
] as const;

export type SupportedGitHubPullRequestAction =
  (typeof SUPPORTED_GITHUB_PR_ACTIONS)[number];

export function isSupportedGitHubPullRequestAction(
  action: string,
): action is SupportedGitHubPullRequestAction {
  return (SUPPORTED_GITHUB_PR_ACTIONS as readonly string[]).includes(action);
}

export type GitHubPullRequestEvent = {
  readonly action: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
  };
  readonly pullRequest: {
    readonly number: number;
    readonly base: {
      readonly sha: string;
    };
    readonly head: {
      readonly sha: string;
    };
  };
};

export type GitHubPullRequestDecision =
  | {
      readonly kind: "verify";
      readonly source: GitHubSnapshotReference;
      readonly pullRequestNumber: number;
      readonly baseSha: string;
      readonly headSha: string;
    }
  | {
      readonly kind: "ignore";
      readonly reason: string;
    };

function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidSourceReferenceError(`${name} must be a non-empty string`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new InvalidSourceReferenceError(`${name} must be a positive integer`);
  }
  return value;
}

function validateEventShape(event: unknown): GitHubPullRequestEvent {
  if (typeof event !== "object" || event === null || Array.isArray(event)) {
    throw new InvalidSourceReferenceError(
      "GitHub pull request event must be an object",
    );
  }
  const record = event as Record<string, unknown>;
  const action = assertNonEmptyString(record.action, "pull request action");

  const repository = record.repository;
  if (
    typeof repository !== "object" ||
    repository === null ||
    Array.isArray(repository)
  ) {
    throw new InvalidSourceReferenceError("repository must be an object");
  }
  const repoRecord = repository as Record<string, unknown>;
  const owner = assertNonEmptyString(repoRecord.owner, "repository.owner");
  const name = assertNonEmptyString(repoRecord.name, "repository.name");

  const pullRequest = record.pullRequest;
  if (
    typeof pullRequest !== "object" ||
    pullRequest === null ||
    Array.isArray(pullRequest)
  ) {
    throw new InvalidSourceReferenceError("pullRequest must be an object");
  }
  const prRecord = pullRequest as Record<string, unknown>;
  const number = assertPositiveInteger(prRecord.number, "pullRequest.number");

  const base = prRecord.base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    throw new InvalidSourceReferenceError("pullRequest.base must be an object");
  }
  const baseRecord = base as Record<string, unknown>;
  const baseSha = assertNonEmptyString(baseRecord.sha, "pullRequest.base.sha");

  const head = prRecord.head;
  if (typeof head !== "object" || head === null || Array.isArray(head)) {
    throw new InvalidSourceReferenceError("pullRequest.head must be an object");
  }
  const headRecord = head as Record<string, unknown>;
  const headSha = assertNonEmptyString(headRecord.sha, "pullRequest.head.sha");

  return {
    action,
    repository: { owner, name },
    pullRequest: {
      number,
      base: { sha: baseSha },
      head: { sha: headSha },
    },
  };
}

export function decideGitHubPullRequestEvent(
  event: GitHubPullRequestEvent,
): GitHubPullRequestDecision {
  const validated = validateEventShape(event);

  if (!isSupportedGitHubPullRequestAction(validated.action)) {
    return {
      kind: "ignore",
      reason: `unsupported action: ${validated.action}`,
    };
  }

  const source: GitHubSnapshotReference = {
    kind: "github-snapshot",
    owner: validated.repository.owner,
    repository: validated.repository.name,
    sha: validated.pullRequest.head.sha,
  };

  validateGitHubSnapshotReference(source);

  const headSha = source.sha.toLowerCase();
  const baseSha = validated.pullRequest.base.sha.toLowerCase();

  // Validate base SHA as well for future change-set fidelity, but do not use it as source identity.
  // We reuse the same SHA validator (40-char hex) for base to ensure immutable reference.
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
    throw new InvalidSourceReferenceError(
      `invalid base sha: ${validated.pullRequest.base.sha}`,
    );
  }

  return {
    kind: "verify",
    source: {
      kind: "github-snapshot",
      owner: validated.repository.owner,
      repository: validated.repository.name,
      sha: headSha,
    },
    pullRequestNumber: validated.pullRequest.number,
    baseSha,
    headSha,
  };
}
