import { createHash, randomUUID } from "node:crypto";
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
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function sameProvisioningConfig(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  return hash(left) === hash(right);
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

/**
 * Batch 56C-R1 — trusted artifact metadata (Codex finding 2).
 *
 * The build stage (`PnpmDependencyArtifactBuilder`) persists the exact
 * `DependencyArtifact` it produced — including the `artifactContentHash` of the
 * materialized contents — next to the artifact payload under the trusted
 * artifact root. The runtime reads that metadata, so it never has to trust an
 * `artifactId`-shaped directory on its own: a directory whose contents do not
 * hash to the trusted value is rejected before any copy.
 *
 * The metadata file is a sibling of the payload directory
 * (`<root>/<artifactId>.artifact.json`), never inside it, so it is neither part
 * of the hashed contents nor copied into a composed snapshot.
 */
export function dependencyArtifactMetadataPath(
  artifactRoot: string,
  artifactId: string,
): string {
  requireIdentifier(artifactId, "artifactId");
  if (!isAbsolute(artifactRoot))
    throw new DependencyProvisioningError(
      "artifact root must be an absolute path",
    );
  return join(artifactRoot, `${artifactId}.artifact.json`);
}

/** Persists trusted artifact metadata atomically (temp file + rename). */
export async function writeDependencyArtifactMetadata(
  artifactRoot: string,
  artifact: DependencyArtifact,
): Promise<void> {
  validateDependencyArtifact(artifact);
  if (artifact.artifactContentHash === undefined)
    throw new DependencyProvisioningError(
      "trusted artifact metadata requires artifactContentHash",
    );
  const target = dependencyArtifactMetadataPath(
    artifactRoot,
    artifact.artifactId,
  );
  await mkdir(artifactRoot, { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  await rename(temporary, target);
}

/**
 * Reads trusted artifact metadata for an exact artifact identity. Returns
 * `undefined` when no metadata is published; malformed, indirect, or identity
 * mismatching metadata fails closed rather than degrading to a weaker check.
 */
export async function readDependencyArtifactMetadata(
  artifactRoot: string,
  artifactId: string,
): Promise<DependencyArtifact | undefined> {
  const target = dependencyArtifactMetadataPath(artifactRoot, artifactId);
  let raw: string;
  try {
    const status = await lstat(target);
    if (status.isSymbolicLink() || !status.isFile())
      throw new DependencyProvisioningError(
        "dependency artifact metadata is not a regular file",
      );
    raw = await readFile(target, "utf8");
  } catch (error) {
    if (error instanceof DependencyProvisioningError) throw error;
    if ((error as { code?: unknown } | null)?.code === "ENOENT")
      return undefined;
    throw new DependencyProvisioningError(
      "dependency artifact metadata is unavailable",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DependencyProvisioningError(
      "dependency artifact metadata is malformed",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new DependencyProvisioningError(
      "dependency artifact metadata is malformed",
    );
  const artifact = parsed as DependencyArtifact;
  if (artifact.artifactId !== artifactId)
    throw new DependencyProvisioningError(
      "dependency artifact metadata identity mismatch",
    );
  if (
    !Array.isArray(artifact.generatedArtifactInputs) ||
    artifact.platform === null ||
    typeof artifact.platform !== "object" ||
    artifact.producer === null ||
    typeof artifact.producer !== "object"
  )
    throw new DependencyProvisioningError(
      "dependency artifact metadata is malformed",
    );
  if (
    artifact.provisioningConfig !== undefined &&
    (artifact.provisioningConfig === null ||
      typeof artifact.provisioningConfig !== "object" ||
      Array.isArray(artifact.provisioningConfig))
  )
    throw new DependencyProvisioningError(
      "dependency provisioning configuration is malformed",
    );
  try {
    validateDependencyArtifact(artifact);
  } catch (error) {
    if (error instanceof DependencyProvisioningError) throw error;
    throw new DependencyProvisioningError(
      "dependency artifact metadata is malformed",
    );
  }
  if (artifact.artifactContentHash === undefined)
    throw new DependencyProvisioningError(
      "dependency artifact metadata requires artifactContentHash",
    );
  return Object.freeze({
    ...artifact,
    generatedArtifactInputs: Object.freeze([
      ...artifact.generatedArtifactInputs,
    ]),
  });
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

export function validateDependencyProvisioningRequest(
  request: DependencyProvisioningRequest,
): void {
  validateDependencyArtifact(request.artifact);
  const identity = request.identity;
  const artifact = request.artifact;
  // Batch 56C — complete identity binding. The artifact ID alone is
  // insufficient: a malformed artifact could carry the correct ID with
  // inconsistent metadata. Every identity-bearing field exposed by the
  // artifact format is compared against the request identity using the
  // single canonical content-hash algorithm (no second identity scheme).
  if (artifact.sourceSnapshotId !== identity.snapshotId) {
    throw new DependencyProvisioningError(
      "dependency source snapshot mismatch",
    );
  }
  if (artifact.manifestHash !== identity.manifestHash) {
    throw new DependencyProvisioningError("dependency manifest hash mismatch");
  }
  if (artifact.lockfileHash !== identity.lockfileHash) {
    throw new DependencyProvisioningError("dependency lockfile hash mismatch");
  }
  if (artifact.ecosystem !== identity.ecosystem) {
    throw new DependencyProvisioningError("dependency ecosystem mismatch");
  }
  if (artifact.packageManager !== identity.packageManager) {
    throw new DependencyProvisioningError(
      "dependency package manager mismatch",
    );
  }
  if (artifact.packageManagerVersion !== identity.packageManagerVersion) {
    throw new DependencyProvisioningError(
      "dependency package manager version mismatch",
    );
  }
  if (artifact.toolchainVersion !== identity.toolchainVersion) {
    throw new DependencyProvisioningError("dependency toolchain mismatch");
  }
  if (
    artifact.provisioningConfig !== undefined &&
    !sameProvisioningConfig(
      artifact.provisioningConfig,
      identity.provisioningConfig,
    )
  ) {
    throw new DependencyProvisioningError(
      "dependency provisioning configuration mismatch",
    );
  }
  if (
    artifact.platform.operatingSystem !== identity.platform.operatingSystem ||
    artifact.platform.architecture !== identity.platform.architecture
  ) {
    throw new DependencyProvisioningError("dependency platform mismatch");
  }
  const identityGenerated = [...identity.generatedArtifactInputs].sort();
  const artifactGenerated = [...artifact.generatedArtifactInputs].sort();
  if (
    identityGenerated.length !== artifactGenerated.length ||
    identityGenerated.some((entry, index) => entry !== artifactGenerated[index])
  ) {
    throw new DependencyProvisioningError(
      "dependency generated inputs mismatch",
    );
  }
  // `provisioningConfig` has no dedicated artifact field; it participates
  // in the canonical content hash, so a config difference surfaces here.
  // Checking the canonical hash (not the filename/path) keeps artifact
  // selection bound to validated identity beneath the configured root.
  const expectedContentHash = dependencyArtifactContentHash(identity);
  if (artifact.contentHash !== expectedContentHash) {
    throw new DependencyProvisioningError("dependency content hash mismatch");
  }
  if (artifact.artifactId !== dependencyArtifactId(identity)) {
    throw new DependencyProvisioningError(
      "dependency artifact identity mismatch",
    );
  }
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
    provisioningConfig: Object.freeze({ ...input.provisioningConfig }),
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

/**
 * Canonical content hash over a directory tree (or, when `entries` is given,
 * over exactly those top-level entries of `root`). Sorted relative paths plus
 * sha256 of file contents; symlinks and unsafe entries are rejected; no
 * filesystem timestamps participate. Hashing a set of top-level entries is
 * byte-identical to hashing a directory that contains exactly those entries,
 * which lets the final composed dependency subtree be verified at its final
 * location against the same trusted hash.
 */
async function hashArtifactTree(
  root: string,
  entries: readonly string[] | undefined,
  limits: { readonly maxBytes?: number; readonly maxFiles?: number },
): Promise<string> {
  const maxBytes = limits.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const maxFiles = limits.maxFiles ?? 100_000;
  const files: { path: string; hash: string; size: number }[] = [];
  let totalBytes = 0;
  const readEntry = async (path: string): Promise<void> => {
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
  };
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
      else if (entry.isFile()) await readEntry(path);
      else
        throw new DependencyProvisioningError(
          "unsupported dependency artifact entry",
        );
    }
  }
  const names =
    entries === undefined
      ? (await readdir(root, { withFileTypes: true }))
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b))
      : [...entries].sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const path = join(root, name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink())
      throw new DependencyProvisioningError(
        "dependency artifact symlink rejected",
      );
    if (metadata.isDirectory()) await visit(path);
    else if (metadata.isFile()) await readEntry(path);
    else
      throw new DependencyProvisioningError(
        "unsupported dependency artifact entry",
      );
  }
  return hash(files);
}

export async function artifactDirectoryContentHash(
  root: string,
  limits: { readonly maxBytes?: number; readonly maxFiles?: number } = {},
): Promise<string> {
  return hashArtifactTree(root, undefined, limits);
}

/**
 * Batch 56C-R3 — hashes exactly the named top-level entries of `root`. Used to
 * verify the copied dependency subtree at its final composed-staging location
 * without including the composed source files.
 */
export async function artifactEntriesContentHash(
  root: string,
  entries: readonly string[],
  limits: { readonly maxBytes?: number; readonly maxFiles?: number } = {},
): Promise<string> {
  return hashArtifactTree(root, entries, limits);
}

function confined(root: string, candidate: string): boolean {
  const base = resolve(root);
  const target = resolve(candidate);
  const suffix = relative(base, target);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== "..");
}

async function pathIsDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function isRenameConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "EEXIST" ||
    code === "ENOTEMPTY" ||
    code === "EPERM" ||
    code === "EACCES" ||
    code === "EISDIR" ||
    code === "ENOTDIR"
  );
}

