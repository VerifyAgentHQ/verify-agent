import type { RepositorySnapshot } from "./source.js";

export type SourceContents = Readonly<Record<string, string>>;

export interface ResolvedSource {
  readonly snapshot: RepositorySnapshot;
  readonly sourceContents: SourceContents;
}

export class InvalidSourceReferenceError extends Error {
  constructor(
    message = "invalid source reference",
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "InvalidSourceReferenceError";
    if (options?.cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = options.cause;
    }
  }
}

export interface SnapshotSourceReference {
  readonly kind: "snapshot";
  readonly id: string;
}

export interface SourceResolver {
  resolveSnapshot(source: SnapshotSourceReference): Promise<ResolvedSource>;
}
