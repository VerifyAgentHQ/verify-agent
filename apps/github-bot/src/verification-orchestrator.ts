import { randomUUID } from "node:crypto";
import { decideGitHubPullRequestEvent } from "../../../packages/adapters-source/src/github-pr.js";
import type { GitHubPullRequestEvent } from "../../../packages/adapters-source/src/github-pr.js";
import type {
  VerificationJobQueue,
  VerificationQueueJob,
} from "../../../packages/domain/src/verification-queue.js";
import { createVerificationQueueJob } from "../../../packages/domain/src/verification-queue.js";

export type GitHubVerificationOrchestrationResult =
  | { readonly kind: "ignored"; readonly reason: string }
  | { readonly kind: "enqueued"; readonly job: VerificationQueueJob };

export interface GitHubVerificationOrchestrator {
  handle(
    event: GitHubPullRequestEvent,
    context: { readonly deliveryId: string },
  ): Promise<GitHubVerificationOrchestrationResult>;
}

export function createGitHubVerificationOrchestrator(
  queue: VerificationJobQueue,
  options?: {
    readonly createJobId?: () => string;
    readonly now?: () => string;
  },
): GitHubVerificationOrchestrator {
  if (!queue || typeof (queue as VerificationJobQueue).enqueue !== "function") {
    throw new Error("VerificationJobQueue is required");
  }

  return {
    async handle(
      event: GitHubPullRequestEvent,
      context: { readonly deliveryId: string },
    ): Promise<GitHubVerificationOrchestrationResult> {
      const decision = decideGitHubPullRequestEvent(event);
      if (decision.kind === "ignore") {
        return { kind: "ignored", reason: decision.reason };
      }

      const deliveryId =
        typeof context?.deliveryId === "string"
          ? context.deliveryId.trim()
          : "";
      if (deliveryId.length === 0) {
        throw new Error("deliveryId is required to enqueue verification job");
      }

      const createJobId = options?.createJobId ?? randomUUID;
      const now = options?.now ?? (() => new Date().toISOString());
      const jobId = createJobId();
      if (typeof jobId !== "string" || jobId.trim().length === 0) {
        throw new Error("jobId must be a non-empty string");
      }
      const createdAt = now();
      if (typeof createdAt !== "string" || createdAt.trim().length === 0) {
        throw new Error("createdAt must be a non-empty string");
      }

      const job = createVerificationQueueJob({
        jobId,
        source: {
          kind: "snapshot",
          id: `${decision.source.owner}:${decision.source.repository}:${decision.source.sha}`,
        },
        trigger: {
          kind: "pull-request",
          action: event.action,
          pullRequestNumber: decision.pullRequestNumber,
        },
        deliveryId,
        createdAt,
      });

      await queue.enqueue(job);
      return { kind: "enqueued", job };
    },
  };
}
