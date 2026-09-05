import type { VerificationResult } from "../../../packages/domain/src/verification.js";
import type { VerificationQueueJob } from "../../../packages/domain/src/verification-queue.js";
import { validateVerificationQueueJob } from "../../../packages/domain/src/verification-queue.js";
import type { VerificationApplicationService } from "../../../packages/engine/src/application-service.js";

export interface VerificationJobProcessor {
  process(job: VerificationQueueJob): Promise<VerificationResult>;
}

export function createVerificationJobProcessor(
  applicationService: Pick<VerificationApplicationService, "verifySource">,
): VerificationJobProcessor {
  if (
    !applicationService ||
    typeof applicationService.verifySource !== "function"
  ) {
    throw new Error("VerificationApplicationService is required");
  }
  return {
    async process(job: VerificationQueueJob): Promise<VerificationResult> {
      validateVerificationQueueJob(job);
      return applicationService.verifySource({ source: job.source });
    },
  };
}

export const workerBoundary = {
  status: "implemented-batch38",
  purpose:
    "Provider-neutral VerificationQueueJob → VerificationApplicationService boundary. No webhook, GitHub, queue infrastructure, or background loop.",
};
