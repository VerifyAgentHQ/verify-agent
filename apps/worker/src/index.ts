import type {
  SnapshotSourceReference,
  VerificationResult,
  VerificationQueueJob,
} from "@verify-agent/domain";
import { validateVerificationQueueJob } from "@verify-agent/domain";

export interface VerificationJobProcessor {
  process(job: VerificationQueueJob): Promise<VerificationResult>;
}

export function createVerificationJobProcessor(
  applicationService: Pick<
    {
      verifySource(input: {
        readonly source: SnapshotSourceReference;
      }): Promise<VerificationResult>;
    },
    "verifySource"
  >,
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

export type {
  ConsumableVerificationJobQueue,
  VerificationJobRuntime,
  VerificationJobRuntimeOptions,
  VerificationJobRuntimeOutcome,
  VerificationJobSettledOutcome,
} from "./runtime.js";
export {
  VerificationJobRuntimeError,
  createVerificationJobRuntime,
} from "./runtime.js";
export type {
  InMemoryVerificationResultRegistryOptions,
  VerificationResultRegistry,
} from "./result-registry.js";
export {
  DEFAULT_MAX_VERIFICATION_RESULTS,
  createInMemoryVerificationResultRegistry,
} from "./result-registry.js";

export const workerBoundary = {
  status: "implemented-batch51",
  purpose:
    "Provider-neutral VerificationQueueJob → VerificationApplicationService boundary. No webhook, GitHub, queue infrastructure, durability, or retries. Consumption is explicit by default with opt-in automatic in-process consumption owned by the application.",
};
