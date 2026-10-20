import { fileURLToPath } from "node:url";
import {
  startConfiguredGitHubVerificationService,
  type ConfiguredGitHubVerificationServiceOptions,
} from "./github-verification-service.js";

/**
 * Canonical production bootstrap for the VerifyAgent API.
 *
 * This entrypoint selects the full GitHub verification service composition:
 * - /webhook (authenticated GitHub production trust boundary)
 * - /health
 * - protected asynchronous result observation when explicitly composed
 * - queue
 * - automatic runtime processing
 * - application service and durable SQLite result registry
 * - protected result reader
 * - GitHub App source acquisition
 * - authoritative GitHub check-run consumption
 * - deterministic PR requirement evaluation
 * - one create-or-update GitHub PR comment
 *
 * The older sandbox-backed execution pipeline remains frozen infrastructure
 * outside this active composition and is not authoritative for the MVP.
 * - startup/shutdown lifecycle
 */
export async function startConfiguredProductionService(
  options: ConfiguredGitHubVerificationServiceOptions = {},
) {
  return startConfiguredGitHubVerificationService(options);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startConfiguredProductionService().catch((error: unknown) => {
    console.error(
      `GitHub Verification Service failed to start: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
