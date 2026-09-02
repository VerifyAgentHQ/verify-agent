import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutionEnvironmentMaterializer,
  OfflineDependencyProvisioner,
  PrebuiltGeneratedArtifactPreparer,
  createDependencyArtifact,
  materializationIdentity,
  type ExecutionEnvironment,
} from "../packages/engine/src/index.js";
import {
  brandId,
  type DependencyIdentityInput,
  type GeneratedArtifactRequirement,
} from "../packages/domain/src/index.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

function environment(): ExecutionEnvironment {
  return {
    sourceSnapshotId: brandId<"RepositorySnapshotId">("materializer-fixture"),
    generatedArtifacts: [],
    identityHash: "a".repeat(64),
  };
}

function dependencyIdentity(): DependencyIdentityInput {
  return {
    snapshotId: environment().sourceSnapshotId,
    manifestHash: "b".repeat(64),
    lockfileHash: "c".repeat(64),
    ecosystem: "node",
    packageManager: "pnpm",
    packageManagerVersion: "11.21.0",
    toolchainVersion: "node-24.19.0",
    platform: { operatingSystem: "linux", architecture: "amd64" },
    provisioningConfig: { offline: "true" },
    generatedArtifactInputs: [],
  };
}

describe("execution environment materializer", () => {
  it("composes source, dependencies, and generated output without changing the source", async () => {
    const root = await mkdtemp(join(process.cwd(), "materializer-test-"));
    roots.push(root);
    const source = join(root, "source");
    const dependencyStore = join(root, "dependency-store");
    const generatedStore = join(root, "generated-store");
    const destination = join(root, "workspace");
    await mkdir(join(source, "src"), { recursive: true });
    await writeFile(join(source, "src", "index.ts"), "export {};\n");
    const identity = dependencyIdentity();
    const dependency = createDependencyArtifact(identity);
    await mkdir(join(dependencyStore, dependency.artifactId, "node_modules"), {
      recursive: true,
    });
    await writeFile(
      join(
        dependencyStore,
        dependency.artifactId,
        "node_modules",
        "typescript.js",
      ),
      "fixture\n",
    );
    const generatedRequirement: GeneratedArtifactRequirement = {
      id: "generated-output",
      name: "generated output",
      strategy: "fixture",
      required: true,
      inputHashes: ["d".repeat(64)],
      outputPaths: ["generated/output.d.ts"],
    };
    await mkdir(join(generatedStore, "output", "generated"), {
      recursive: true,
    });
    await writeFile(
      join(generatedStore, "output", "generated", "output.d.ts"),
      "export {};\n",
    );
    const composedEnvironment = {
      ...environment(),
      dependencyEnvironment: {
        artifactId: dependency.artifactId,
        contentHash: dependency.contentHash,
        sourceSnapshotId: dependency.sourceSnapshotId,
        platform: dependency.platform,
        availability: "offline_capable" as const,
        generatedArtifactInputs: [],
        producer: dependency.producer,
      },
    };
    const result = await new ExecutionEnvironmentMaterializer({
      dependencyProvisioner: new OfflineDependencyProvisioner(dependencyStore),
      generatedArtifactPreparer: new PrebuiltGeneratedArtifactPreparer({
        artifactRoot: generatedStore,
        artifactReferences: {
          "generated-output": join(generatedStore, "output"),
        },
      }),
    }).materialize({
      environment: composedEnvironment,
      sourceRoot: source,
      destination,
      dependencyProvisioning: {
        identity,
        artifact: dependency,
        offlineOnly: true,
      },
      generatedRequirements: [generatedRequirement],
    });
    expect(result.dependencyArtifactId).toBe(dependency.artifactId);
    expect(result.generatedArtifactIds).toHaveLength(1);
    expect(
      await readFile(join(destination, "src", "index.ts"), "utf8"),
    ).toContain("export");
    expect(
      await readFile(
        join(destination, "node_modules", "typescript.js"),
        "utf8",
      ),
    ).toContain("fixture");
    expect(
      await readFile(join(destination, "generated", "output.d.ts"), "utf8"),
    ).toContain("export");
    expect(materializationIdentity(composedEnvironment)).toBe(
      materializationIdentity(composedEnvironment),
    );
    expect(await readFile(join(source, "src", "index.ts"), "utf8")).toContain(
      "export",
    );
  });

  it("rejects a generated output colliding with source", async () => {
    const root = await mkdtemp(join(process.cwd(), "materializer-test-"));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "output.d.ts"), "source\n");
    await expect(
      new ExecutionEnvironmentMaterializer().materialize({
        environment: environment(),
        sourceRoot: source,
        destination: join(root, "workspace"),
        generatedRequirements: [
          {
            id: "collision",
            name: "collision",
            strategy: "fixture",
            required: true,
            inputHashes: [],
            outputPaths: ["output.d.ts"],
          },
        ],
      }),
    ).rejects.toThrow("conflict");
  });
});
