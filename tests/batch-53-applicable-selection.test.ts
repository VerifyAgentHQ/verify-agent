/**
 * Batch 53 — deterministic applicable-check selection for GitHub verification.
 *
 * Removes the Batch 52 limitation where a GitHub-triggered verification
 * silently reduced the plan to `typescript.typecheck` when no explicit
 * `selectedCheckIds` were supplied:
 *
 * ```text
 * GitHub webhook
 *     ↓
 * VerificationQueueJob { selection: "all-applicable" }
 *     ↓
 * application-owned runtime
 *     ↓
 * VerificationApplicationService.verifySource({ source, selection })
 *     ↓
 * project detection → deterministic check planning
 *     ↓
 * select applicable executable checks (planner order, dependencies intact)
 *     ↓
 * execute in planner order → aggregate → policy → VerificationResult
 * ```
 *
 * The GitHub layer carries only provider-neutral intent
 * (`"default"` | `"all-applicable"`); project applicability stays
 * authoritative in detection → planner. No check list lives in the webhook,
 * orchestrator, API, or worker.
 */

import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createGitHubVerificationService } from "../apps/api/src/github-verification-service.js";
import { createGitHubVerificationOrchestrator } from "../apps/github-bot/src/verification-orchestrator.js";
import { createVerificationJobProcessor } from "../apps/worker/src/index.js";
import {
  createFileSystemDetectionContext,
  createMemoryDetectionContext,
  createProjectDetectionService,
} from "../packages/adapters-lang/src/index.js";
import {
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
} from "../packages/adapters-source/src/github.js";
import {
  brandId,
  createVerificationQueueJob,
  validateVerificationQueueJob,
  type CheckId,
  type CheckPlan,
  type ChangeSet,
  type Project,
  type RepositorySnapshot,
  type VerificationQueueJob,
} from "../packages/domain/src/index.js";
import {
  createCheckPlanner,
  createTrustedExecutionSpecRegistry,
  resolveCheckSelection,
  selectApplicableExecutableChecks,
} from "../packages/checks/src/index.js";
import {
  FakeSandboxTransport,
  VerificationApplicationService,
  createCheckExecutor,
  createInMemoryVerificationJobQueue,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
  type PublicSandboxJobResult,
  type VerificationPipelineInput,
} from "../packages/engine/src/index.js";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const orchestratorSource = readFileSync(
  join(
    repoRoot,
    "..",
    "apps",
    "github-bot",
    "src",
    "verification-orchestrator.ts",
  ),
  "utf8",
);
const workerSource = readFileSync(
  join(repoRoot, "..", "apps", "worker", "src", "index.ts"),
  "utf8",
);

const project: Project = {
  id: brandId<"ProjectId">("batch53-project"),
  name: "batch53-fixture",
  root: ".",
};
const snapshot: RepositorySnapshot = {
  id: brandId<"RepositorySnapshotId">("batch53-snapshot"),
  projectId: project.id,
  source: { provider: "fixture", reference: "batch53-fixture" },
  sourceState: { type: "snapshot", value: "batch53-snapshot" },
  retrievedAt: "2026-09-27T10:00:00Z",
};
const changeSet: ChangeSet = {
  id: brandId<"ChangeSetId">("batch53-change"),
  baseSourceState: { type: "snapshot", value: "base" },
  headSourceState: snapshot.sourceState,
  changedFiles: [],
  additions: 0,
  deletions: 0,
  changeHash: "a".repeat(64),
  issueReferences: [],
};

const sandboxResult: PublicSandboxJobResult = {
  schemaVersion: "1.0.0",
  jobId: "batch53-job",
  status: "completed",
  exitCode: 0,
  durationMs: 5,
  logsRef: "fixture://logs/batch53",
  artifactRefs: [],
  resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
  errors: [],
};

