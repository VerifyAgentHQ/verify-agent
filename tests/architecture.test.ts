import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  CheckExecutionStatus,
  CheckStatus,
  VerificationStatus,
} from "../packages/domain/src/index.js";
import { publicContract } from "../packages/domain/src/index.js";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const contractsRoot = join(repoRoot, "..", "verify-contracts");

describe("architecture boundaries", () => {
  it("tracks authoritative sibling contract metadata without copying schemas", () => {
    const schema = JSON.parse(
      readFileSync(
        join(contractsRoot, "schemas", "common", "common.schema.json"),
        "utf8",
      ),
    ) as {
      $id: string;
      $defs: { SourceReference: object; SourceState: object };
    };

    expect(schema.$id).toBe(
      "https://contracts.verifyagent.dev/schemas/common/common.schema.json",
    );
    expect(schema.$defs.SourceReference).toBeDefined();
    expect(schema.$defs.SourceState).toBeDefined();
    expect(publicContract.schemaVersion).toBe("1.0.0");
  });

  it("keeps core package manifests free of provider/runtime dependencies", () => {
    const corePackages = ["domain", "engine", "checks", "policy", "ai"];
    const forbidden =
      /github|docker|openai|anthropic|gemini|goat|redis|database/i;

    for (const name of corePackages) {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(Object.keys(manifest.dependencies ?? {})).not.toContainEqual(
        expect.stringMatching(forbidden),
      );
      expect(Object.keys(manifest.devDependencies ?? {})).not.toContainEqual(
        expect.stringMatching(forbidden),
      );
    }
  });

  it("keeps execution, result, and verification status types distinct", () => {
    const executionStatus: CheckExecutionStatus = "queued";
    const resultStatus: CheckStatus = "timed_out";
    const verificationStatus: VerificationStatus = "needs_review";
    expect([executionStatus, resultStatus, verificationStatus]).toEqual([
      "queued",
      "timed_out",
      "needs_review",
    ]);
  });

  it("does not use a fabricated zero hash in the engine placeholder", () => {
    const runtime = readFileSync(
      join(repoRoot, "packages", "engine", "src", "runtime.ts"),
      "utf8",
    );
    expect(runtime).not.toContain("repeat(64)");
    expect(runtime).toContain("not implemented");
  });

  it("keeps the verification job and queue contracts provider-neutral", () => {
    const queueContract = readFileSync(
      join(repoRoot, "packages", "domain", "src", "verification-queue.ts"),
      "utf8",
    );
    for (const forbidden of [
      "adapters-source",
      "github-pr",
      "github-app",
      "webhook",
      "x-hub-signature",
      "BullMQ",
      "bullmq",
      "redis",
      "sqs",
      "rabbitmq",
    ]) {
      expect(queueContract).not.toContain(forbidden);
    }
    expect(queueContract).toContain("VerificationQueueJob");
    expect(queueContract).toContain("VerificationJobQueue");

    const memoryQueue = readFileSync(
      join(repoRoot, "packages", "engine", "src", "in-memory-job-queue.ts"),
      "utf8",
    );
    for (const forbidden of [
      "adapters-source",
      "github",
      "webhook",
      "redis",
      "bullmq",
      "BullMQ",
      "sqs",
      "rabbitmq",
      "docker",
    ]) {
      expect(memoryQueue.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(memoryQueue).toContain("createInMemoryVerificationJobQueue");
  });

  it("keeps queue infrastructure out of core manifests", () => {
    const forbidden = /bullmq|redis|sqs|rabbitmq|amqp|kafka/i;
    for (const name of ["domain", "engine"]) {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(Object.keys(manifest.dependencies ?? {})).not.toContainEqual(
        expect.stringMatching(forbidden),
      );
      expect(Object.keys(manifest.devDependencies ?? {})).not.toContainEqual(
        expect.stringMatching(forbidden),
      );
    }
  });

  it("keeps the worker free of webhook and GitHub internals", () => {
    const worker = readFileSync(
      join(repoRoot, "apps", "worker", "src", "index.ts"),
      "utf8",
    );
    for (const forbidden of [
      "webhook.js",
      "webhook.ts",
      "x-hub-signature",
      "x-github",
      "verifyGitHubWebhookSignature",
      "readGitHubWebhookSecret",
      "github-pr",
      "github-app",
      "adapters-source",
      "HMAC",
      "GITHUB_WEBHOOK_SECRET",
    ]) {
      expect(worker).not.toContain(forbidden);
    }
    expect(worker).toContain("verifySource");
    expect(worker).toContain("VerificationQueueJob");
  });

  it("keeps synchronous verification out of the GitHub webhook path", () => {
    const orchestrator = readFileSync(
      join(
        repoRoot,
        "apps",
        "github-bot",
        "src",
        "verification-orchestrator.ts",
      ),
      "utf8",
    );
    expect(orchestrator).toContain("VerificationJobQueue");
    expect(orchestrator).toContain("decideGitHubPullRequestEvent");
    expect(orchestrator).not.toContain("verifySource");
    expect(orchestrator).not.toContain("VerificationApplicationService");
    expect(orchestrator).not.toContain("SourceResolver");
  });
});
