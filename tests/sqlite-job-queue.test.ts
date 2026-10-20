import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createVerificationQueueJob } from "../packages/domain/src/index.js";
import { createSqliteVerificationJobQueue } from "../apps/worker/src/sqlite-job-queue.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function job(id: string) {
  return createVerificationQueueJob({
    jobId: id,
    source: { kind: "snapshot", id: `snap-${id}` },
    trigger: { kind: "pull-request", action: "opened", pullRequestNumber: 11 },
    deliveryId: `delivery-${id}`,
    createdAt: "2026-10-20T12:00:00.000Z",
  });
}

describe("SQLite verification job queue", () => {
  it("restores pending jobs after a process restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "verifyagent-queue-"));
    roots.push(root);
    const filePath = join(root, "results.sqlite");
    const first = createSqliteVerificationJobQueue({ filePath });
    await first.enqueue(job("job-restart"));
    first.close?.();

    const restarted = createSqliteVerificationJobQueue({ filePath });
    const restored = await restarted.dequeue();
    expect(restored?.jobId).toBe("job-restart");
    await restarted.acknowledge?.("job-restart");
    expect(restarted.size()).toBe(0);
    restarted.close?.();
  });

  it("requeues failed work and removes acknowledged work", async () => {
    const root = mkdtempSync(join(tmpdir(), "verifyagent-queue-"));
    roots.push(root);
    const queue = createSqliteVerificationJobQueue({
      filePath: join(root, "results.sqlite"),
    });
    await queue.enqueue(job("job-failure"));
    const claimed = await queue.dequeue();
    expect(claimed?.jobId).toBe("job-failure");
    await queue.reject?.("job-failure");
    expect((await queue.dequeue())?.jobId).toBe("job-failure");
    await queue.acknowledge?.("job-failure");
    expect(queue.size()).toBe(0);
    queue.close?.();
  });
});
