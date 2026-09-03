import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExecutionEnvironmentMaterializer,
  OfflineDependencyProvisioner,
  PrebuiltGeneratedArtifactPreparer,
  SubprocessSandboxTransport,
  artifactDirectoryContentHash,
  createCheckExecutor,
  createDependencyArtifact,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
} from "../packages/engine/src/index.js";
import {
  brandId,
  type GeneratedArtifactRequirement,
} from "../packages/domain/src/index.js";
import {
  createFileSystemDetectionContext,
  createProjectDetectionService,
} from "../packages/adapters-lang/src/index.js";
import type { ExecutionEnvironment } from "../packages/engine/src/index.js";

const enabled = process.env.VERIFY_REAL_STELLAR_FORGE === "1";
const variables = [
  "VERIFY_SANDBOX_PROCESS",
  "VERIFY_SANDBOX_SNAPSHOT_ROOT",
  "VERIFY_SANDBOX_DOCKER_EXECUTABLE",
  "VERIFY_SANDBOX_DOCKER_HOST",
  "VERIFY_SANDBOX_SYSTEM_ROOT",
  "VERIFY_SANDBOX_TEMP_ROOT",
  "VERIFY_DEPENDENCY_ARTIFACT",
  "VERIFY_GENERATED_ARTIFACT",
];