/**
 * Batch 56C-R2 — atomic trusted-artifact publication.
 *
 * The trusted build stage materializes its artifact into a unique staging
 * directory and only then publishes it with a single atomic rename to a path
 * that does not exist yet, so a concurrent runtime can never resolve a
 * partially built artifact directory. This is deliberately the same
 * first-writer-wins contract already used for composed snapshots: on a lost
 * race the loser accepts only a byte-identical tree, and a conflicting tree
 * fails closed rather than overwriting a published artifact.
 *
 * Returns `true` when this call published the artifact, `false` when an
 * already published identical artifact was reused.
 */
export async function publishArtifactDirectoryAtomically(
  staging: string,
  destination: string,
): Promise<boolean> {
  if (await pathIsDirectory(destination)) {
    const [staged, existing] = await Promise.all([
      artifactDirectoryContentHash(staging),
      artifactDirectoryContentHash(destination),
    ]);
    if (staged !== existing)
      throw new DependencyProvisioningError(
        "dependency artifact identity already holds different contents",
      );
    return false;
  }
  try {
    await rename(staging, destination);
    return true;
  } catch (error) {
    if (!isRenameConflict(error)) throw error;
    if (!(await pathIsDirectory(destination)))
      throw new DependencyProvisioningError(
        "dependency artifact publication failed",
      );
    const [staged, existing] = await Promise.all([
      artifactDirectoryContentHash(staging),
      artifactDirectoryContentHash(destination),
    ]);
    if (staged !== existing)
      throw new DependencyProvisioningError(
        "dependency artifact identity already holds different contents",
      );
    return false;
  }
}

