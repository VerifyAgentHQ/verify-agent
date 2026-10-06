import { createHash, randomUUID } from "node:crypto";
import type {
  SnapshotSourceReference,
  VerificationQueueJob,
  VerificationResult,
} from "@verify-agent/domain";
import { brandId } from "@verify-agent/domain";

export interface MvpVerificationApplicationService {
  verifySource(input: {
    readonly source: SnapshotSourceReference;
    readonly selection?: VerificationQueueJob["selection"];
  }): Promise<VerificationResult>;
}

/**
 * MVP application boundary. GitHub is authoritative for source metadata,
 * changed files, requirements, and CI checks; the PR comment publisher reads
 * that evidence. This result is the durable correlation envelope and never
 * invokes the frozen sandbox execution engine.
 */
export function createMvpVerificationApplicationService(): MvpVerificationApplicationService {
  return {
    async verifySource({ source }): Promise<VerificationResult> {
      const now = new Date().toISOString();
      const jobId = randomUUID();
      const suffix = source.id.replace(/[^A-Za-z0-9._:-]/g, "-");
      const contentHash = createHash("sha256")
        .update(`${source.id}\n${jobId}\n${now}`)
        .digest("hex");

      return {
        id: brandId<"VerificationId">(`mvp-${jobId}`),
        requestId: brandId<"VerificationRequestId">(`mvp-request-${jobId}`),
        jobId: brandId<"VerificationJobId">(jobId),
        projectId: brandId<"ProjectId">(`github-${suffix}`),
        snapshotId: brandId<"RepositorySnapshotId">(`snapshot-${suffix}`),
        changeSetId: brandId<"ChangeSetId">(`changes-${suffix}`),
        status: "needs_review",
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
        policyDecision: brandId<"PolicyDecisionId">(
          `mvp-policy-${contentHash.slice(0, 16)}`,
        ),
        summary:
          "Awaiting authoritative GitHub CI and PR requirement evaluation.",
        resultVersion: "1.0.0",
        contentHash,
        createdAt: now,
      };
    },
  };
}
