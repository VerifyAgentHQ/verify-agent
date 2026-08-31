import type {
  VerificationRequest,
  VerificationResult,
} from "@verify-agent/domain";
import type { VerificationOrchestrator } from "./interfaces.js";

export function createEngine(): VerificationOrchestrator {
  return {
    async run(request: VerificationRequest): Promise<VerificationResult> {
      return {
        id: `verification-${request.id}`,
        requestId: request.id,
        jobId: `job-${request.id}`,
        status: "needs-review",
        createdAt: new Date().toISOString(),
        producedAt: new Date().toISOString(),
        findings: [],
        evidence: [],
        summary:
          "Phase 0 orchestration boundary is initialized; full verification logic is intentionally deferred.",
      };
    },
  };
}