/**
 * Minimal offline fixture adapter. It materializes prebuilt artifacts only;
 * it never invokes a package manager, installer, script, or network.
 */
export interface OfflineDependencyProvisionerOptions {
  /**
   * Batch 56C-R1 — production artifacts must carry a trusted
   * `artifactContentHash`; without one there is no way to prove the directory
   * contents correspond to the trusted artifact, so provisioning fails closed.
   */
  readonly requireArtifactContentHash?: boolean;
  /**
   * Batch 56C-R2 — deterministic test/observability hook invoked after the
   * pre-copy content validation and immediately before the artifact bytes are
   * copied. Used to simulate a TOCTOU mutation of the artifact source between
   * validation and copy without relying on arbitrary timing.
   */
  readonly beforeCopy?: () => void | Promise<void>;
  /**
   * Batch 56C-R2 — deterministic test/observability hook invoked after the
   * artifact bytes have been copied into the isolated verification subtree
   * but before the copied bytes are hashed. Receives the copied subtree path
   * so a test can deterministically mutate the copied bytes and prove the
   * post-copy content check rejects them.
   */
  readonly afterCopy?: (copiedDirectory: string) => void | Promise<void>;
  /**
   * Batch 56C-R3 — deterministic test/observability hook invoked after the
   * verified scratch subtree has been hashed but before it is atomically
   * moved into the composed staging tree (Codex case C: mutation after
   * scratch verification but before final placement).
   */
  readonly afterScratchVerified?: (
    scratchDirectory: string,
  ) => void | Promise<void>;
  /**
   * Batch 56C-R3 — deterministic test/observability hook invoked after the
   * verified dependency entries have been atomically moved into the composed
   * staging tree but before the final-location content hash (Codex case D:
   * mutation at the final composed location before final hashing). Receives
   * the composed destination, the now-emptied scratch directory, and the moved
   * top-level entry names, so a test can both mutate the final subtree and
   * observe that the transfer emptied the scratch (a move, not a copy).
   */
  readonly afterDependencyTransfer?: (transfer: {
    readonly scratchDirectory: string;
    readonly destination: string;
    readonly entries: readonly string[];
  }) => void | Promise<void>;
}

