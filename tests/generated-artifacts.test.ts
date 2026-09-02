import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PrebuiltGeneratedArtifactPreparer,
  artifactDirectoryContentHash,
  generatedArtifactInputHash,
} from "../packages/engine/src/index.js";
import {
  brandId,
  type GeneratedArtifactRequirement,
} from "../packages/domain/src/index.js";
import type { ExecutionEnvironment } from "../packages/engine/src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function environment(): ExecutionEnvironment {
  return {
    sourceSnapshotId: brandId<"RepositorySnapshotId">("generated-fixture"),
    generatedArtifacts: [],
    identityHash: "a".repeat(64),
  };
}

const requirement: GeneratedArtifactRequirement = {
  id: "generated-fixture",
  name: "fixture output",
  strategy: "fixture",
  required: true,
  inputHashes: ["b".repeat(64)],
  outputPaths: ["generated/output.d.ts"],
};

describe("generated artifact preparation", () => {
  it("is deterministic and materializes a bounded prebuilt artifact", async () => {
    const root = await mkdtemp(join(process.cwd(), "generated-artifact-test-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(join(source, "generated"), { recursive: true });
    await writeFile(join(source, "generated", "output.d.ts"), "export {}\n");
    const first = generatedArtifactInputHash(requirement, environment());
    const second = generatedArtifactInputHash(requirement, environment());
    expect(first).toBe(second);
    expect(
      generatedArtifactInputHash(
        { ...requirement, inputHashes: ["c".repeat(64)] },
        environment(),
      ),
    ).not.toBe(first);
    const contentHash = await artifactDirectoryContentHash(source, {
      maxBytes: 256 * 1024 * 1024,
      maxFiles: 25_000,
    });
    const artifact = await new PrebuiltGeneratedArtifactPreparer({
      artifactRoot: root,
      artifactReferences: { [requirement.id]: source },
      expectedContentHashes: { [requirement.id]: contentHash },
    }).prepare(requirement, environment(), destination);
    expect(artifact.inputHash).toBe(first);
    expect(
      await readFile(join(destination, "generated", "output.d.ts"), "utf8"),
    ).toContain("export");
  });

  it("rejects a modified prebuilt artifact", async () => {
    const root = await mkdtemp(join(process.cwd(), "generated-artifact-test-"));
    roots.push(root);
    const source = join(root, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "output.d.ts"), "modified\n");
    await expect(
      new PrebuiltGeneratedArtifactPreparer({
        artifactRoot: root,
        artifactReferences: { [requirement.id]: source },
        expectedContentHashes: { [requirement.id]: "c".repeat(64) },
      }).prepare(requirement, environment(), join(root, "destination")),
    ).rejects.toThrow("integrity mismatch");
  });
});
