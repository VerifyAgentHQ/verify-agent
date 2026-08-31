import { describe, expect, it } from "vitest";
import { SubprocessSandboxTransport } from "../packages/engine/src/index.js";
import type { PublicSandboxJobRequest } from "../packages/engine/src/index.js";

const executable = process.env.VERIFY_SANDBOX_PROCESS;

describe("real verify-sandbox process boundary", () => {
  it.skipIf(!executable)(
    executable
      ? "performs one protocol handshake without downgrading provenance"
      : "SKIPPED — VERIFY_SANDBOX_PROCESS is not configured",
    async () => {
      const request: PublicSandboxJobRequest = {
        schemaVersion: "1.0.0",
        jobId: "integration-handshake-1",
        source: { provider: "fixture", reference: "batch-9-handshake" },
        snapshot: "fixture-snapshot",
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
      });
      if (result.status === "error") {
        expect(result.errors.join(" ")).not.toHaveLength(0);
      }
    },
  );
});
