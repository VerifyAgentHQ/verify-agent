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
        readonly selection?: VerificationQueueJob["selection"];
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
      // Batch 53 — translate the queue job's provider-neutral selection
      // intent into the application-service contract. Legacy jobs without
      // `selection` keep the exact historical `{ source }` call shape.
      return job.selection === undefined
        ? applicationService.verifySource({ source: job.source })
        : applicationService.verifySource({
            source: job.source,
            selection: job.selection,
          });
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
  FileVerificationResultRegistryOptions,
  VerificationResultRegistry,
} from "./result-registry.js";
export {
  DEFAULT_MAX_VERIFICATION_RESULTS,
  createInMemoryVerificationResultRegistry,
  createFileVerificationResultRegistry,
} from "./result-registry.js";
export {
  createInMemoryVerificationJobQueue,
  type InMemoryVerificationJobQueue,
} from "./in-memory-job-queue.js";

export const workerBoundary = {
  status: "implemented-batch51",
  purpose:
    "Provider-neutral VerificationQueueJob → VerificationApplicationService boundary. No webhook, GitHub, queue infrastructure, durability, or retries. Consumption is explicit by default with opt-in automatic in-process consumption owned by the application.",
};
