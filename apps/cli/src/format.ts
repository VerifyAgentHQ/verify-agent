interface CliCheckResult {
  readonly checkId: string;
  readonly status: string;
  readonly executionSource: string;
  readonly summary: string;
}

interface CliFinding {
  readonly severity: string;
  readonly title: string;
  readonly description: string;
}

interface CliPolicyDecision {
  readonly outcome: string;
  readonly triggeredRuleIds: readonly string[];
}

interface CliCoverage {
  readonly verified: readonly string[];
  readonly partial: readonly string[];
  readonly unsupported: readonly string[];
  readonly notApplicable: readonly string[];
}

interface CliProfile {
  readonly languages: readonly string[];
  readonly frameworks: readonly string[];
  readonly supportedCapabilities: readonly string[];
}

export interface CliResult {
  readonly status: string;
  readonly coverage: CliCoverage;
  readonly checkResults: readonly CliCheckResult[];
  readonly findings: readonly CliFinding[];
  readonly policyDecision: CliPolicyDecision;
  readonly profile: CliProfile;
  readonly execution: {
    readonly source: string;
    readonly sandboxed: boolean;
  };
}

function statusLabel(status: string): string {
  switch (status) {
    case "passed":
      return "PASS";
    case "failed":
      return "FAIL";
    case "error":
      return "ERROR";
    case "timed_out":
      return "TIMEOUT";
    case "cancelled":
      return "CANCELLED";
    case "skipped":
      return "SKIP";
    default:
      return status.toUpperCase();
  }
}

function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "allow":
      return "ALLOW";
    case "block":
      return "BLOCK";
    case "needs_review":
      return "NEEDS REVIEW";
    case "needs_changes":
      return "NEEDS CHANGES";
    default:
      return outcome.toUpperCase();
  }
}

function verificationStatusLabel(status: string): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "blocked":
      return "BLOCKED";
    case "needs_review":
      return "NEEDS REVIEW";
    case "needs_changes":
      return "NEEDS CHANGES";
    case "partial":
      return "PARTIAL";
    case "error":
      return "ERROR";
    default:
      return status.toUpperCase();
  }
}

export function formatResult(targetPath: string, result: CliResult): string {
  const lines: string[] = [];

  lines.push("VerifyAgent");
  lines.push(`Repository: ${targetPath}`);
  lines.push("");

  lines.push("Project:");
  if (result.profile.languages.length > 0) {
    lines.push(`  Languages: ${result.profile.languages.join(", ")}`);
  }
  if (result.profile.frameworks.length > 0) {
    lines.push(`  Frameworks: ${result.profile.frameworks.join(", ")}`);
  }
  if (result.profile.supportedCapabilities.length > 0) {
    lines.push(
      `  Capabilities: ${result.profile.supportedCapabilities.join(", ")}`,
    );
  }
  lines.push(`  Execution: ${result.execution.source}`);
  if (!result.execution.sandboxed) {
    lines.push(
      "  Warning: repository tooling will execute with host privileges.",
    );
  }
  lines.push("");

  lines.push("Checks:");
  for (const cr of result.checkResults) {
    const label = statusLabel(cr.status);
    lines.push(`  ${cr.checkId}  ${label}`);
  }
  lines.push("");

  if (result.findings.length > 0) {
    lines.push("Findings:");
    for (const f of result.findings) {
      lines.push(`  [${f.severity.toUpperCase()}] ${f.title}`);
      if (f.description) {
        lines.push(`    ${f.description}`);
      }
    }
    lines.push("");
  }

  lines.push("Policy:");
  lines.push(`  ${outcomeLabel(result.policyDecision.outcome)}`);
  if (result.policyDecision.triggeredRuleIds.length > 0) {
    lines.push(`  Rules: ${result.policyDecision.triggeredRuleIds.join(", ")}`);
  }
  lines.push("");

  lines.push("Verification:");
  lines.push(`  ${verificationStatusLabel(result.status)}`);

  const passed = result.checkResults.filter(
    (cr) => cr.status === "passed",
  ).length;
  const total = result.checkResults.length;
  lines.push(`  Checks: ${passed}/${total} passed`);

  if (result.coverage.verified.length > 0) {
    lines.push(`  Verified: ${result.coverage.verified.join(", ")}`);
  }
  if (result.coverage.partial.length > 0) {
    lines.push(`  Partial: ${result.coverage.partial.join(", ")}`);
  }
  if (result.coverage.unsupported.length > 0) {
    lines.push(`  Unsupported: ${result.coverage.unsupported.join(", ")}`);
  }

  return lines.join("\n");
}

export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
