import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { brandId } from "../packages/domain/src/index.js";
import {
  FakeSandboxTransport,
  SandboxProtocolError,
  SandboxTransportError,
  SubprocessSandboxTransport,
  createSandboxExecutorFromTransport,
  validateSandboxJobRequest,
  validateSandboxJobResult,
} from "../packages/engine/src/index.js";
import type {
  SandboxJobRequest,
  PublicSandboxJobRequest,
} from "../packages/engine/src/index.js";

const request: PublicSandboxJobRequest = {
  schemaVersion: "1.0.0",
  jobId: "job-transport-1",
  source: { provider: "fixture", reference: "repo-1" },
  snapshot: "snapshot-1",
  commands: [
    '{"executable":"cargo","args":["test"],"workingDirectory":".","environment":{}}',
  ],
  resourceLimits: { timeoutMs: 1000, memoryLimitBytes: 1024 },
  networkPolicy: "none",
  artifactPolicy: "none",
};

const internalRequest: SandboxJobRequest = {
  ...request,
  commands: [
    {
      executable: "cargo",
      args: ["test"],
      workingDirectory: ".",
      environment: {},
    },
  ],
};

const harness = resolve("tests/fixtures/sandbox-harness.mjs");

function processTransport(timeout = 1000) {
  return new SubprocessSandboxTransport({
    executable: process.execPath,
    args: [harness],
    workingDirectory: process.cwd(),
    startupTimeoutMs: 250,
    requestTimeoutMs: timeout,
    maxMessageBytes: 4096,
    maxStderrBytes: 1024,
  });
}

describe("sandbox transport boundary", () => {
  it("validates contract-shaped requests and responses", () => {
    expect(validateSandboxJobRequest(request)).toEqual(request);
    expect(
      validateSandboxJobResult(
        {
          schemaVersion: "1.0.0",
          jobId: request.jobId,
          status: "completed",
          exitCode: 0,
          durationMs: 1,
          logsRef: "fixture://logs",
          artifactRefs: [],
          resourceUsage: { memoryBytes: 0, cpuTimeMs: 0 },
          errors: [],
        },
        request.jobId,
      ).status,
    ).toBe("completed");
  });

  it("rejects malformed boundary data without coercion", () => {
    expect(() =>
      validateSandboxJobRequest({ ...request, schemaVersion: "0" }),
    ).toThrow(SandboxProtocolError);
    expect(() =>
      validateSandboxJobResult({ status: "completed" }, request.jobId),
    ).toThrow(SandboxProtocolError);
  });

  it("records and validates fake transport responses without spawning", async () => {
    const fake = new FakeSandboxTransport({
      ...request,
      status: "completed",
      exitCode: 0,
    });
    const executor = createSandboxExecutorFromTransport(fake);
    await expect(executor.execute(internalRequest)).rejects.toThrow(
      SandboxProtocolError,
    );
    expect(fake.requests).toHaveLength(1);
  });

  it("uses one JSON document per line with a controlled subprocess harness", async () => {
    const transport = processTransport();
    const response = await transport.execute(request);
    expect(response).toMatchObject({
      jobId: request.jobId,
      status: "completed",
      exitCode: 0,
    });
  });

  it("maps a valid transport response through the SandboxExecutor boundary", async () => {
    const fake = new FakeSandboxTransport({
      schemaVersion: "1.0.0",
      jobId: request.jobId,
      status: "completed",
      exitCode: 0,
      durationMs: 1,
      logsRef: "fixture://logs",
      artifactRefs: [],
      resourceUsage: { memoryBytes: 0, cpuTimeMs: 0 },
      errors: [],
    });
    const response =
      await createSandboxExecutorFromTransport(fake).execute(internalRequest);
    expect(response).toMatchObject({ status: "completed", exitCode: 0 });
  });

  it("rejects a transport that omits execution provenance", () => {
    const incomplete = {
      execute: async () => ({}) as unknown,
    } as never;
    expect(() => createSandboxExecutorFromTransport(incomplete)).toThrow(
      "must explicitly declare execution provenance",
    );
  });

  it("rejects malformed, oversized, timed-out, and cancelled subprocess responses", async () => {
    await expect(
      processTransport().execute({ ...request, snapshot: "malformed" }),
    ).rejects.toThrow(SandboxProtocolError);
    await expect(
      processTransport().execute({ ...request, snapshot: "large" }),
    ).rejects.toThrow(SandboxTransportError);
    await expect(
      processTransport(25).execute({ ...request, snapshot: "timeout" }),
    ).rejects.toThrow(SandboxTransportError);
    const controller = new AbortController();
    const pending = processTransport(5000).execute(
      { ...request, snapshot: "cancel" },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it("does not expose host environment or arbitrary execution configuration", () => {
    expect(internalRequest.commands[0]).toMatchObject({
      executable: "cargo",
      environment: {},
      workingDirectory: ".",
    });
    expect(brandId<"CheckId">("typescript.typecheck")).toBe(
      "typescript.typecheck",
    );
  });
});
