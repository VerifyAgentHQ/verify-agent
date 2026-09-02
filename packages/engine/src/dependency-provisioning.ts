import { createHash } from "node:crypto";
import {
  type DependencyArtifact,
  type DependencyEnvironment,
  type DependencyProvisioningRequest,
  type DependencyIdentityInput,
  type DependencyPlatform,
  type Provenance,
  type RepositorySnapshotId,
} from "@verify-agent/domain";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const HASH = /^[a-f0-9]{64}$/;
const producer: Provenance = {
  type: "system",
  name: "verify-agent-offline-provisioner",
  version: "0.1.0-phase0",
};

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function requireHash(value: string, name: string): void {
  if (!HASH.test(value))
    throw new DependencyProvisioningError(`${name} must be a SHA-256 hash`);
}

function requireIdentifier(value: string, name: string): void {
  if (!ID.test(value))
    throw new DependencyProvisioningError(`${name} is invalid`);
}

export class DependencyProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyProvisioningError";
  }
}

export function dependencyArtifactContentHash(
  input: DependencyIdentityInput,
): string {
  return hash({
    snapshotId: input.snapshotId,
    manifestHash: input.manifestHash,
    lockfileHash: input.lockfileHash,
    ecosystem: input.ecosystem,
    packageManager: input.packageManager,
    packageManagerVersion: input.packageManagerVersion,
    toolchainVersion: input.toolchainVersion,
    platform: input.platform,
    provisioningConfig: input.provisioningConfig,
    generatedArtifactInputs: [...input.generatedArtifactInputs].sort(),
  });
}

export function dependencyArtifactId(input: DependencyIdentityInput): string {
  return `dependency-${dependencyArtifactContentHash(input).slice(0, 32)}`;
}

export function validateDependencyArtifact(artifact: DependencyArtifact): void {
  requireIdentifier(artifact.artifactId, "artifactId");
  requireIdentifier(artifact.sourceSnapshotId, "sourceSnapshotId");
  if (!artifact.packageManager || !artifact.packageManagerVersion)
    throw new DependencyProvisioningError(
      "package manager identity is required",
    );
  if (!artifact.toolchainVersion)
    throw new DependencyProvisioningError("toolchain identity is required");
  const platform = artifact.platform;
  if (
    !platform ||
    !["linux", "windows", "darwin"].includes(platform.operatingSystem) ||
    !["amd64", "arm64"].includes(platform.architecture)
  )
    throw new DependencyProvisioningError("dependency platform is invalid");
  requireHash(artifact.manifestHash, "manifestHash");
  requireHash(artifact.lockfileHash, "lockfileHash");
  requireHash(artifact.contentHash, "contentHash");
  if (artifact.artifactContentHash !== undefined)
    requireHash(artifact.artifactContentHash, "artifactContentHash");
  if (
    !["offline_capable", "network_required", "unavailable"].includes(
      artifact.availability,
    )
  )
    throw new DependencyProvisioningError("invalid dependency availability");
  if (!artifact.producer.type || !artifact.producer.name)
    throw new DependencyProvisioningError("dependency producer is required");
}

export function validateDependencyPlatform(
  artifact: DependencyArtifact,
  expected: DependencyPlatform,
): void {
  validateDependencyArtifact(artifact);
  if (
    artifact.platform.operatingSystem !== expected.operatingSystem ||
    artifact.platform.architecture !== expected.architecture
  )
    throw new DependencyProvisioningError(
      "dependency artifact platform is incompatible",
    );
}

