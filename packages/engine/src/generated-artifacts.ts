import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  GeneratedArtifact,
  GeneratedArtifactRequirement,
  GeneratedArtifactSet,
  Provenance,
} from "@verify-agent/domain";
import type { ExecutionEnvironment } from "./interfaces.js";
import {
  artifactDirectoryContentHash,
  DependencyProvisioningError,
} from "./dependency-provisioning.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const producer: Provenance = {
  type: "system",
  name: "verify-agent-generated-artifact-preparer",
  version: "0.1.0-phase0",
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function confined(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== "..");
}

function validateRequirement(requirement: GeneratedArtifactRequirement): void {
  if (!ID.test(requirement.id) || !requirement.name)
    throw new DependencyProvisioningError(
      "generated artifact requirement is invalid",
    );
  if (
    !["none", "fixture", "prebuilt_artifact", "trusted_command"].includes(
      requirement.strategy,
    )
  )
    throw new DependencyProvisioningError(
      "unknown generated artifact strategy",
    );
  if (
    !Array.isArray(requirement.outputPaths) ||
    requirement.outputPaths.length === 0
  )
    throw new DependencyProvisioningError(
      "generated artifact output is required",
    );
  for (const path of requirement.outputPaths) {
    if (
      !path ||
      path.includes("\\") ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    )
      throw new DependencyProvisioningError(
        "generated artifact path is unsafe",
      );
  }
}

export function generatedArtifactInputHash(
  requirement: GeneratedArtifactRequirement,
  environment: ExecutionEnvironment,
): string {
  validateRequirement(requirement);
  return hash({
    sourceSnapshotId: environment.sourceSnapshotId,
    dependencyArtifactId: environment.dependencyEnvironment?.artifactId,
    requirement: {
      id: requirement.id,
      name: requirement.name,
      strategy: requirement.strategy,
      required: requirement.required,
      inputHashes: [...requirement.inputHashes].sort(),
      outputPaths: [...requirement.outputPaths].sort(),
    },
  });
}

export function generatedArtifactId(inputHash: string): string {
  if (!HASH.test(inputHash))
    throw new DependencyProvisioningError(
      "invalid generated artifact input hash",
    );
  return `generated-${inputHash.slice(0, 32)}`;
}

export interface GeneratedArtifactPreparer {
  prepare(
    requirement: GeneratedArtifactRequirement,
    environment: ExecutionEnvironment,
    destination: string,
  ): Promise<GeneratedArtifact>;
}

export interface PrebuiltGeneratedArtifactPreparerConfig {
  readonly artifactRoot: string;
  readonly artifactReferences: Readonly<Record<string, string>>;
  readonly expectedContentHashes?: Readonly<Record<string, string>>;
}

/** Copies only operator-selected prebuilt output; it never executes repository code. */
export class PrebuiltGeneratedArtifactPreparer implements GeneratedArtifactPreparer {
  constructor(
    private readonly config: PrebuiltGeneratedArtifactPreparerConfig,
  ) {
    if (!isAbsolute(config.artifactRoot))
      throw new DependencyProvisioningError(
        "generated artifact root must be absolute",
      );
  }

  async prepare(
    requirement: GeneratedArtifactRequirement,
    environment: ExecutionEnvironment,
    destination: string,
  ): Promise<GeneratedArtifact> {
    validateRequirement(requirement);
    if (
      requirement.strategy !== "prebuilt_artifact" &&
      requirement.strategy !== "fixture"
    )
      throw new DependencyProvisioningError(
        "prebuilt preparer cannot execute this strategy",
      );
    if (!isAbsolute(destination))
      throw new DependencyProvisioningError(
        "generated destination must be absolute",
      );
    const reference = this.config.artifactReferences[requirement.id];
    if (
      !reference ||
      !isAbsolute(reference) ||
      !confined(this.config.artifactRoot, reference)
    )
      throw new DependencyProvisioningError(
        "generated artifact reference is not trusted",
      );
    const source = resolve(reference);
    const metadata = await lstat(source);
    if (!metadata.isDirectory())
      throw new DependencyProvisioningError(
        "generated artifact is not a directory",
      );
    const entries = await readdir(source, { withFileTypes: true });
    if (entries.some((entry) => entry.isSymbolicLink()))
      throw new DependencyProvisioningError(
        "generated artifact symlink rejected",
      );
    const inputHash = generatedArtifactInputHash(requirement, environment);
    const id = generatedArtifactId(inputHash);
    const contentHash = await artifactDirectoryContentHash(source, {
      maxBytes: 256 * 1024 * 1024,
      maxFiles: 25_000,
    });
    const expected = this.config.expectedContentHashes?.[requirement.id];
    if (expected !== undefined && expected !== contentHash)
      throw new DependencyProvisioningError(
        "generated artifact integrity mismatch",
      );
    await mkdir(destination, { recursive: true });
    await cp(source, destination, { recursive: true, dereference: true });
    return Object.freeze({
      id,
      requirementId: requirement.id,
      sourceSnapshotId: environment.sourceSnapshotId,
      contentHash,
      inputHash,
      artifactReference: reference,
      outputPaths: Object.freeze([...requirement.outputPaths].sort()),
      producer,
    });
  }
}

export function generatedArtifactSetHash(
  artifacts: readonly GeneratedArtifact[],
): string {
  return hash(
    artifacts
      .map(({ id, requirementId, contentHash, inputHash, outputPaths }) => ({
        id,
        requirementId,
        contentHash,
        inputHash,
        outputPaths: [...outputPaths].sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function createGeneratedArtifactSet(
  artifacts: readonly GeneratedArtifact[],
): GeneratedArtifactSet {
  return Object.freeze({
    artifacts: Object.freeze([...artifacts]),
    contentHash: generatedArtifactSetHash(artifacts),
  });
}

export async function removeMaterializedGeneratedArtifacts(
  path: string,
): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
