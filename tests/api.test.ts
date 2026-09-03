import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { createVerificationApi } from "../apps/api/src/index.js";
import { InvalidSourceReferenceError } from "../packages/domain/src/index.js";

function createFakeVerificationService(
  result: unknown = {
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
  },
) {
  return {
    async verifySource(input: unknown) {
      void input;
      return result;
    },
  };
}

function createInvalidReferenceService(message = "not found") {
  return {
    async verifySource() {
      throw new InvalidSourceReferenceError(message);
    },
  };
}

function createUnexpectedFailureService(
  message = "db connection failed: secret",
) {
  return {
    async verifySource() {
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
  service: { verifySource: (input: unknown) => Promise<unknown> },
  test: (port: number) => Promise<void>,
): Promise<void> {
  const api = createVerificationApi(service);
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
    await withApi(createFakeVerificationService(), async (port) => {
      await expect(call(port, "GET", "/health")).resolves.toEqual({
        status: 200,
        body: { status: "ok" },
      });
    });
  });

  it("returns 404 for unknown routes and 405 for unsupported methods", async () => {
    await withApi(createFakeVerificationService(), async (port) => {
      await expect(call(port, "GET", "/unknown")).resolves.toMatchObject({
        status: 404,
      });
      await expect(call(port, "GET", "/verify")).resolves.toMatchObject({
        status: 405,
      });
    });
  });

  it("rejects malformed JSON", async () => {
    await withApi(createFakeVerificationService(), async (port) => {
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
    });
  });

  it("rejects missing or incorrect source shape", async () => {
    await withApi(createFakeVerificationService(), async (port) => {
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
    });
  });

  it("rejects source with unsupported kind", async () => {
    await withApi(createFakeVerificationService(), async (port) => {
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
    });
  });

  it("passes the provider-neutral source reference to the application service", async () => {
    let received: unknown;
    await withApi(
      {
        async verifySource(input) {
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
    expect(received).toEqual({ source: { kind: "snapshot", id: "snap-1" } });
  });

  it("returns 400 for invalid source reference without leaking details", async () => {
    await withApi(createInvalidReferenceService(), async (port) => {
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
    });
  });

  it("returns 500 for unexpected resolution failure without leaking details", async () => {
    await withApi(createUnexpectedFailureService(), async (port) => {
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
    });
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
    await withApi(createFakeVerificationService(mockResult), async (port) => {
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
    });
  });

  it("does not allow client to provide internal execution configuration", async () => {
    let received: any;
    await withApi(
      {
        async verifySource(input) {
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
      },
      async (port) => {
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
    // Only the provider-neutral source reference may reach the application
    // service; internal execution configuration is never forwarded.
    expect(received).toEqual({ source: { kind: "snapshot", id: "snap-1" } });
  });

  it("returns a safe 500 when the application service fails", async () => {
    await withApi(
      createUnexpectedFailureService("internal detail"),
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
  await withApi(createFakeVerificationService(), async (port) => {
    await expect(
      call(port, "POST", "/verify", JSON.stringify(validBody)),
    ).resolves.toMatchObject({ status: 415 });
    await expect(
      call(port, "POST", "/verify", JSON.stringify(validBody), "text/plain"),
    ).resolves.toMatchObject({ status: 415 });
  });
});

it("rejects request bodies larger than 1 MiB", async () => {
  await withApi(createFakeVerificationService(), async (port) => {
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
  });
});
