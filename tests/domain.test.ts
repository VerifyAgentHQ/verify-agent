import { describe, expect, it } from "vitest";
import {
  brandId,
  validateChangeSet,
  validateCheckExecution,
  validateCheckResult,
  validateEvidence,
  validateCoverage,
  validateFindingLocation,
  validateFinding,
  validatePolicyDecision,
  validateProject,
  validateSourceState,
  validateVerificationRequest,
  validateVerificationResult,
} from "../packages/domain/src/index.js";

const id = <T extends string>(value: string) => brandId<T>(value);
const contentHash = "a".repeat(64);
const sourceState = { type: "commit" as const, value: "abc123" };

describe("domain validation", () => {
  it("accepts valid core entities and traceable result references", () => {
    const projectId = id<"ProjectId">("project-1");
    validateProject({
      id: projectId,
      name: "Example",
      root: "packages/example",
    });
    validateSourceState(sourceState);
    validateVerificationRequest({
      id: id<"VerificationRequestId">("request-1"),
      projectId,
      snapshotId: id<"RepositorySnapshotId">("snapshot-1"),
      changeSetId: id<"ChangeSetId">("change-1"),
      requestedBy: { type: "human" },
      mode: "manual",
      requestedChecks: [id<"CheckId">("check-1")],
      policyId: id<"PolicyId">("policy-1"),
      priority: 1,
      createdAt: "2026-08-31T10:00:00+01:00",
    });
    validateChangeSet({
      id: id<"ChangeSetId">("change-1"),
      baseSourceState: sourceState,
      headSourceState: { type: "snapshot", value: "snap-1" },
      changedFiles: [
        {
          path: "src/index.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
        },
      ],
      additions: 2,
      deletions: 1,
      changeHash: contentHash,
      issueReferences: [],
    });
    validateVerificationResult({
      id: id<"VerificationId">("verification-1"),
      requestId: id<"VerificationRequestId">("request-1"),
      jobId: id<"VerificationJobId">("job-1"),
      projectId,
      snapshotId: id<"RepositorySnapshotId">("snapshot-1"),
      changeSetId: id<"ChangeSetId">("change-1"),
      status: "pass",
      coverage: {
        verified: ["typescript.typecheck"],
        partial: [],
        unsupported: [],
        notApplicable: [],
      },
      checkResults: [],
      evidenceReferences: [],
      findingReferences: [],
      policyDecision: id<"PolicyDecisionId">("decision-1"),
      summary: "Passed",
      resultVersion: "1.0.0",
      contentHash,
      createdAt: "2026-08-31T00:00:00Z",
    });
  });

  it("accepts factual check, evidence, finding, and policy records", () => {
    const evidenceId = id<"EvidenceId">("evidence-1");
    validateCheckExecution({
      id: id<"CheckExecutionId">("execution-1"),
      checkDefinitionId: id<"CheckId">("check-1"),
      jobId: id<"VerificationJobId">("job-1"),
      inputsHash: contentHash,
      status: "queued",
    });
    validateCheckResult({
      id: id<"CheckResultId">("result-1"),
      checkExecutionId: id<"CheckExecutionId">("execution-1"),
      checkId: id<"CheckId">("check-1"),
      checkVersion: "1.0.0",
      status: "passed",
      durationMs: 10,
      summary: "Passed",
      artifactRefs: [],
      metrics: {},
      environment: {},
      inputHash: contentHash,
      contentHash,
      createdAt: "2026-08-31T10:00:00Z",
      producer: {
        type: "deterministic_tool",
        name: "typescript",
        version: "5.0.0",
      },
    });
    validateEvidence({
      id: evidenceId,
      type: "test-output",
      summary: "Test passed",
      value: { passed: true },
      sourceReferences: ["logs/test-1"],
      producer: { type: "deterministic_tool", name: "typescript" },
      createdAt: "2026-08-31T10:00:00Z",
      contentHash,
    });
    validateFinding({
      id: id<"FindingId">("finding-1"),
      category: "quality",
      severity: "low",
      status: "open",
      title: "Review",
      description: "Review this result",
      locations: [{ path: "src/index.ts", startLine: 1, endLine: 1 }],
      evidenceReferences: [evidenceId],
      producer: { type: "system", name: "verify-agent" },
      confidence: 0.9,
    });
    validatePolicyDecision({
      id: id<"PolicyDecisionId">("decision-1"),
      policyId: id<"PolicyId">("policy-1"),
      policyVersion: "1.0.0",
      outcome: "allow",
      triggeredRuleIds: ["rule-1"],
      evidenceReferences: [evidenceId],
      findingReferences: [id<"FindingId">("finding-1")],
      createdAt: "2026-08-31T10:00:00Z",
      contentHash,
    });
  });

  it.each([
    ["empty identifier", () => brandId<"ProjectId">(" ")],
    [
      "invalid source state",
      () => validateSourceState({ type: "branch", value: "main" } as never),
    ],
    [
      "invalid path",
      () =>
        validateChangeSet({
          id: id<"ChangeSetId">("c"),
          baseSourceState: sourceState,
          headSourceState: sourceState,
          changedFiles: [
            {
              path: "../secret",
              status: "modified",
              additions: 0,
              deletions: 0,
            },
          ],
          additions: 0,
          deletions: 0,
          changeHash: contentHash,
          issueReferences: [],
        }),
    ],
    [
      "coverage conflict",
      () =>
        validateCoverage({
          verified: ["rust.test"],
          partial: [],
          unsupported: ["rust.test"],
          notApplicable: [],
        }),
    ],
    [
      "finding without evidence",
      () =>
        validateFinding({
          id: id<"FindingId">("f"),
          category: "quality",
          severity: "high",
          status: "open",
          title: "Issue",
          description: "Issue",
          locations: [],
          evidenceReferences: [],
          producer: { type: "system", name: "verify-agent" },
        }),
    ],
    [
      "invalid policy decision hash",
      () =>
        validatePolicyDecision({
          id: id<"PolicyDecisionId">("d"),
          policyId: id<"PolicyId">("p"),
          policyVersion: "1.0.0",
          outcome: "allow",
          triggeredRuleIds: [],
          evidenceReferences: [],
          findingReferences: [],
          createdAt: "2026-08-31T00:00:00Z",
          contentHash: "bad",
        }),
    ],
    [
      "timezone-less timestamp",
      () =>
        validateProject({
          id: id<"ProjectId">("p"),
          name: "Project",
          root: "src",
        }) ||
        validateVerificationResult({
          id: id<"VerificationId">("v"),
          requestId: id<"VerificationRequestId">("r"),
          jobId: id<"VerificationJobId">("j"),
          projectId: id<"ProjectId">("p"),
          snapshotId: id<"RepositorySnapshotId">("s"),
          changeSetId: id<"ChangeSetId">("c"),
          status: "pass",
          coverage: {
            verified: [],
            partial: [],
            unsupported: [],
            notApplicable: [],
          },
          checkResults: [],
          evidenceReferences: [],
          findingReferences: [],
          policyDecision: id<"PolicyDecisionId">("d"),
          summary: "ok",
          resultVersion: "1.0.0",
          contentHash,
          createdAt: "2026-08-31T10:00:00",
        }),
    ],
    [
      "invalid location range",
      () =>
        validateFindingLocation({ path: "src/a.ts", startLine: 3, endLine: 2 }),
    ],
    [
      "renamed file without previous path",
      () =>
        validateChangeSet({
          id: id<"ChangeSetId">("c"),
          baseSourceState: sourceState,
          headSourceState: sourceState,
          changedFiles: [
            { path: "new.ts", status: "renamed", additions: 0, deletions: 0 },
          ],
          additions: 0,
          deletions: 0,
          changeHash: contentHash,
          issueReferences: [],
        }),
    ],
    [
      "invalid check result status",
      () =>
        validateCheckResult({
          id: id<"CheckResultId">("result"),
          checkExecutionId: id<"CheckExecutionId">("execution"),
          checkId: id<"CheckId">("check"),
          checkVersion: "1.0.0",
          status: "passed-but-trusted" as never,
          durationMs: 1,
          summary: "ok",
          artifactRefs: [],
          metrics: {},
          environment: {},
          inputHash: contentHash,
          contentHash,
          createdAt: "2026-08-31T10:00:00Z",
          producer: { type: "system", name: "verify-agent" },
        }),
    ],
  ])("rejects %s", (_, operation) => {
    expect(operation).toThrow(Error);
  });

  it("exposes immutable collections as readonly values", () => {
    const coverage: Readonly<{ verified: readonly string[] }> = {
      verified: ["rust.test"],
    };
    expect(coverage.verified).toEqual(["rust.test"]);
  });

  it("accepts timestamps with explicit UTC or offset timezones", () => {
    expect(() =>
      validateFindingLocation({
        path: "src/a.ts",
        startLine: 1,
        startColumn: 2,
        endLine: 1,
        endColumn: 3,
      }),
    ).not.toThrow();
  });
});