/** Full TypeScript signals: tsconfig + eslint + vitest + build script. */
const FULL_TYPESCRIPT_CONTENTS = Object.freeze({
  "package.json": JSON.stringify({
    name: "batch53-full-ts",
    scripts: { build: "tsc -b" },
    devDependencies: {
      typescript: "5.0.0",
      eslint: "9.0.0",
      vitest: "2.0.0",
    },
  }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/index.ts": "export const value = 42;\n",
});

const FULL_TYPESCRIPT_CHECK_IDS = [
  "typescript.typecheck",
  "typescript.lint",
  "typescript.test",
  "typescript.build",
] as const;

function basePipelineInput(
  contents: Readonly<Record<string, string>> = { ...FULL_TYPESCRIPT_CONTENTS },
): VerificationPipelineInput {
  return {
    project,
    snapshot,
    changeSet,
    detectionContext: createMemoryDetectionContext({ ...contents }),
    jobId: "batch53-job",
    executionId: "batch53-execution",
    resultId: "batch53-result",
    createdAt: "2026-09-27T10:01:00Z",
  };
}

function createPipeline() {
  const transport = new FakeSandboxTransport((request) => ({
    ...sandboxResult,
    jobId: request.jobId,
  }));
  const pipeline = createVerificationPipeline({
    detector: createProjectDetectionService(),
    executor: createCheckExecutor(
      createSandboxExecutorFromTransport(transport),
    ),
  });
  return { pipeline, transport };
}

function syntheticPlan(
  items: readonly {
    readonly checkId: string;
    readonly applicability: "applicable" | "not_applicable" | "unsupported";
  }[],
): Pick<CheckPlan, "items"> {
  return {
    items: items.map((item, priority) => ({
      checkId: brandId<"CheckId">(item.checkId),
      checkVersion: "1.0.0",
      applicability: item.applicability,
      required: true,
      reason: "batch53 synthetic selection test",
      priority,
      dependencies: [],
      scope: "repository" as const,
    })),
  };
}

function hasTrustedSpec(checkId: CheckId): boolean {
  return createTrustedExecutionSpecRegistry().find(checkId) !== undefined;
}

describe("Batch 53 — selection helper", () => {
  it("selects applicable executable checks in planner order", () => {
    const plan = syntheticPlan([
      { checkId: "typescript.typecheck", applicability: "applicable" },
      { checkId: "typescript.lint", applicability: "applicable" },
      // Applicable but no trusted executable spec: never selected.
      { checkId: "dependency.audit", applicability: "applicable" },
      { checkId: "typescript.test", applicability: "applicable" },
      { checkId: "rust.check", applicability: "not_applicable" },
      { checkId: "security.analysis", applicability: "unsupported" },
      { checkId: "typescript.build", applicability: "applicable" },
    ]);

    expect(selectApplicableExecutableChecks(plan, hasTrustedSpec)).toEqual([
      "typescript.typecheck",
      "typescript.lint",
      "typescript.test",
      "typescript.build",
    ]);
  });

  it("preserves dependency ordering from the planner", () => {
    // typescript.build depends on typescript.typecheck; soroban.contract-test
    // depends on rust.test. The planner emits dependencies first; selection
    // is a stable filter and cannot reorder them.
    const plan: Pick<CheckPlan, "items"> = {
      items: [
        {
          checkId: brandId<"CheckId">("typescript.typecheck"),
          checkVersion: "1.0.0",
          applicability: "applicable",
          required: true,
          reason: "batch53 dependency test",
          priority: 10,
          dependencies: [],
          scope: "repository" as const,
        },
        {
          checkId: brandId<"CheckId">("rust.test"),
          checkVersion: "1.0.0",
          applicability: "applicable",
          required: true,
          reason: "batch53 dependency test",
          priority: 30,
          dependencies: [],
          scope: "repository" as const,
        },
        {
          checkId: brandId<"CheckId">("typescript.build"),
          checkVersion: "1.0.0",
          applicability: "applicable",
          required: true,
          reason: "batch53 dependency test",
          priority: 40,
          dependencies: [brandId<"CheckId">("typescript.typecheck")],
          scope: "repository" as const,
        },
        {
          checkId: brandId<"CheckId">("soroban.contract-test"),
          checkVersion: "1.0.0",
          applicability: "applicable",
          required: true,
          reason: "batch53 dependency test",
          priority: 80,
          dependencies: [brandId<"CheckId">("rust.test")],
          scope: "repository" as const,
        },
      ],
    };
    const selected = selectApplicableExecutableChecks(plan, hasTrustedSpec);
    expect([...selected]).toEqual([
      "typescript.typecheck",
      "rust.test",
      "typescript.build",
      "soroban.contract-test",
    ]);
    const positions = new Map(selected.map((id, index) => [id, index]));
    expect(positions.get("typescript.typecheck")).toBeLessThan(
      positions.get("typescript.build") as number,
    );
    expect(positions.get("rust.test")).toBeLessThan(
      positions.get("soroban.contract-test") as number,
    );
  });

  it("selects nothing when no applicable check has an executable spec", () => {
    const plan = syntheticPlan([
      { checkId: "dependency.audit", applicability: "applicable" },
      { checkId: "security.analysis", applicability: "unsupported" },
      { checkId: "rust.check", applicability: "not_applicable" },
    ]);
    expect(selectApplicableExecutableChecks(plan, hasTrustedSpec)).toEqual([]);
  });

  it("resolveCheckSelection keeps explicit selection authoritative", () => {
    const plan = syntheticPlan([
      { checkId: "typescript.typecheck", applicability: "applicable" },
      { checkId: "typescript.test", applicability: "applicable" },
    ]);
    const explicit = [brandId<"CheckId">("typescript.typecheck")];
    // Explicit subset wins over all-applicable.
    expect(
      resolveCheckSelection({
        plan,
        selection: "all-applicable",
        selectedCheckIds: explicit,
        hasExecutableSpec: hasTrustedSpec,
      }),
    ).toBe(explicit);
    // Explicit singular wins over all-applicable.
    expect(
      resolveCheckSelection({
        plan,
        selection: "all-applicable",
        selectedCheckId: brandId<"CheckId">("typescript.test"),
        hasExecutableSpec: hasTrustedSpec,
      }),
    ).toEqual(["typescript.test"]);
    // all-applicable without explicit selection computes from the plan.
    expect(
      resolveCheckSelection({
        plan,
        selection: "all-applicable",
        hasExecutableSpec: hasTrustedSpec,
      }),
    ).toEqual(["typescript.typecheck", "typescript.test"]);
    // Absent or default selection defers to the historical caller default.
    expect(
      resolveCheckSelection({ plan, hasExecutableSpec: hasTrustedSpec }),
    ).toBeUndefined();
    expect(
      resolveCheckSelection({
        plan,
        selection: "default",
        hasExecutableSpec: hasTrustedSpec,
      }),
    ).toBeUndefined();
  });
});

describe("Batch 53 — pipeline selection mode", () => {
  it("default behavior stays backward-compatible (single typecheck)", async () => {
    const { pipeline, transport } = createPipeline();
    const output = await pipeline.verify(basePipelineInput());

    expect(output.selectedItem.checkId).toBe("typescript.typecheck");
    expect(output.checkResults).toHaveLength(1);
    expect(transport.requests).toHaveLength(1);
  });

  it("all-applicable executes every applicable executable TypeScript check in planner order", async () => {
    const { pipeline, transport } = createPipeline();
    const output = await pipeline.verify({
      ...basePipelineInput(),
      selection: "all-applicable",
    });

    expect(output.checkResults.map((result) => result.checkId)).toEqual([
      ...FULL_TYPESCRIPT_CHECK_IDS,
    ]);
    expect(transport.requests).toHaveLength(4);
    expect(
      output.sandboxRequests.map((request) => request.commands[0]),
    ).toEqual([
      expect.objectContaining({
        executable: "pnpm",
        args: ["exec", "tsc", "--noEmit"],
      }),
      expect.objectContaining({
        executable: "pnpm",
        args: ["exec", "eslint", "."],
      }),
      expect.objectContaining({
        executable: "pnpm",
        args: ["exec", "vitest", "run"],
      }),
      expect.objectContaining({
        executable: "pnpm",
        args: ["exec", "tsc", "--build"],
      }),
    ]);
    // Build follows typecheck: dependency ordering preserved.
    const checkIds = output.checkResults.map((result) =>
      String(result.checkId),
    );
    expect(checkIds.indexOf("typescript.typecheck")).toBeLessThan(
      checkIds.indexOf("typescript.build"),
    );
  });

  it("all-applicable matches the existing typescript-basic detection fixture", async () => {
    const transport = new FakeSandboxTransport((request) => ({
      ...sandboxResult,
      jobId: request.jobId,
    }));
    const pipeline = createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    });
    const output = await pipeline.verify({
      ...basePipelineInput(),
      detectionContext: createFileSystemDetectionContext(
        resolve("tests/fixtures/project-detection/typescript-basic"),
      ),
      selection: "all-applicable",
    });
    expect(output.checkResults.map((result) => result.checkId)).toEqual([
      ...FULL_TYPESCRIPT_CHECK_IDS,
    ]);
    expect(transport.requests).toHaveLength(4);
  });

  it("explicit selectedCheckIds win over all-applicable", async () => {
    const { pipeline, transport } = createPipeline();
    const output = await pipeline.verify({
      ...basePipelineInput(),
      selection: "all-applicable",
      selectedCheckIds: [brandId<"CheckId">("typescript.typecheck")],
    });
    expect(output.checkResults).toHaveLength(1);
    expect(output.checkResults[0]?.checkId).toBe("typescript.typecheck");
    expect(transport.requests).toHaveLength(1);
  });

  it("never executes applicable checks without an executable spec", async () => {
    // package.json alone yields only the dependency.audit capability, which
    // is applicable but has no trusted executable specification.
    const { pipeline, transport } = createPipeline();
    await expect(
      pipeline.verify({
        ...basePipelineInput({
          "package.json": JSON.stringify({ name: "batch53-audit-only" }),
        }),
        selection: "all-applicable",
      }),
    ).rejects.toMatchObject({
      name: "VerificationPipelineError",
      code: "no_applicable_check",
    });
    expect(transport.requests).toHaveLength(0);
  });

  it("all-applicable with no applicable checks fails closed", async () => {
    const { pipeline, transport } = createPipeline();
    await expect(
      pipeline.verify({
        ...basePipelineInput({}),
        selection: "all-applicable",
      }),
    ).rejects.toMatchObject({
      name: "VerificationPipelineError",
      code: "no_applicable_check",
    });
    expect(transport.requests).toHaveLength(0);
  });
});