export class OfflineDependencyProvisioner {
  constructor(
    private readonly artifactRoot: string,
    private readonly expectedPlatform?: DependencyPlatform,
    private readonly options: OfflineDependencyProvisionerOptions = {},
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
    // Batch 56C — complete identity binding before any copy. Validates
    // every identity-bearing field via the canonical content-hash helpers;
    // filename/path agreement alone never authorizes a copy. Fail closed.
    validateDependencyProvisioningRequest(request);
    if (!request.offlineOnly)
      throw new DependencyProvisioningError(
        "offline provisioning must be explicit",
      );
    if (request.artifact.availability !== "offline_capable")
      throw new DependencyProvisioningError(
        "dependency artifact is unavailable offline",
      );
    if (
      this.options.requireArtifactContentHash === true &&
      request.artifact.artifactContentHash === undefined
    )
      throw new DependencyProvisioningError(
        "dependency artifact content hash is required",
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
      const trustedContentHash = request.artifact.artifactContentHash;
      if (trustedContentHash !== undefined) {
        const actual = await artifactDirectoryContentHash(source);
        if (actual !== trustedContentHash)
          throw new DependencyProvisioningError(
            "dependency artifact integrity mismatch",
          );
      }
      if (request.artifact.platform.operatingSystem === "linux")
        await rejectWindowsLauncherPaths(source);
      await mkdir(destination, { recursive: true });
      // Batch 56C-R2 — the artifact directory can be mutated between the
      // validation above and the copy below, so a trusted artifact is not
      // copied straight into the composed tree: it is copied into an isolated
      // verification subtree whose actual bytes are re-hashed and compared to
      // the trusted content hash before any of those bytes are merged into the
      // composed tree. Without a trusted content hash there is nothing to
      // verify, so the historical direct copy is preserved.
      if (trustedContentHash === undefined) {
        await cp(source, destination, { recursive: true, errorOnExist: false });
      } else {
        await this.transferVerifiedDependency(
          source,
          destination,
          trustedContentHash,
        );
      }
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

  /**
   * Batch 56C-R3 — verified atomic dependency transfer.
   *
   * The trusted artifact is copied once into an isolated scratch subtree
   * (a sibling of the composed destination, so on the same filesystem), the
   * *copied* bytes are hashed and compared to the trusted content hash, and
   * only then is each verified top-level entry moved into the composed staging
   * tree with an atomic `rename`. There is no recursive copy after the
   * verification, so the bytes that are published are exactly the bytes that
   * were verified. Finally the dependency subtree is re-hashed at its final
   * composed-staging location and must still match, so a mutation after the
   * move is also rejected. Any mismatch fails closed and the scratch tree is
   * removed on every path.
   */
  private async transferVerifiedDependency(
    source: string,
    destination: string,
    trustedContentHash: string,
  ): Promise<void> {
    await this.options.beforeCopy?.();
    const scratch = await mkdtemp(join(dirname(destination), ".dependency-"));
    try {
      // 1. Single untrusted copy, immediately verified below by hashing the
      // copied bytes themselves (Codex cases A and B).
      await cp(source, scratch, { recursive: true, errorOnExist: false });
      await this.options.afterCopy?.(scratch);
      const copied = await artifactDirectoryContentHash(scratch);
      if (copied !== trustedContentHash)
        throw new DependencyProvisioningError(
          "copied dependency artifact integrity mismatch",
        );
      // 2. Codex case C: verify, then move atomically. No ordinary recursive
      // copy may occur after this point.
      await this.options.afterScratchVerified?.(scratch);
      const entries = (await readdir(scratch)).sort((a, b) =>
        a.localeCompare(b),
      );
      for (const entry of entries) {
        const from = join(scratch, entry);
        const to = join(destination, entry);
        // A genuine top-level conflict cannot be composed without changing the
        // verified dependency bytes, so it fails closed instead of merging.
        if (await pathExists(to))
          throw new DependencyProvisioningError(
            "dependency compose path conflict",
          );
        await rename(from, to);
      }
      await this.options.afterDependencyTransfer?.({
        scratchDirectory: scratch,
        destination,
        entries,
      });
      // 3. Codex case D: verify the dependency subtree again at its final
      // composed-staging location, before the composed tree is validated and
      // atomically published.
      const placed = await artifactEntriesContentHash(destination, entries);
      if (placed !== trustedContentHash)
        throw new DependencyProvisioningError(
          "composed dependency artifact integrity mismatch",
        );
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
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
      // Batch 56C-R2 — build into a unique staging directory, verify its
      // contents, then publish it with a single atomic rename. A concurrent
      // runtime can never resolve a partially built artifact directory.
      const staging = await mkdtemp(
        join(this.config.artifactRoot, ".staging-"),
      );
      try {
        await cp(dependencies, join(staging, "node_modules"), {
          recursive: true,
          dereference: true,
        });
        const artifactContentHash = await artifactDirectoryContentHash(staging);
        const trusted = createDependencyArtifact(request.identity, {
          artifactContentHash,
          artifactReference: artifact.artifactId,
        });
        await publishArtifactDirectoryAtomically(staging, target);
        // Persist the trusted metadata only once the exact artifact contents
        // are published, so the runtime can verify the actual directory
        // contents before copying them.
        await writeDependencyArtifactMetadata(
          this.config.artifactRoot,
          trusted,
        );
        return trusted;
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
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
