export type {
  ChangeSetLike,
  RepositoryMetadata,
  SourceProvider,
  SourceState,
  SourceContext,
} from "./types.js";
export type {
  ResolvedSource,
  SourceContents,
  SourceResolver,
} from "./resolver.js";
export { InvalidSourceReferenceError } from "./resolver.js";
export type {
  GitHubFixture,
  GitHubSnapshotReference,
  GitHubSourceProvider,
} from "./github.js";
export {
  DEFAULT_GITHUB_FIXTURE_CONTENTS,
  createGitHubRepositorySnapshot,
  createGitHubSourceResolver,
  createInMemoryGitHubSourceProvider,
  createSingleGitHubFixtureProvider,
  decodeGitHubSnapshotReference,
  encodeGitHubSnapshotReference,
  validateGitHubSnapshotReference,
} from "./github.js";
