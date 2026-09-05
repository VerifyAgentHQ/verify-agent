export type {
  EngineContext,
  VerificationOrchestrator,
  ProjectDetector,
  CheckPlanner,
  ResultAssembler,
  SandboxExecutor,
  SandboxJobRequest,
  SandboxJobResult,
  SandboxCommand,
  SandboxStatus,
  ExecutionLimits,
  PublicSandboxJobRequest,
  PublicSandboxJobResult,
  SandboxTransport,
  SandboxTransportEvent,
  SandboxTransportObserver,
  CheckExecutionRequest,
  CheckExecutionOutcome,
  CheckExecutor,
  ExecutionEnvironment,
  DependencyProvisioningPort,
  ProvisioningStatus,
} from "./interfaces.js";
export type { GeneratedArtifact } from "@verify-agent/domain";
export { createEngine } from "./runtime.js";
export { DEFAULT_EXECUTION_LIMITS } from "./interfaces.js";
export {
  createCheckExecutor,
  createExecutionInputHash,
  createFakeSandboxExecutor,
  mapCheckExecutionToSandboxJobRequest,
  mapSandboxJobResultToCheckResult,
  toPublicSandboxJobRequest,
  transitionCheckExecution,
} from "./execution.js";
export {
  FakeSandboxTransport,
  SandboxProtocolError,
  SandboxTransportError,
  SubprocessSandboxTransport,
  createSandboxExecutorFromTransport,
  validateSandboxJobRequest,
  validateSandboxJobResult,
} from "./sandbox-transport.js";
export type { SandboxProcessConfig } from "./sandbox-transport.js";
export {
  createDefaultVerificationPipeline,
  createVerificationPipeline,
  VerificationPipelineError,
} from "./pipeline.js";
export {
  VerificationApplicationService,
  VerificationApplicationServiceError,
} from "./application-service.js";
export type {
  VerifyRepositorySnapshotRequest,
  VerifySourceRequest,
} from "./application-service.js";
export { createInMemoryVerificationJobQueue } from "./in-memory-job-queue.js";
export type { InMemoryVerificationJobQueue } from "./in-memory-job-queue.js";
export {
  aggregateVerification,
  aggregationInputFromPipeline,
  coverageForPlan,
  evidenceForCheckResult,
  findingsForCheckResults,
} from "./aggregation.js";
export {
  PnpmDependencyArtifactBuilder,
  DependencyProvisioningError,
  OfflineDependencyProvisioner,
  artifactDirectoryContentHash,
  createDependencyArtifact,
  dependencyArtifactContentHash,
  dependencyArtifactId,
  dependencyProvisioningEvidenceInput,
  readArtifactFile,
  validateDependencyArtifact,
  validateDependencyPlatform,
} from "./dependency-provisioning.js";
export {
  PrebuiltGeneratedArtifactPreparer,
  createGeneratedArtifactSet,
  generatedArtifactId,
  generatedArtifactInputHash,
  generatedArtifactSetHash,
  removeMaterializedGeneratedArtifacts,
} from "./generated-artifacts.js";
export type {
  GeneratedArtifactPreparer,
  PrebuiltGeneratedArtifactPreparerConfig,
} from "./generated-artifacts.js";
export {
  ExecutionEnvironmentMaterializer,
  materializationIdentity,
  materializedSourceRelativePath,
  removeMaterializedEnvironment,
} from "./environment-materializer.js";
export type {
  ExecutionEnvironmentMaterializationRequest,
  ExecutionEnvironmentMaterializationResult,
} from "./environment-materializer.js";
export type {
  PnpmDependencyArtifactBuildRequest,
  PnpmDependencyArtifactBuilderConfig,
} from "./dependency-provisioning.js";
export type {
  VerificationAggregationInput,
  VerificationAggregationOutput,
} from "./aggregation.js";
export type {
  ProjectDetectionPort,
  VerificationPipeline,
  VerificationPipelineDependencies,
  VerificationPipelineInput,
  VerificationPipelineOutput,
} from "./pipeline.js";
export type { DetectionContext } from "./pipeline-types.js";
