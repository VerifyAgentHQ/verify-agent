import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

const configured = process.env.VERIFY_REAL_SANDBOX === "1";
const required = [
  "VERIFY_SANDBOX_PROCESS",
  "VERIFY_SANDBOX_SNAPSHOT_ROOT",
  "VERIFY_SANDBOX_DOCKER_EXECUTABLE",
  "VERIFY_SANDBOX_DOCKER_HOST",
  "VERIFY_SANDBOX_SYSTEM_ROOT",
  "VERIFY_SANDBOX_TEMP_ROOT",
  "VERIFY_DEPENDENCY_ARTIFACT",
  "VERIFY_GENERATED_ARTIFACT",
];
const ready =
  configured && required.every((name) => Boolean(process.env[name]));
const roots: string[] = [];

async function boundedManifest(root: string): Promise<{
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly manifestHash: string;
  readonly selected: Readonly<Record<string, string>>;
}> {
  const entries: Array<{ path: string; size: number; hash: string }> = [];
  const selected: Record<string, string> = {};
  const walk = async (current: string, relative = ""): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = join(current, entry.name);
      const info = await lstat(fullPath);
      if (info.isSymbolicLink()) {
        entries.push({ path: entryRelative, size: 0, hash: "SYMLINK" });
        continue;
      }
      if (info.isDirectory()) {
        await walk(fullPath, entryRelative);
        continue;
      }
      if (!info.isFile()) continue;
      const content = await readFile(fullPath);
      const hash = createHash("sha256").update(content).digest("hex");
      entries.push({ path: entryRelative, size: info.size, hash });
      if (
        [
          "package.json",
          "pnpm-lock.yaml",
          "tsconfig.json",
          "src/index.ts",
          "generated/output.d.ts",
          "node_modules/.bin/tsc",
          "node_modules/typescript/package.json",
        ].includes(entryRelative)
      )
        selected[entryRelative] = `${info.size}:${hash.slice(0, 16)}`;
    }
  };
  await walk(root);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    manifestHash: createHash("sha256")
      .update(JSON.stringify(entries))
      .digest("hex"),
    selected,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("gated real execution-environment integration", () => {
  it.skipIf(!ready)(
    ready
      ? "executes the pre-materialized fixture through the real sandbox"
      : "SKIPPED — real sandbox and operator artifacts are not configured",
    async () => {
      const fixture = join(process.cwd(), "tests", "fixtures", "dependencies");
      const packageJson = await readFile(join(fixture, "package.json"), "utf8");
      const lockfile = await readFile(join(fixture, "pnpm-lock.yaml"), "utf8");
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const snapshotId = brandId<"RepositorySnapshotId">("batch16-fixture");
      const identity = {
        snapshotId,
        manifestHash: digest(packageJson),
        lockfileHash: digest(lockfile),
        ecosystem: "node" as const,
        packageManager: "pnpm",
        packageManagerVersion: "11.21.0",
        toolchainVersion: "node-24.19.0",
        platform: { operatingSystem: "linux", architecture: "amd64" },
        provisioningConfig: { offline: "true" },
        generatedArtifactInputs: ["generated/output.d.ts"],
      };
      const artifactIdentity = createDependencyArtifact(identity);
      const root = await mkdtemp(join(process.cwd(), "real-environment-test-"));
      roots.push(root);
      const artifactStore = join(root, "dependencies");
      await mkdir(join(artifactStore, artifactIdentity.artifactId), {
        recursive: true,
      });
      await cp(
        process.env.VERIFY_DEPENDENCY_ARTIFACT!,
        join(artifactStore, artifactIdentity.artifactId),
        { recursive: true },
      );
      const artifact = createDependencyArtifact(identity, {
        artifactContentHash: await artifactDirectoryContentHash(
          join(artifactStore, artifactIdentity.artifactId),
        ),
      });
      const generatedRoot = join(root, "generated");
      await mkdir(generatedRoot, { recursive: true });
      const generated = join(generatedRoot, "output");
      await cp(process.env.VERIFY_GENERATED_ARTIFACT!, generated, {
        recursive: true,
      });
      const sourceRoot = join(root, "source");
      await cp(fixture, sourceRoot, { recursive: true });
      await rm(join(sourceRoot, "generated"), { recursive: true, force: true });
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
        id: "generated-output",
        name: "fixture generated output",
        strategy: "fixture",
        required: true,
        inputHashes: ["b".repeat(64)],
        outputPaths: ["generated/output.d.ts"],
      };
      const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT!;
      const snapshot = join(snapshotRoot, snapshotId);
      await rm(snapshot, { recursive: true, force: true });
      await new ExecutionEnvironmentMaterializer({
        dependencyProvisioner: new OfflineDependencyProvisioner(artifactStore, {
          operatingSystem: "linux",
          architecture: "amd64",
        }),
        generatedArtifactPreparer: new PrebuiltGeneratedArtifactPreparer({
          artifactRoot: generatedRoot,
          artifactReferences: { "generated-output": generated },
        }),
      }).materialize({
        environment,
        sourceRoot,
        destination: snapshot,
        dependencyProvisioning: { identity, artifact, offlineOnly: true },
        generatedRequirements: [requirement],
      });
      const project = {
        id: brandId<"ProjectId">("batch16-project"),
        name: "batch16-fixture",
        root: ".",
      };
      const snapshotRecord = {
        id: snapshotId,
        projectId: project.id,
        source: { provider: "fixture", reference: "batch16" },
        sourceState: { type: "snapshot" as const, value: snapshotId },
        retrievedAt: "2026-09-01T00:00:00Z",
      };
      const transport = new SubprocessSandboxTransport({
        executable: process.env.VERIFY_SANDBOX_PROCESS!,
        environment: {
          VERIFY_SANDBOX_SNAPSHOT_ROOT: snapshotRoot,
          VERIFY_SANDBOX_DOCKER_EXECUTABLE:
            process.env.VERIFY_SANDBOX_DOCKER_EXECUTABLE!,
          VERIFY_SANDBOX_DOCKER_HOST: process.env.VERIFY_SANDBOX_DOCKER_HOST!,
          VERIFY_SANDBOX_SYSTEM_ROOT: process.env.VERIFY_SANDBOX_SYSTEM_ROOT!,
          VERIFY_SANDBOX_TEMP_ROOT: process.env.VERIFY_SANDBOX_TEMP_ROOT!,
          VERIFY_SANDBOX_DIAGNOSTIC_OUTPUT: join(
            root,
            "sandbox-diagnostic.json",
          ),
        },
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 60_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const output = await createVerificationPipeline({
        detector: createProjectDetectionService(),
        executor: createCheckExecutor(
          createSandboxExecutorFromTransport(transport),
        ),
      }).verify({
        project,
        snapshot: snapshotRecord,
        changeSet: {
          id: brandId<"ChangeSetId">("batch16-change"),
          baseSourceState: snapshotRecord.sourceState,
          headSourceState: snapshotRecord.sourceState,
          changedFiles: [],
          additions: 0,
          deletions: 0,
          changeHash: "c".repeat(64),
          issueReferences: [],
        },
        detectionContext: createFileSystemDetectionContext(snapshot),
        jobId: "batch16-job",
        executionId: "batch16-execution",
        resultId: "batch16-result",
        createdAt: "2026-09-01T00:00:00Z",
      });
      const snapshotManifest = await boundedManifest(snapshot);
      const sandboxDiagnostic = await readFile(
        join(root, "sandbox-diagnostic.json"),
        "utf8",
      );
      console.error(
        JSON.stringify({
          diagnostic: "real-sandbox-result",
          checkResult: {
            status: output.checkResult.status,
            executionSource: output.checkResult.executionSource,
            exitCode: output.checkResult.exitCode,
            durationMs: output.checkResult.durationMs,
            summary: output.checkResult.summary,
            rawOutputRef: output.checkResult.rawOutputRef,
            artifactRefs: output.checkResult.artifactRefs,
            metrics: output.checkResult.metrics,
            inputHash: output.checkResult.inputHash,
            contentHash: output.checkResult.contentHash,
            producer: output.checkResult.producer,
          },
          request: {
            executable: "pnpm",
            args: ["exec", "tsc", "--noEmit"],
            workingDirectory: ".",
            environmentKeys: [],
            networkPolicy: "none",
            artifactPolicy: "none",
          },
          snapshotManifest,
          sandboxDiagnostic: JSON.parse(sandboxDiagnostic),
        }),
      );
      expect(output.checkResult.status).toBe("passed");
      expect(output.checkResult.executionSource).toBe("real");
    },
    120_000,
  );
});