export function createDependencyArtifact(
  input: DependencyIdentityInput,
  options: {
    readonly availability?: DependencyArtifact["availability"];
    readonly producer?: Provenance;
    readonly artifactContentHash?: string;
    readonly artifactReference?: string;
  } = {},
): DependencyArtifact {
  const contentHash = dependencyArtifactContentHash(input);
  const artifact: DependencyArtifact = {
    artifactId: dependencyArtifactId(input),
    sourceSnapshotId: input.snapshotId,
    ecosystem: input.ecosystem,
    packageManager: input.packageManager,
    packageManagerVersion: input.packageManagerVersion,
    toolchainVersion: input.toolchainVersion,
    platform: input.platform,
    manifestHash: input.manifestHash,
    lockfileHash: input.lockfileHash,
    generatedArtifactInputs: Object.freeze(
      [...input.generatedArtifactInputs].sort(),
    ),
    availability: options.availability ?? "offline_capable",
    contentHash,
    ...(options.artifactContentHash === undefined
      ? {}
      : { artifactContentHash: options.artifactContentHash }),
    ...(options.artifactReference === undefined
      ? {}
      : { artifactReference: options.artifactReference }),
    producer: options.producer ?? producer,
  };
  validateDependencyArtifact(artifact);
  return Object.freeze(artifact);
}

async function rejectSymlinks(root: string, current = root): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink())
      throw new DependencyProvisioningError(
        "dependency artifact symlink rejected",
      );
    if (entry.isDirectory()) await rejectSymlinks(root, path);
  }
}

export async function artifactDirectoryContentHash(
  root: string,
  limits: { readonly maxBytes?: number; readonly maxFiles?: number } = {},
): Promise<string> {
  const maxBytes = limits.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const maxFiles = limits.maxFiles ?? 100_000;
  const files: { path: string; hash: string; size: number }[] = [];
  let totalBytes = 0;
  async function visit(current: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const path = join(current, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink())
        throw new DependencyProvisioningError(
          "dependency artifact symlink rejected",
        );
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const data = await readFile(path);
        totalBytes += data.byteLength;
        if (totalBytes > maxBytes || files.length >= maxFiles)
          throw new DependencyProvisioningError(
            "dependency artifact exceeds limits",
          );
        files.push({
          path: relative(root, path).split(sep).join("/"),
          hash: createHash("sha256").update(data).digest("hex"),
          size: data.byteLength,
        });
      } else
        throw new DependencyProvisioningError(
          "unsupported dependency artifact entry",
        );
    }
  }
  await visit(root);
  return hash(files);
}

function confined(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  const suffix = relative(base, target);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== "..");
}

/**
 * Minimal offline fixture adapter. It materializes prebuilt artifacts only;
 * it never invokes a package manager, installer, script, or network.
 */
export class OfflineDependencyProvisioner {
  constructor(
    private readonly artifactRoot: string,
    private readonly expectedPlatform?: DependencyPlatform,
  ) {
    if (!isAbsolute(artifactRoot))
      throw new DependencyProvisioningError(
        "artifact root must be an absolute path",
      );
  }

  async provision(
    request: DependencyProvisioningRequest,
    destination: string,
  ): Promise<DependencyEnvironment> {
    validateDependencyArtifact(request.artifact);
    if (!request.offlineOnly)
      throw new DependencyProvisioningError(
        "offline provisioning must be explicit",
      );
    if (request.artifact.availability !== "offline_capable")
      throw new DependencyProvisioningError(
        "dependency artifact is unavailable offline",
      );
    if (request.artifact.artifactId !== dependencyArtifactId(request.identity))
      throw new DependencyProvisioningError(
        "dependency artifact identity mismatch",
      );
    if (this.expectedPlatform !== undefined)
      validateDependencyPlatform(request.artifact, this.expectedPlatform);
    if (!isAbsolute(destination))
      throw new DependencyProvisioningError("invalid destination");

    const source = resolve(this.artifactRoot, request.artifact.artifactId);
    if (!confined(this.artifactRoot, source))
      throw new DependencyProvisioningError("artifact path escapes store");
    try {
      const rootMetadata = await lstat(this.artifactRoot);
      if (rootMetadata.isSymbolicLink())
        throw new DependencyProvisioningError(
          "artifact store symlink rejected",
        );
      const sourceMetadata = await lstat(source);
      if (!sourceMetadata.isDirectory())
        throw new DependencyProvisioningError("artifact is not a directory");
      await rejectSymlinks(source);
      if (request.artifact.artifactContentHash !== undefined) {
        const actual = await artifactDirectoryContentHash(source);
        if (actual !== request.artifact.artifactContentHash)
          throw new DependencyProvisioningError(
            "dependency artifact integrity mismatch",
          );
      }
      if (request.artifact.platform.operatingSystem === "linux")
        await rejectWindowsLauncherPaths(source);
      await mkdir(destination, { recursive: true });
      await cp(source, destination, { recursive: true, errorOnExist: false });
    } catch (error) {
      if (error instanceof DependencyProvisioningError) throw error;
      throw new DependencyProvisioningError(
        "dependency artifact is unavailable",
      );
    }
    return Object.freeze({
      artifactId: request.artifact.artifactId,
      contentHash: request.artifact.contentHash,
      sourceSnapshotId: request.artifact.sourceSnapshotId,
      platform: request.artifact.platform,
      availability: "offline_capable",
      generatedArtifactInputs: request.artifact.generatedArtifactInputs,
      producer: request.artifact.producer,
    });
  }
}