describe("Batch 53 — Rust/Soroban ecosystem-neutral selection", () => {
  it("selects rust.check, clippy, and test in planner order (no GitHub list)", async () => {
    const { pipeline, transport } = createPipeline();
    const output = await pipeline.verify({
      ...basePipelineInput({
        "Cargo.toml": '[package]\nname = "batch53"\nversion = "0.1.0"\n',
        "src/lib.rs": "pub fn value() -> u32 { 42 }\n",
      }),
      selection: "all-applicable",
    });
    expect(output.checkResults.map((result) => result.checkId)).toEqual([
      "rust.check",
      "rust.clippy",
      "rust.test",
    ]);
    expect(transport.requests).toHaveLength(3);
  });

  it("selects soroban.contract-test after rust.test for Soroban projects", async () => {
    const { pipeline, transport } = createPipeline();
    const output = await pipeline.verify({
      ...basePipelineInput({
        "Cargo.toml":
          '[package]\nname = "batch53-soroban"\nversion = "0.1.0"\n[dependencies]\nsoroban-sdk = "22"\n',
        "src/lib.rs": "pub fn value() -> u32 { 42 }\n",
      }),
      selection: "all-applicable",
    });
    const checkIds = output.checkResults.map((result) =>
      String(result.checkId),
    );
    expect(checkIds).toEqual([
      "rust.check",
      "rust.clippy",
      "rust.test",
      "soroban.contract-test",
    ]);
    expect(checkIds.indexOf("rust.test")).toBeLessThan(
      checkIds.indexOf("soroban.contract-test"),
    );
    expect(transport.requests).toHaveLength(4);
  });

  it("the real planner agrees with selection for detected Rust profiles", () => {
    const planner = createCheckPlanner();
    const detector = createProjectDetectionService();
    const detected = detector.detect(
      project,
      snapshot,
      createMemoryDetectionContext({
        "Cargo.toml": '[package]\nname = "batch53"\nversion = "0.1.0"\n',
      }),
    );
    const plan = planner.plan(detected.profile);
    expect(selectApplicableExecutableChecks(plan, hasTrustedSpec)).toEqual([
      "rust.check",
      "rust.clippy",
      "rust.test",
    ]);
  });

  it("no GitHub-specific check list exists in orchestrator or worker", () => {
    for (const source of [orchestratorSource, workerSource]) {
      for (const forbidden of [
        "typescript.typecheck",
        "typescript.lint",
        "typescript.test",
        "typescript.build",
        "rust.check",
        "rust.test",
        "rust.clippy",
        "soroban",
        "typecheck",
        "clippy",
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
    // The only selection vocabulary at those layers is provider-neutral.
    expect(orchestratorSource).toContain("all-applicable");
  });
});

describe("Batch 53 — queue job selection propagation", () => {
  const SHA = "a".repeat(40);
  const BASE = "b".repeat(40);

  function prEvent(action: string) {
    return {
      action,
      repository: { owner: "octocat", name: "hello-world" },
      pullRequest: {
        number: 7,
        base: { sha: BASE },
        head: { sha: SHA },
      },
    } as const;
  }

  function wellFormedJob(overrides: Record<string, unknown> = {}) {
    return {
      jobId: "job-batch53-1",
      source: {
        kind: "snapshot",
        id: `octocat:hello-world:${SHA}`,
      },
      trigger: {
        kind: "pull-request",
        action: "opened",
        pullRequestNumber: 7,
      },
      deliveryId: "delivery-batch53-1",
      createdAt: "2026-09-27T00:00:00.000Z",
      ...overrides,
    };
  }

  it("GitHub orchestrator requests all-applicable selection", async () => {
    const queue = createInMemoryVerificationJobQueue();
    const orchestrator = createGitHubVerificationOrchestrator(queue, {
      createJobId: () => "job-batch53-orchestrated",
      now: () => "2026-09-27T00:00:00.000Z",
    });
    const output = await orchestrator.handle(prEvent("opened"), {
      deliveryId: "delivery-batch53-orchestrated",
    });
    expect(output.kind).toBe("enqueued");
    expect(queue.size()).toBe(1);
    expect(queue.jobs[0]?.selection).toBe("all-applicable");
    if (output.kind === "enqueued") {
      expect(output.job.selection).toBe("all-applicable");
    }
  });

  it("queue validation accepts absent, default, and all-applicable selection", () => {
    expect(() => validateVerificationQueueJob(wellFormedJob())).not.toThrow();
    expect(() =>
      validateVerificationQueueJob(wellFormedJob({ selection: "default" })),
    ).not.toThrow();
    expect(() =>
      validateVerificationQueueJob(
        wellFormedJob({ selection: "all-applicable" }),
      ),
    ).not.toThrow();
    for (const invalid of ["everything", "", "ALL-APPLICABLE", null, 42]) {
      expect(() =>
        validateVerificationQueueJob(wellFormedJob({ selection: invalid })),
      ).toThrow();
    }
  });

  it("jobs without selection stay backward-compatible (selection absent)", () => {
    const created = createVerificationQueueJob(wellFormedJob());
    expect(created.selection).toBeUndefined();
    expect("selection" in created).toBe(false);
  });

  it("in-memory queue preserves selection through enqueue", async () => {
    const queue = createInMemoryVerificationJobQueue();
    await queue.enqueue(
      wellFormedJob({ selection: "all-applicable" }) as never,
    );
    expect(queue.jobs[0]?.selection).toBe("all-applicable");
    await queue.enqueue(
      wellFormedJob({
        jobId: "job-batch53-legacy",
        deliveryId: "delivery-batch53-legacy",
      }) as never,
    );
    expect(queue.jobs[1]?.selection).toBeUndefined();
  });

  it("worker translates selection intent into verifySource", async () => {
    const verifySource = vi.fn(async () => ({}));
    const processor = createVerificationJobProcessor({
      verifySource: verifySource as never,
    });
    const source = {
      kind: "snapshot",
      id: `octocat:hello-world:${SHA}`,
    } as const;

    await processor.process(
      createVerificationQueueJob(
        wellFormedJob({ selection: "all-applicable" }),
      ) as VerificationQueueJob,
    );
    expect(verifySource).toHaveBeenCalledTimes(1);
    expect(verifySource).toHaveBeenCalledWith({
      source,
      selection: "all-applicable",
    });

    verifySource.mockClear();
    await processor.process(
      createVerificationQueueJob(wellFormedJob()) as VerificationQueueJob,
    );
    expect(verifySource).toHaveBeenCalledTimes(1);
    // Legacy jobs keep the exact historical call shape.
    expect(verifySource).toHaveBeenCalledWith({ source });
  });

  it("application service forwards selection into the pipeline", async () => {
    const transport = new FakeSandboxTransport((request) => ({
      ...sandboxResult,
      jobId: request.jobId,
    }));
    const pipeline = createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    });
    const sourceResolver = {
      async resolveSnapshot() {
        return {
          snapshot,
          sourceContents: { ...FULL_TYPESCRIPT_CONTENTS },
        };
      },
    };
    const service = new VerificationApplicationService(
      pipeline,
      sourceResolver as never,
    );
    const result = await service.verifySource({
      source: { kind: "snapshot", id: "batch53-source" },
      selection: "all-applicable",
    });
    expect(result.checkResults).toHaveLength(4);
    expect(transport.requests).toHaveLength(4);
    // Legacy callers without selection keep the single-check fallback.
    const legacy = await service.verifySource({
      source: { kind: "snapshot", id: "batch53-source" },
    });
    expect(legacy.checkResults).toHaveLength(1);
    expect(transport.requests).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// GitHub webhook → multi-check service (fake sandbox, real HTTP + runtime)
// ---------------------------------------------------------------------------

const WEBHOOK_OWNER = "octocat";
const WEBHOOK_REPOSITORY = "hello-world";
const WEBHOOK_HEAD_SHA = "c".repeat(40);
const WEBHOOK_BASE_SHA = "b".repeat(40);
const WEBHOOK_SECRET = "batch53-test-webhook-secret";
const WEBHOOK_RESULT_TOKEN = "batch53-internal-result-token-for-tests-only";
const WEBHOOK_CREATED_AT = "2026-09-27T00:00:00.000Z";

function createWebhookService() {
  const transport = new FakeSandboxTransport((request) => ({
    ...sandboxResult,
    jobId: request.jobId,
  }));
  const provider = createInMemoryGitHubSourceProvider([
    {
      reference: {
        kind: "github-snapshot" as const,
        owner: WEBHOOK_OWNER,
        repository: WEBHOOK_REPOSITORY,
        sha: WEBHOOK_HEAD_SHA,
      },
      sourceContents: { ...FULL_TYPESCRIPT_CONTENTS },
    },
  ]);
  const applicationService = new VerificationApplicationService(
    createVerificationPipeline({
      detector: createProjectDetectionService(),
      executor: createCheckExecutor(
        createSandboxExecutorFromTransport(transport),
      ),
    }),
    createGitHubSourceResolver(provider),
  );
  let counter = 0;
  const service = createGitHubVerificationService({
    applicationService,
    secret: WEBHOOK_SECRET,
    internalResultToken: WEBHOOK_RESULT_TOKEN,
    createJobId: () => `job-batch53-${(counter += 1)}`,
    now: () => WEBHOOK_CREATED_AT,
  });
  return { service, transport, applicationService };
}

function webhookPayload(action = "opened", sha = WEBHOOK_HEAD_SHA): string {
  return JSON.stringify({
    action,
    repository: {
      owner: { login: WEBHOOK_OWNER },
      name: WEBHOOK_REPOSITORY,
    },
    pull_request: {
      number: 42,
      base: { sha: WEBHOOK_BASE_SHA },
      head: { sha },
    },
  });
}

function signWebhook(payload: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex")}`;
}

function postWebhook(
  port: number,
  payload: string,
  delivery: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "POST",
        path: "/webhook",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": signWebhook(payload),
          "x-github-event": "pull_request",
          "x-github-delivery": delivery,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", rejectPromise);
    outbound.end(payload);
  });
}

function getResult(
  port: number,
  queueJobId: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const outbound = httpRequest(
      {
        port,
        host: "127.0.0.1",
        method: "GET",
        path: `/verification-jobs/${encodeURIComponent(queueJobId)}/result`,
        headers: { authorization: `Bearer ${WEBHOOK_RESULT_TOKEN}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outbound.on("error", rejectPromise);
    outbound.end();
  });
}

describe("Batch 53 — GitHub webhook triggers the applicable plan", () => {
  it("webhook → queue intent → runtime → service → multiple checks → aggregated result", async () => {
    const { service, transport, applicationService } = createWebhookService();
    const spy = vi.spyOn(applicationService, "verifySource");
    // The batch uses a random delivery suffix so reruns never collide with
    // replay state; the service instance is fresh per test regardless.
    const delivery = `delivery-b53-${randomUUID()}`;
    await service.start(0, "127.0.0.1");
    try {
      const address = service.server.address();
      if (!address || typeof address === "string") {
        throw new Error("composed service did not bind a port");
      }
      // The webhook is the entry point: no processNext/drain/verifySource.
      const webhookResponse = await postWebhook(
        address.port,
        webhookPayload(),
        delivery,
      );
      expect(webhookResponse.status).toBe(202);
      const queueJobId = (
        JSON.parse(webhookResponse.body) as { queueJobId: string }
      ).queueJobId;
      // Automatic runtime consumption settles the job on its own.
      const outcome = await service.waitForQueueJob(queueJobId, {
        timeoutMs: 5000,
      });
      expect(outcome.kind).toBe("completed");

      // The queue job carried selection intent into the application layer.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({
        source: {
          kind: "snapshot",
          id: `${WEBHOOK_OWNER}:${WEBHOOK_REPOSITORY}:${WEBHOOK_HEAD_SHA}`,
        },
        selection: "all-applicable",
      });

      // All four applicable TypeScript checks executed, in planner order.
      expect(transport.requests).toHaveLength(4);
      const stored = service.resultReader.getByQueueJobId(queueJobId);
      expect(stored).not.toBeNull();
      // VerificationResult.checkResults carries CheckResult ID references;
      // the executed check identities live in coverage.
      expect(stored?.checkResults).toHaveLength(4);
      // Coverage buckets are sorted alphabetically by aggregation
      // semantics; planner execution order is proven by the
      // transport-request assertions above.
      expect(stored?.coverage.simulated).toEqual([
        "typescript.build",
        "typescript.lint",
        "typescript.test",
        "typescript.typecheck",
      ]);
      expect(stored?.contentHash).toMatch(/^[0-9a-f]{64}$/);

      // The protected result route exposes the aggregated multi-check
      // result for the webhook queueJobId.
      const fetched = await getResult(address.port, queueJobId);
      expect(fetched.status).toBe(200);
      const body = JSON.parse(fetched.body) as {
        queueJobId: string;
        checkResults: readonly unknown[];
        contentHash: string;
      };
      expect(body.queueJobId).toBe(queueJobId);
      expect(body.checkResults).toHaveLength(4);
      expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await service.stop();
    }
  });
});
