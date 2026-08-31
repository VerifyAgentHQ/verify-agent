import type {
  VerificationRequest,
  VerificationResult,
} from "@verify-agent/domain";
import type { VerificationOrchestrator } from "./interfaces.js";

export function createEngine(): VerificationOrchestrator {
  return {
    async run(_request: VerificationRequest): Promise<VerificationResult> {
      throw new Error(
        "Verification orchestration is not implemented in Phase 1 Batch 1",
      );
    },
  };
}
