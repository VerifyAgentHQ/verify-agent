import { createHash } from "node:crypto";
import type {
  DependencyIdentityInput,
  DependencyPlatform,
  RepositorySnapshotId,
  SourceContents,
} from "@verify-agent/domain";

/**
 * Batch 56C — trusted dependency-identity derivation for production
 * materialization.
 *
 * Derives the canonical `DependencyIdentityInput` from exact resolved
 * source bytes (`package.json` + `pnpm-lock.yaml`) bound to the exact
 * snapshot identity. The artifact selected from this identity is later
 * validated field-by-field (`validateDependencyProvisioningRequest`) and
 * composed into the sandbox-visible snapshot via the existing
 * `ExecutionEnvironmentMaterializer` (no protocol change, no host install,
 * no network, `artifactPolicy` stays `"none"`).
 *
 * Trusted constants match the approved Linux amd64 runner
 * (Node 24.19.0, pnpm 11.21.0, offline) used by the existing
 * `OfflineDependencyProvisioner` production wiring. Returns `undefined`
 * when the source has no Node/pnpm manifest pair (e.g. Rust-only
 * revisions): historical source-only behavior is preserved, never a silent
 * host install.
 */

export const TRUSTED_DEPENDENCY_PLATFORM: DependencyPlatform = Object.freeze({
  operatingSystem: "linux",
  architecture: "amd64",
});

export const TRUSTED_PNPM_VERSION = "11.21.0";
export const TRUSTED_NODE_TOOLCHAIN_VERSION = "node-24.19.0";
export const TRUSTED_PROVISIONING_CONFIG: Readonly<Record<string, string>> =
  Object.freeze({ offline: "true", nodeLinker: "hoisted" });

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface DependencyIdentityDerivationOptions {
  readonly platform?: DependencyPlatform;
  readonly packageManagerVersion?: string;
  readonly toolchainVersion?: string;
  readonly provisioningConfig?: Readonly<Record<string, string>>;
  readonly generatedArtifactInputs?: readonly string[];
}

export function deriveNodeDependencyIdentity(
  snapshotId: RepositorySnapshotId,
  sourceContents: SourceContents,
  options: DependencyIdentityDerivationOptions = {},
): DependencyIdentityInput | undefined {
  const manifest = sourceContents["package.json"];
  const lockfile = sourceContents["pnpm-lock.yaml"];
  if (typeof manifest !== "string" || typeof lockfile !== "string") {
    return undefined;
  }
  if (manifest.length === 0 || lockfile.length === 0) return undefined;
  return Object.freeze({
    snapshotId,
    manifestHash: sha256Hex(manifest),
    lockfileHash: sha256Hex(lockfile),
    ecosystem: "node",
    packageManager: "pnpm",
    packageManagerVersion:
      options.packageManagerVersion ?? TRUSTED_PNPM_VERSION,
    toolchainVersion:
      options.toolchainVersion ?? TRUSTED_NODE_TOOLCHAIN_VERSION,
    platform: options.platform ?? TRUSTED_DEPENDENCY_PLATFORM,
    provisioningConfig: Object.freeze({
      ...(options.provisioningConfig ?? TRUSTED_PROVISIONING_CONFIG),
    }),
    generatedArtifactInputs: Object.freeze([
      ...(options.generatedArtifactInputs ?? []),
    ]),
  }) as DependencyIdentityInput;
}
