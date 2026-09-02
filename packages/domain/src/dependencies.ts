import type { Provenance } from "./provenance.js";
import type { RepositorySnapshotId } from "./identifiers.js";

export type DependencyEcosystem = "node" | "rust";
export type DependencyAvailability =
  "offline_capable" | "network_required" | "unavailable";

export type DependencyOperatingSystem = "linux" | "windows" | "darwin";
export type DependencyArchitecture = "amd64" | "arm64";

/** Runtime identity required for portable dependency artifacts. */
export interface DependencyPlatform {
  readonly operatingSystem: DependencyOperatingSystem;
  readonly architecture: DependencyArchitecture;
}

/** Stable inputs used to identify a dependency environment. */
export interface DependencyIdentityInput {
  readonly snapshotId: RepositorySnapshotId;
  readonly manifestHash: string;
  readonly lockfileHash: string;
  readonly ecosystem: DependencyEcosystem;
  readonly packageManager: string;
  readonly packageManagerVersion: string;
  readonly toolchainVersion: string;
  readonly platform: DependencyPlatform;
  readonly provisioningConfig: Readonly<Record<string, string>>;
  readonly generatedArtifactInputs: readonly string[];
}

export interface DependencyArtifact {
  readonly artifactId: string;
  readonly sourceSnapshotId: RepositorySnapshotId;
  readonly ecosystem: DependencyEcosystem;
  readonly packageManager: string;
  readonly packageManagerVersion: string;
  readonly toolchainVersion: string;
  readonly platform: DependencyPlatform;
  readonly manifestHash: string;
  readonly lockfileHash: string;
  readonly generatedArtifactInputs: readonly string[];
  readonly availability: DependencyAvailability;
  readonly contentHash: string;
  /** Hash of the materialized artifact contents. */
  readonly artifactContentHash?: string;
  /** Opaque reference resolved by the trusted artifact store. */
  readonly artifactReference?: string;
  readonly producer: Provenance;
}

export interface DependencyProvisioningRequest {
  readonly identity: DependencyIdentityInput;
  readonly artifact: DependencyArtifact;
  readonly offlineOnly: boolean;
}

export interface DependencyEnvironment {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly sourceSnapshotId: RepositorySnapshotId;
  readonly platform: DependencyPlatform;
  readonly availability: "offline_capable";
  readonly generatedArtifactInputs: readonly string[];
  readonly producer: Provenance;
}

export type GeneratedArtifactPreparationStrategy =
  "none" | "fixture" | "prebuilt_artifact" | "trusted_command";

export interface GeneratedArtifactRequirement {
  readonly id: string;
  readonly name: string;
  readonly strategy: GeneratedArtifactPreparationStrategy;
  readonly required: boolean;
  readonly inputHashes: readonly string[];
  readonly outputPaths: readonly string[];
}

export interface GeneratedArtifact {
  readonly id: string;
  readonly requirementId: string;
  readonly sourceSnapshotId: RepositorySnapshotId;
  readonly contentHash: string;
  readonly inputHash: string;
  readonly artifactReference: string;
  readonly outputPaths: readonly string[];
  readonly producer: Provenance;
}

export interface GeneratedArtifactSet {
  readonly artifacts: readonly GeneratedArtifact[];
  readonly contentHash: string;
}
