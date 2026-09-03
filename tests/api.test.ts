import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { createVerificationApi } from "../apps/api/src/index.js";
import { InvalidSourceReferenceError } from "../packages/adapters-source/src/resolver.js";

const mockSnapshot = {
  id: "snap-1" as any,
  projectId: "proj-1" as any,
  source: { provider: "github", reference: "abc123" },
  sourceState: { type: "snapshot" as const, value: "abc123" },
  retrievedAt: "2024-01-01T00:00:00Z",
};

const mockContents = {
  "package.json": JSON.stringify({ name: "test" }),
  "src/index.ts": "export const a = 1;",
};

function createFakeResolver(
  snapshot: unknown,
  contents: Record<string, string> = {},
) {
  return {
    async resolveSnapshot(source: unknown) {
      void source;
      return { snapshot, sourceContents: contents };
    },
  };
}

function createInvalidResolver() {
  return {
    async resolveSnapshot() {
      throw new InvalidSourceReferenceError("not found");
    },
  };
}

function createUnexpectedResolver(message = "db connection failed: secret") {
  return {
    async resolveSnapshot() {
      throw new Error(message);
    },
  };
}

const validBody = {
  source: { kind: "snapshot", id: "snap-1" },
};

function call(
  port: number,
  method: string,
  path: string,
  body?: string,
  contentType?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        port,
        method,
        path,
        headers: contentType ? { "content-type": contentType } : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >,
          });
        });
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}

