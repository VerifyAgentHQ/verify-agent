import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { createVerificationApi } from "../apps/api/src/index.js";

const validBody = {
  project: {},
  snapshot: {},
  changeSet: {},
  request: {},
  job: {},
  verificationId: "verification-1",
  detectionContext: { files: {} },
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
  verify: (input: unknown) => Promise<unknown>,
  test: (port: number) => Promise<void>,
): Promise<void> {
  const api = createVerificationApi({ verify });
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

  it("translates a valid request and invokes the application service", async () => {
    let received: unknown;
    await withApi(
      async (input) => {
        received = input;
        return { id: "result-1", status: "pass" };
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
        expect(response.body).toEqual({ id: "result-1", status: "pass" });
      },
    );
    expect(received).toMatchObject({
      project: validBody.project,
      snapshot: validBody.snapshot,
      changeSet: validBody.changeSet,
      request: validBody.request,
      job: validBody.job,
      verificationId: validBody.verificationId,
    });
    expect(
      typeof (received as { detectionContext: { exists: unknown } })
        .detectionContext.exists,
    ).toBe("function");
  });

  it("returns a safe 500 when the application service fails", async () => {
    await withApi(
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
      },
    );
  });
});

it("rejects missing or incorrect Content-Type", async () => {
  await withApi(
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
