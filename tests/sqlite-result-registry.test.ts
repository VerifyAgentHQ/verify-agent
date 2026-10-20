import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  brandId,
  type VerificationResult,
} from "../packages/domain/src/index.js";
import { createSqliteVerificationResultRegistry } from "../apps/worker/src/sqlite-result-registry.js";

function result(id: string, jobId: string): VerificationResult {
  return {
    id: brandId<"VerificationId">(id),
    requestId: brandId<"VerificationRequestId">(`request-${id}`),
    jobId: brandId<"VerificationJobId">(jobId),
    projectId: brandId<"ProjectId">(`project-${id}`),
    snapshotId: brandId<"RepositorySnapshotId">(`snapshot-${id}`),
    changeSetId: brandId<"ChangeSetId">(`changes-${id}`),
    status: "pass",
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
    policyDecision: brandId<"PolicyDecisionId">(`policy-${id}`),
    summary: "MVP verdict: PASS",
    resultVersion: "1.0.0",
    contentHash: "a".repeat(64),
    createdAt: "2026-10-20T00:00:00.000Z",
  };
}

describe("SQLite verification result registry", () => {
  it("restores results and indexes after a process restart", () => {
    const root = mkdtempSync(join(tmpdir(), "verifyagent-sqlite-"));
    const path = join(root, "results.sqlite");
    try {
      const first = createSqliteVerificationResultRegistry({ filePath: path });
      const stored = first.store("queue-1", result("verification-1", "job-1"));
      expect(Object.isFrozen(stored)).toBe(true);

      const restarted = createSqliteVerificationResultRegistry({
        filePath: path,
      });
      expect(restarted.getByQueueJobId("queue-1")?.id).toBe("verification-1");
      expect(restarted.getByVerificationId("verification-1")?.jobId).toBe(
        "job-1",
      );
      expect(restarted.getByJobId("job-1")?.policyDecision).toBe(
        "policy-verification-1",
      );
      expect(restarted.size()).toBe(1);
      first.close?.();
      restarted.close?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps retention bounded and rejects identity conflicts", () => {
    const root = mkdtempSync(join(tmpdir(), "verifyagent-sqlite-"));
    const path = join(root, "results.sqlite");
    try {
      const registry = createSqliteVerificationResultRegistry({
        filePath: path,
        maxResults: 1,
      });
      registry.store("queue-1", result("verification-1", "job-1"));
      registry.store("queue-2", result("verification-2", "job-2"));
      expect(registry.size()).toBe(1);
      expect(registry.getByQueueJobId("queue-1")).toBeUndefined();
      expect(() =>
        registry.store("queue-2", result("verification-3", "job-3")),
      ).toThrow(/queue jobId/);
      registry.close?.();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