async function withApi(
  sourceResolver: any,
  verify: (input: unknown) => Promise<unknown>,
  test: (port: number) => Promise<void>,
): Promise<void> {
  const api = createVerificationApi({ verify }, sourceResolver);
  await new Promise<void>((resolve, reject) =>
    api.server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = api.server.address();
  if (!address || typeof address === "string")
    throw new Error("API did not bind");
  try {
    await test(address.port);
  } finally {
    await api.close();
  }
}

describe("verification HTTP API", () => {
  it("returns health", async () => {
    await withApi(
      createFakeResolver(mockSnapshot),
      async () => ({}),
      async (port) => {
        await expect(call(port, "GET", "/health")).resolves.toEqual({
          status: 200,
          body: { status: "ok" },
        });
      },
    );
  });

  it("returns 404 for unknown routes and 405 for unsupported methods", async () => {
    await withApi(
      createFakeResolver(mockSnapshot),
      async () => ({}),
      async (port) => {
        await expect(call(port, "GET", "/unknown")).resolves.toMatchObject({
          status: 404,
        });
        await expect(call(port, "GET", "/verify")).resolves.toMatchObject({
          status: 405,
        });
      },
    );
  });

  it("rejects malformed JSON", async () => {
    await withApi(
      createFakeResolver(mockSnapshot),
      async () => ({}),
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          "{",
          "application/json",
        );
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          error: {
            code: "invalid_request",
            message: "request body is not valid JSON",
          },
        });
      },
    );
  });

  it("rejects missing or incorrect source shape", async () => {
    await withApi(
      createFakeResolver(mockSnapshot),
      async () => ({}),
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify({}),
          "application/json",
        );
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          error: {
            code: "invalid_request",
            message: "source must be { kind: 'snapshot', id: string }",
          },
        });
      },
    );
  });

  it("rejects source with unsupported kind", async () => {
    await withApi(
      createFakeResolver(mockSnapshot),
      async () => ({}),
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify({ source: { kind: "repo", id: "x" } }),
          "application/json",
        );
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          error: {
            code: "invalid_request",
            message: "source must be { kind: 'snapshot', id: string }",
          },
        });
      },
    );
  });

  it("translates a valid request and invokes the application service", async () => {
    let received: unknown;
    await withApi(
      createFakeResolver(mockSnapshot),
      async (input) => {
        received = input;
        return {
          status: "pass",
          coverage: {
            verified: [],
            partial: [],
            unsupported: [],
            notApplicable: [],
          },
          checkResults: [],
          findingReferences: [],
          evidenceReferences: [],
          policyDecision: "pass",
          summary: "ok",
          resultVersion: "1.0.0",
          contentHash: "hash-1",
          createdAt: "2024-01-01T00:00:00Z",
        };
      },
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify(validBody),
          "application/json",
        );
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          status: "pass",
          coverage: {
            verified: [],
            partial: [],
            unsupported: [],
            notApplicable: [],
          },
          checkResults: [],
          findings: [],
          evidenceReferences: [],
          policyDecision: "pass",
          summary: "ok",
          resultVersion: "1.0.0",
          contentHash: "hash-1",
          createdAt: "2024-01-01T00:00:00Z",
          source: { kind: "snapshot", id: "snap-1" },
        });
      },
    );
    expect(received).toMatchObject({
      project: { id: mockSnapshot.projectId, name: "", root: "." },
      snapshot: mockSnapshot,
      changeSet: expect.objectContaining({
        baseSourceState: mockSnapshot.sourceState,
        headSourceState: mockSnapshot.sourceState,
        changeHash: "snap-1",
      }),
      verificationId: "snap-1-verification",
    });
    expect(
      typeof (received as { detectionContext: { exists: unknown } })
        .detectionContext.exists,
    ).toBe("function");
  });

  it("invokes the source resolver with the correct source", async () => {
    let resolvedSource: unknown;
    const resolver = {
      async resolveSnapshot(source: unknown) {
        resolvedSource = source;
        return { snapshot: mockSnapshot, sourceContents: {} };
      },
    };
    await withApi(
      resolver,
      async () => ({}),
      async (port) => {
        await call(
          port,
          "POST",
          "/verify",
          JSON.stringify(validBody),
          "application/json",
        );
      },
    );
    expect(resolvedSource).toEqual({ kind: "snapshot", id: "snap-1" });
  });

  it("exposes resolved source contents via detection context", async () => {
    let received: any;
    const resolver = createFakeResolver(mockSnapshot, mockContents);
    await withApi(
      resolver,
      async (input) => {
        received = input;
        return {
          status: "pass",
          coverage: {
            verified: ["typescript.typecheck"],
            partial: [],
            unsupported: [],
            notApplicable: [],
          },
          checkResults: ["check-1"],
          findingReferences: ["finding-1"],
          evidenceReferences: ["evidence-1"],
          policyDecision: "policy-1",
          summary: "ok",
          resultVersion: "1.0.0",
          contentHash: "hash-1",
          createdAt: "2024-01-01T00:00:00Z",
        };
      },
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify(validBody),
          "application/json",
        );
        expect(response.status).toBe(200);
      },
    );
    expect(received).toBeDefined();
    const ctx = received.detectionContext as {
      exists: (p: string) => boolean;
      readFile: (p: string) => string | undefined;
      listDirectory: (p?: string) => readonly string[];
    };
    expect(ctx.readFile("package.json")).toBe(mockContents["package.json"]);
    expect(ctx.exists("src/index.ts")).toBe(true);
    expect(ctx.exists("missing.txt")).toBe(false);
    expect(ctx.listDirectory("src")).toEqual(["index.ts"]);
    expect(ctx.listDirectory()).toEqual(
      expect.arrayContaining(["package.json", "src"]),
    );
  });

  it("returns 400 for invalid source reference", async () => {
    await withApi(
      createInvalidResolver(),
      async () => ({}),
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify(validBody),
          "application/json",
        );
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          error: {
            code: "invalid_request",
            message: "invalid source reference",
          },
        });
        expect(JSON.stringify(response.body)).not.toContain("not found");
      },
    );
  });

  it("returns 500 for unexpected resolver failure without leaking details", async () => {
    await withApi(
      createUnexpectedResolver("db connection failed: secret"),
      async () => ({}),
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify(validBody),
          "application/json",
        );
        expect(response.status).toBe(500);
        expect(response.body).toEqual({
          error: { code: "internal_error", message: "verification failed" },
        });
        expect(JSON.stringify(response.body)).not.toContain("secret");
        expect(JSON.stringify(response.body)).not.toContain(
          "db connection failed",
        );
      },
    );
  });

  it("maps public response status, coverage, findings, provenance, policy, summary, version and hash correctly", async () => {
    const mockResult = {
      status: "needs_review" as const,
      coverage: {
        verified: ["typescript.typecheck"],
        partial: ["typescript.test"],
        unsupported: ["rust.check"],
        notApplicable: ["go.build"],
      },
      checkResults: ["check-1", "check-2"],
      findingReferences: ["finding-1"],
      evidenceReferences: ["evidence-1", "evidence-2"],
      policyDecision: "policy-decision-1",
      summary: "needs review: 1/2 checks",
      resultVersion: "1.0.0",
      contentHash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      createdAt: "2024-01-01T00:00:00Z",
    };
    await withApi(
      createFakeResolver(mockSnapshot, { "package.json": "{}" }),
      async () => mockResult,
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify(validBody),
          "application/json",
        );
        expect(response.status).toBe(200);
        expect(response.body).toEqual({
          status: mockResult.status,
          coverage: mockResult.coverage,
          checkResults: mockResult.checkResults,
          findings: mockResult.findingReferences,
          evidenceReferences: mockResult.evidenceReferences,
          policyDecision: mockResult.policyDecision,
          summary: mockResult.summary,
          resultVersion: mockResult.resultVersion,
          contentHash: mockResult.contentHash,
          createdAt: mockResult.createdAt,
          source: { kind: "snapshot", id: "snap-1" },
        });
      },
    );
  });

  it("does not allow client to provide internal execution configuration", async () => {
    let received: any;
    const resolver = createFakeResolver(mockSnapshot, {
      "package.json": "{}",
    });
    const maliciousBody = {
      source: { kind: "snapshot", id: "snap-1" },
      detectionContext: { files: { "evil.txt": "malicious" } },
      project: { id: "evil-project", name: "evil", root: "/tmp/evil" },
      snapshot: { id: "evil-snap" },
      changeSet: { id: "evil-changeset" },
      request: { id: "evil-request" },
      job: { id: "evil-job" },
      verificationId: "evil-verification",
      plannerConfig: { enabledChecks: ["evil"] },
      selectedCheckIds: ["evil-check"],
      executionLimits: { timeoutMs: 999999, memoryLimitBytes: 999999 },
      dependencyProvisioning: { request: {}, destination: "/tmp" },
    };
    await withApi(
      resolver,
      async (input) => {
        received = input;
        return {
          status: "pass",
          coverage: {
            verified: [],
            partial: [],
            unsupported: [],
            notApplicable: [],
          },
          checkResults: [],
          findingReferences: [],
          evidenceReferences: [],
          policyDecision: "pass",
          summary: "ok",
          resultVersion: "1.0.0",
          contentHash: "hash-1",
          createdAt: "2024-01-01T00:00:00Z",
        };
      },
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify(maliciousBody),
          "application/json",
        );
        expect(response.status).toBe(200);
      },
    );
    expect(received.project.id).toBe(mockSnapshot.projectId);
    expect(received.project.id).not.toBe("evil-project");
    expect(received.snapshot.id).toBe(mockSnapshot.id);
    expect(received.verificationId).toBe("snap-1-verification");
    expect(received.plannerConfig).toBeUndefined();
    expect(received.executionLimits).toBeUndefined();
    expect(received.selectedCheckIds).toBeUndefined();
    expect(received.dependencyProvisioning).toBeUndefined();
    const ctx = received.detectionContext as {
      exists: (p: string) => boolean;
      readFile: (p: string) => string | undefined;
    };
    expect(ctx.exists("evil.txt")).toBe(false);
    expect(ctx.readFile("evil.txt")).toBeUndefined();
    expect(ctx.readFile("package.json")).toBe("{}");
  });

  it("returns a safe 500 when the application service fails", async () => {
    await withApi(
      createFakeResolver(mockSnapshot),
      async () => {
        throw new Error("internal detail");
      },
      async (port) => {
        const response = await call(
          port,
          "POST",
          "/verify",
          JSON.stringify(validBody),
          "application/json",
        );
        expect(response.status).toBe(500);
        expect(response.body).toEqual({
          error: { code: "internal_error", message: "verification failed" },
        });
        expect(JSON.stringify(response.body)).not.toContain("internal detail");
      },
    );
  });
});

it("rejects missing or incorrect Content-Type", async () => {
  await withApi(
    createFakeResolver(mockSnapshot),
    async () => ({}),
    async (port) => {
      await expect(
        call(port, "POST", "/verify", JSON.stringify(validBody)),
      ).resolves.toMatchObject({ status: 415 });
      await expect(
        call(port, "POST", "/verify", JSON.stringify(validBody), "text/plain"),
      ).resolves.toMatchObject({ status: 415 });
    },
  );
});

it("rejects request bodies larger than 1 MiB", async () => {
  await withApi(
    createFakeResolver(mockSnapshot),
    async () => ({}),
    async (port) => {
      const response = await call(
        port,
        "POST",
        "/verify",
        `{"padding":"${"x".repeat(1_048_580)}"}`,
        "application/json",
      );
      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: "invalid_request",
          message: "request body exceeds 1 MiB",
        },
      });
    },
  );
});