describe("gated real Stellar Forge execution", () => {
  it.skipIf(!enabled || variables.some((name) => !process.env[name]))(
    "executes exactly typescript.typecheck in the real sandbox",
    async () => {
      const sourceRoot = join(
        process.cwd(),
        "operator-artifacts",
        "batch23-stellar",
        "source",
      );
      const generatedReference = process.env.VERIFY_GENERATED_ARTIFACT!;
      const packageJson = await readFile(
        join(sourceRoot, "package.json"),
        "utf8",
      );
      const lockfile = await readFile(
        join(sourceRoot, "pnpm-lock.yaml"),
        "utf8",
      );
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const snapshotId = brandId<"RepositorySnapshotId">(
        "stellar-forge-batch23",
      );
      const identity = {
        snapshotId,
        manifestHash: digest(packageJson),
        lockfileHash: digest(lockfile),
        ecosystem: "node" as const,
        packageManager: "pnpm",
        packageManagerVersion: "11.21.0",
        toolchainVersion: "node-24.19.0",
        platform: {
          operatingSystem: "linux" as const,
          architecture: "amd64" as const,
        },
        provisioningConfig: { offline: "true" },
        generatedArtifactInputs: [
          ".next/types/root-params.d.ts",
          ".next/types/routes.d.ts",
        ],
      };
      const identityArtifact = createDependencyArtifact(identity);
      const root = await mkdtemp(join(process.cwd(), "real-stellar-forge-"));
      try {
        const artifactStore = join(
          process.cwd(),
          "operator-artifacts",
          "batch23-stellar",
        );
        const artifactDir = join(artifactStore, identityArtifact.artifactId);
        const artifact = createDependencyArtifact(identity, {
          artifactContentHash: await artifactDirectoryContentHash(artifactDir),
        });
        const generatedRoot = join(root, "generated");
        await mkdir(generatedRoot, { recursive: true });
        await cp(generatedReference, join(generatedRoot, "output"), {
          recursive: true,
        });
        const environment: ExecutionEnvironment = {
          sourceSnapshotId: snapshotId,
          dependencyEnvironment: {
            artifactId: artifact.artifactId,
            contentHash: artifact.contentHash,
            sourceSnapshotId: snapshotId,
            platform: artifact.platform,
            availability: "offline_capable",
            generatedArtifactInputs: identity.generatedArtifactInputs,
            producer: artifact.producer,
          },
          generatedArtifacts: [],
          identityHash: "a".repeat(64),
        };
        const requirement: GeneratedArtifactRequirement = {
          id: "stellar-forge-next-types",
          name: "required framework type declarations",
          strategy: "prebuilt_artifact",
          required: true,
          inputHashes: [digest(packageJson), digest(lockfile)],
          outputPaths: [
            ".next/types/routes.d.ts",
            ".next/types/root-params.d.ts",
          ],
        };
        const snapshot = join(
          process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!,
          snapshotId,
        );
        await rm(snapshot, { recursive: true, force: true });
        await new ExecutionEnvironmentMaterializer({
          dependencyProvisioner: new OfflineDependencyProvisioner(
            artifactStore,
            identity.platform,
          ),
          generatedArtifactPreparer: new PrebuiltGeneratedArtifactPreparer({
            artifactRoot: generatedRoot,
            artifactReferences: {
              "stellar-forge-next-types": join(generatedRoot, "output"),
            },
          }),
        }).materialize({
          environment,
          sourceRoot,
          destination: snapshot,
          dependencyProvisioning: { identity, artifact, offlineOnly: true },
          generatedRequirements: [requirement],
        });
        const project = {
          id: brandId<"ProjectId">("stellar-forge"),
          name: "stellar-forge",
          root: ".",
        };
        const snapshotRecord = {
          id: snapshotId,
          projectId: project.id,
          source: { provider: "local" as const, reference: "stellar-forge" },
          sourceState: { type: "snapshot" as const, value: snapshotId },
          retrievedAt: "2026-09-01T00:00:00Z",
        };
        console.error("[stellar-forge-diag] Creating transport...");
        const transport = new SubprocessSandboxTransport({
          executable: process.env.VERIFY_SANDBOX_PROCESS!,
          environment: {
            VERIFY_SANDBOX_SNAPSHOT_ROOT:
              process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!,
            VERIFY_SANDBOX_DOCKER_EXECUTABLE:
              process.env.VERIFY_SANDBOX_DOCKER_EXECUTABLE!,
            VERIFY_SANDBOX_DOCKER_HOST: process.env.VERIFY_SANDBOX_DOCKER_HOST!,
            VERIFY_SANDBOX_SYSTEM_ROOT: process.env.VERIFY_SANDBOX_SYSTEM_ROOT!,
            VERIFY_SANDBOX_TEMP_ROOT: process.env.VERIFY_SANDBOX_TEMP_ROOT!,
          },
          startupTimeoutMs: 2_000,
          requestTimeoutMs: 300_000,
          maxMessageBytes: 1024 * 1024,
          maxStderrBytes: 64 * 1024,
        });
        console.error(
          "[stellar-forge-diag] Transport created, creating pipeline...",
        );
        console.error("[stellar-forge-diag] Running pipeline verify...");
        const output = await createVerificationPipeline({
          detector: createProjectDetectionService(),
          executor: createCheckExecutor(
            createSandboxExecutorFromTransport(transport),
          ),
        }).verify({
          project,
          snapshot: snapshotRecord,
          changeSet: {
            id: brandId<"ChangeSetId">("stellar-forge-batch23-change"),
            baseSourceState: snapshotRecord.sourceState,
            headSourceState: snapshotRecord.sourceState,
            changedFiles: [],
            additions: 0,
            deletions: 0,
            changeHash: "b".repeat(64),
            issueReferences: [],
          },
          detectionContext: createFileSystemDetectionContext(snapshot),
          jobId: "stellar-forge-batch23-job",
          executionId: "stellar-forge-batch23-execution",
          resultId: "stellar-forge-batch23-result",
          createdAt: "2026-09-01T00:00:00Z",
        });
        console.error("[stellar-forge-diag] Pipeline verify completed");
        console.error(
          JSON.stringify({
            checkResult: output.checkResult,
            executionEnvironment: output.executionEnvironment,
          }),
        );
        console.error(
          "[stellar-forge-diag] Check result status:",
          output.checkResult.status,
        );
        console.error(
          "[stellar-forge-diag] Check result executionSource:",
          output.checkResult.executionSource,
        );
        expect(output.checkResult.status).toBe("passed");
        expect(output.checkResult.executionSource).toBe("real");
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(
          join(
            process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!,
            "stellar-forge-batch23",
          ),
          { recursive: true, force: true },
        );
      }
    },
    360_000,
  );
});
