import { describe, expect, it } from "vitest";
import { SubprocessSandboxTransport } from "../packages/engine/src/index.js";
import type { PublicSandboxJobRequest } from "../packages/engine/src/index.js";

const executable = process.env.VERIFY_SANDBOX_PROCESS;
const snapshotRoot = process.env.VERIFY_SANDBOX_SNAPSHOT_ROOT;
const dockerExecutable = process.env.VERIFY_SANDBOX_DOCKER_EXECUTABLE;
const dockerHost = process.env.VERIFY_SANDBOX_DOCKER_HOST;
const systemRoot = process.env.VERIFY_SANDBOX_SYSTEM_ROOT;
const tempRoot = process.env.VERIFY_SANDBOX_TEMP_ROOT;
const integrationReady = Boolean(
  executable &&
  snapshotRoot &&
  dockerExecutable &&
  dockerHost &&
  systemRoot &&
  tempRoot,
);
const stellarForgeIntegration =
  integrationReady && process.env.VERIFY_STELLAR_FORGE_INTEGRATION === "1";

describe("real verify-sandbox process boundary", () => {
  it.skipIf(!integrationReady)(
    executable
      ? "performs one protocol handshake without downgrading provenance"
      : "SKIPPED — VERIFY_SANDBOX_PROCESS is not configured",
    async () => {
      const request: PublicSandboxJobRequest = {
        schemaVersion: "1.0.0",
        jobId: "integration-handshake-1",
        source: { provider: "fixture", reference: "batch-9-handshake" },
        snapshot: "execution",
        commands: [
          JSON.stringify({
            executable: "cargo",
            args: ["--version"],
            workingDirectory: ".",
            environment: {},
          }),
        ],
        resourceLimits: {
          timeoutMs: 10_000,
          memoryLimitBytes: 256 * 1024 * 1024,
        },
        networkPolicy: "none",
        artifactPolicy: "none",
      };
      const transport = new SubprocessSandboxTransport({
        executable,
        environment: {
          VERIFY_SANDBOX_SNAPSHOT_ROOT: snapshotRoot,
          VERIFY_SANDBOX_DOCKER_EXECUTABLE: dockerExecutable,
          VERIFY_SANDBOX_DOCKER_HOST: dockerHost,
          VERIFY_SANDBOX_SYSTEM_ROOT: systemRoot,
          VERIFY_SANDBOX_TEMP_ROOT: tempRoot,
        },
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 15_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const result = await transport.execute(request);
      expect(transport.executionSource).toBe("real");
      expect(result).toMatchObject({
        schemaVersion: "1.0.0",
        jobId: request.jobId,
        status: "completed",
        exitCode: 0,
      });
    },
  );

  it.skipIf(!integrationReady)(
    executable
      ? "preserves a real non-zero command failure"
      : "SKIPPED — VERIFY_SANDBOX_PROCESS is not configured",
    async () => {
      const transport = new SubprocessSandboxTransport({
        executable,
        environment: {
          VERIFY_SANDBOX_SNAPSHOT_ROOT: snapshotRoot,
          VERIFY_SANDBOX_DOCKER_EXECUTABLE: dockerExecutable,
          VERIFY_SANDBOX_DOCKER_HOST: dockerHost,
          VERIFY_SANDBOX_SYSTEM_ROOT: systemRoot,
          VERIFY_SANDBOX_TEMP_ROOT: tempRoot,
        },
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 15_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const result = await transport.execute({
        schemaVersion: "1.0.0",
        jobId: "integration-failure-1",
        source: { provider: "fixture", reference: "batch-9-failure" },
        snapshot: "execution",
        commands: [
          JSON.stringify({
            executable: "cargo",
            args: ["--definitely-invalid-verify-agent-argument"],
            workingDirectory: ".",
            environment: {},
          }),
        ],
        resourceLimits: {
          timeoutMs: 10_000,
          memoryLimitBytes: 256 * 1024 * 1024,
        },
        networkPolicy: "none",
        artifactPolicy: "none",
      });
      expect(transport.executionSource).toBe("real");
      expect(result.status).toBe("completed");
      expect(result.exitCode).not.toBe(0);
    },
  );

  it.skipIf(!stellarForgeIntegration)(
    stellarForgeIntegration
      ? "executes exactly one Stellar Forge typecheck through the real sandbox"
      : "SKIPPED — VERIFY_STELLAR_FORGE_INTEGRATION=1 is required",
    async () => {
      const transport = new SubprocessSandboxTransport({
        executable,
        environment: {
          VERIFY_SANDBOX_SNAPSHOT_ROOT: snapshotRoot,
          VERIFY_SANDBOX_DOCKER_EXECUTABLE: dockerExecutable,
          VERIFY_SANDBOX_DOCKER_HOST: dockerHost,
          VERIFY_SANDBOX_SYSTEM_ROOT: systemRoot,
          VERIFY_SANDBOX_TEMP_ROOT: tempRoot,
        },
        startupTimeoutMs: 2_000,
        requestTimeoutMs: 120_000,
        maxMessageBytes: 1024 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const result = await transport.execute({
        schemaVersion: "1.0.0",
        jobId: "stellar-forge-typecheck-1",
        source: { provider: "local-snapshot", reference: "stellar-forge" },
        snapshot: "stellar-forge-dogfood",
        commands: [
          JSON.stringify({
            executable: "pnpm",
            args: ["exec", "tsc", "--noEmit"],
            workingDirectory: ".",
            environment: {},
          }),
        ],
        resourceLimits: {
          timeoutMs: 120_000,
          memoryLimitBytes: 512 * 1024 * 1024,
        },
        networkPolicy: "none",
        artifactPolicy: "none",
      });
      console.log("STELLAR_FORGE_REAL_RESULT", JSON.stringify(result));
      expect(transport.executionSource).toBe("real");
      expect(result.jobId).toBe("stellar-forge-typecheck-1");
    },
    130_000,
  );
});
