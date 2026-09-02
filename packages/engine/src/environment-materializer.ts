import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DependencyProvisioningRequest,
  GeneratedArtifactRequirement,
} from "@verify-agent/domain";
import type { ExecutionEnvironment } from "./interfaces.js";
import type { DependencyProvisioningPort } from "./interfaces.js";
import type { GeneratedArtifactPreparer } from "./generated-artifacts.js";
import {
  artifactDirectoryContentHash,
  DependencyProvisioningError,
} from "./dependency-provisioning.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function safeRelative(path: string): boolean {
  return (
    Boolean(path) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").includes("..")
  );
}

async function assertTreeSafe(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if ((await lstat(path)).isSymbolicLink())
      throw new DependencyProvisioningError("materialization symlink rejected");
    if (entry.isDirectory()) await assertTreeSafe(path);
  }
}

export function materializationIdentity(
  environment: ExecutionEnvironment,
  configuration: Readonly<Record<string, string>> = {},
): string {
  return hash({
    sourceSnapshotId: environment.sourceSnapshotId,
    dependency: environment.dependencyEnvironment && {
      artifactId: environment.dependencyEnvironment.artifactId,
      contentHash: environment.dependencyEnvironment.contentHash,
    },
    generatedArtifacts: environment.generatedArtifacts
      .map((artifact) => ({
        id: artifact.id,
        contentHash: artifact.contentHash,
        inputHash: artifact.inputHash,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    configuration,
  });
}

export interface ExecutionEnvironmentMaterializationRequest {
  readonly environment: ExecutionEnvironment;
  readonly sourceRoot: string;
  readonly destination: string;
  readonly dependencyProvisioning?: DependencyProvisioningRequest;
  readonly generatedRequirements?: readonly GeneratedArtifactRequirement[];
}

export interface ExecutionEnvironmentMaterializationResult {
  readonly destination: string;
  readonly identityHash: string;
  readonly dependencyArtifactId?: string;
  readonly generatedArtifactIds: readonly string[];
}

/** Composes trusted source, dependency, and generated trees into one sandbox workspace. */
export class ExecutionEnvironmentMaterializer {
  constructor(
    private readonly dependencies: {
      readonly dependencyProvisioner?: DependencyProvisioningPort;
      readonly generatedArtifactPreparer?: GeneratedArtifactPreparer;
      readonly configuration?: Readonly<Record<string, string>>;
    } = {},
  ) {}

  async materialize(
    request: ExecutionEnvironmentMaterializationRequest,
  ): Promise<ExecutionEnvironmentMaterializationResult> {
    if (!isAbsolute(request.sourceRoot) || !isAbsolute(request.destination))
      throw new DependencyProvisioningError(
        "materialization paths must be absolute",
      );
    const sourceRoot = resolve(request.sourceRoot);
    const destination = resolve(request.destination);
    await assertTreeSafe(sourceRoot);
    await artifactDirectoryContentHash(sourceRoot);
    const requirements = request.generatedRequirements ?? [];
    for (const requirement of requirements) {
      for (const output of requirement.outputPaths) {
        if (!safeRelative(output))
          throw new DependencyProvisioningError(
            "generated output path is unsafe",
          );
        const sourcePath = join(sourceRoot, output);
        try {
          if ((await lstat(sourcePath)).isFile())
            throw new DependencyProvisioningError(
              "materialization path conflict",
            );
        } catch (error) {
          if (error instanceof DependencyProvisioningError) throw error;
        }
      }
    }
    await mkdir(destination, { recursive: true });
    await cp(sourceRoot, destination, {
      recursive: true,
      dereference: true,
      force: false,
      errorOnExist: false,
    });
    if (request.dependencyProvisioning) {
      if (!this.dependencies.dependencyProvisioner)
        throw new DependencyProvisioningError(
          "dependency provisioner is required",
        );
      await this.dependencies.dependencyProvisioner.provision(
        request.dependencyProvisioning,
        destination,
      );
    }
    const generatedArtifactIds: string[] = [];
    if (requirements.length > 0) {
      if (!this.dependencies.generatedArtifactPreparer)
        throw new DependencyProvisioningError(
          "generated artifact preparer is required",
        );
      for (const requirement of requirements) {
        const artifact =
          await this.dependencies.generatedArtifactPreparer.prepare(
            requirement,
            request.environment,
            destination,
          );
        generatedArtifactIds.push(artifact.id);
      }
    }
    return Object.freeze({
      destination,
      identityHash: materializationIdentity(
        request.environment,
        this.dependencies.configuration,
      ),
      ...(request.environment.dependencyEnvironment === undefined
        ? {}
        : {
            dependencyArtifactId:
              request.environment.dependencyEnvironment.artifactId,
          }),
      generatedArtifactIds: Object.freeze(generatedArtifactIds),
    });
  }
}

export async function removeMaterializedEnvironment(
  path: string,
): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export function materializedSourceRelativePath(
  root: string,
  path: string,
): string {
  const value = relative(resolve(root), resolve(path)).split(sep).join("/");
  if (!safeRelative(value))
    throw new DependencyProvisioningError("materialized path escapes root");
  return value;
}