async function rejectWindowsLauncherPaths(root: string): Promise<void> {
  const bin = join(root, "node_modules", ".bin");
  let entries;
  try {
    entries = await readdir(bin, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const content = await readFile(join(bin, entry.name), "utf8");
    if (containsWindowsPath(content))
      throw new DependencyProvisioningError(
        "Linux dependency launcher contains a Windows path",
      );
  }
}

function containsWindowsPath(content: string): boolean {
  return containsWindowsDrivePath(content) || containsWindowsUncPath(content);
}

function containsWindowsDrivePath(content: string): boolean {
  // Drive-letter path: <letter>:\<path> or <letter>:/<path>
  // - Not preceded by alnum, %, / or \ (avoids %s:\ format strings and escaped sequences)
  // - Letter, colon, one or more slash/backslash, then a valid path start
  // This distinguishes C:\Users\foo from harmless %s:\ literals.
  return /(?:^|[^A-Za-z0-9%\/\\])[A-Za-z]:[\\/]+[A-Za-z0-9]/.test(content);
}

function containsWindowsUncPath(content: string): boolean {
  // UNC path: \\server\share – require server and share components
  // to avoid false positives on escaped sequences like \\n
  return /(?:^|[\s"'\[\(,;=:])\\\\[A-Za-z0-9][A-Za-z0-9_\-\.]*\\[A-Za-z0-9]/.test(
    content,
  );
}

export interface PnpmDependencyArtifactBuilderConfig {
  readonly pnpmExecutable: string;
  /** Trusted argument prefix, used for a direct Node/ Corepack invocation on Windows. */
  readonly pnpmExecutableArgs?: readonly string[];
  readonly buildRoot: string;
  readonly artifactRoot: string;
  /** Explicit provisioning environment; no host environment is inherited. */
  readonly environment: Readonly<Record<string, string>>;
  readonly allowNetworkDuringBuild: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly platform: DependencyPlatform;
}

export interface PnpmDependencyArtifactBuildRequest {
  readonly identity: DependencyIdentityInput;
  readonly packageJson: string;
  readonly lockfile: string;
}

function runPnpm(
  executable: string,
  executableArgs: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
  allowNetwork: boolean,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const args = [
      ...executableArgs,
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ];
    if (!allowNetwork) args.push("--offline");
    const child = spawn(executable, args, {
      cwd,
      env: { ...environment },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputBytes = 0;
    let settled = false;
    const diagnostics: string[] = [];
    const timer = setTimeout(() => {
      fail(new DependencyProvisioningError("pnpm provisioning timed out"));
    }, timeoutMs);
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      rejectRun(error);
    };
    const consume = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= maxOutputBytes)
        diagnostics.push(chunk.toString("utf8"));
      if (outputBytes > maxOutputBytes)
        fail(
          new DependencyProvisioningError(
            "pnpm provisioning output exceeded limit",
          ),
        );
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", (error) =>
      fail(
        new DependencyProvisioningError(
          `pnpm provisioning failed: ${error.message}`,
        ),
      ),
    );
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolveRun();
      else
        rejectRun(
          new DependencyProvisioningError(
            `pnpm provisioning exited with code ${String(code)}: ${diagnostics.join("").slice(-2048)}`,
          ),
        );
    });
  });
}

/** Builds a pnpm artifact in a trusted operator environment; runtime never installs. */
export class PnpmDependencyArtifactBuilder {
  constructor(private readonly config: PnpmDependencyArtifactBuilderConfig) {
    if (
      !isAbsolute(config.pnpmExecutable) ||
      !isAbsolute(config.buildRoot) ||
      !isAbsolute(config.artifactRoot)
    )
      throw new DependencyProvisioningError(
        "pnpm builder paths must be absolute",
      );
  }

  async build(
    request: PnpmDependencyArtifactBuildRequest,
  ): Promise<DependencyArtifact> {
    if (
      request.identity.ecosystem !== "node" ||
      request.identity.packageManager !== "pnpm"
    )
      throw new DependencyProvisioningError(
        "pnpm builder requires the node/pnpm ecosystem",
      );
    if (
      JSON.stringify(this.config.platform) !==
      JSON.stringify(request.identity.platform)
    )
      throw new DependencyProvisioningError(
        "provisioning platform does not match dependency identity",
      );
    const work = await mkdtemp(join(this.config.buildRoot, "pnpm-provision-"));
    const artifact = createDependencyArtifact(request.identity, {
      artifactReference: dependencyArtifactId(request.identity),
    });
    const target = join(this.config.artifactRoot, artifact.artifactId);
    try {
      await writeFile(join(work, "package.json"), request.packageJson, "utf8");
      await writeFile(join(work, "pnpm-lock.yaml"), request.lockfile, "utf8");
      await runPnpm(
        this.config.pnpmExecutable,
        this.config.pnpmExecutableArgs ?? [],
        work,
        this.config.environment,
        this.config.allowNetworkDuringBuild,
        this.config.timeoutMs ?? 120_000,
        this.config.maxOutputBytes ?? 16 * 1024 * 1024,
      );
      const dependencies = join(work, "node_modules");
      if (!(await lstat(dependencies)).isDirectory())
        throw new DependencyProvisioningError(
          "pnpm produced no node_modules artifact",
        );
      await mkdir(this.config.artifactRoot, { recursive: true });
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      await cp(dependencies, join(target, "node_modules"), {
        recursive: true,
        dereference: true,
      });
      const artifactContentHash = await artifactDirectoryContentHash(target);
      return createDependencyArtifact(request.identity, {
        artifactContentHash,
        artifactReference: artifact.artifactId,
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
}

export function dependencyProvisioningEvidenceInput(
  environment: DependencyEnvironment,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "dependency.environment",
    artifactId: environment.artifactId,
    contentHash: environment.contentHash,
    sourceSnapshotId: environment.sourceSnapshotId,
    platform: environment.platform,
    availability: environment.availability,
    generatedArtifactInputs: [...environment.generatedArtifactInputs],
  });
}

export async function readArtifactFile(
  root: string,
  artifactId: string,
  path: string,
): Promise<Buffer> {
  requireIdentifier(artifactId, "artifactId");
  if (
    path.includes("\\") ||
    path.startsWith("/") ||
    path.split("/").includes("..")
  )
    throw new DependencyProvisioningError("artifact file path is unsafe");
  const file = resolve(root, artifactId, path);
  if (!confined(resolve(root, artifactId), file))
    throw new DependencyProvisioningError("artifact file escapes store");
  return readFile(file);
}

export type DependencySnapshotId = RepositorySnapshotId;
