import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubSourceResolver } from "../packages/adapters-source/src/github.js";
import {
  GitHubInstallationTokenError,
  createGitHubApiInstallationResolver,
  createGitHubAppInstallationTokenClient,
  createGitHubAppSourceProvider,
} from "../packages/adapters-source/src/github-app.js";
import {
  FakeSandboxTransport,
  VerificationApplicationService,
  VerificationApplicationServiceError,
  createCheckExecutor,
  createSandboxExecutorFromTransport,
  createVerificationPipeline,
} from "../packages/engine/src/index.js";
import { createProjectDetectionService } from "../packages/adapters-lang/src/index.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_CONFIG = { appId: "123456", privateKey };
const OWNER = "octocat";
const REPO = "hello-world";
const SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const INSTALLATION_ID = 12345;
const INSTALLATION_TOKEN = "ghs_synthetic_composition_token";

const SOURCE_ID = `${OWNER}:${REPO}:${SHA}`;

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "composition-fixture",
    devDependencies: { typescript: "5.0.0" },
  }),
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
  "src/index.ts": "export const value = 42;\n",
};

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function createMockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function createGitHubApiMock() {
  const calls: Array<{ url: string; authorization: string }> = [];
  const blobEntries = Object.entries(FILES).map(([path], index) => ({
    path,
    mode: "100644",
    type: "blob" as const,
    sha: (index + 1).toString(16).padStart(40, "0"),
  }));
  const fetchFn: typeof fetch = async (url, init) => {
    const urlStr = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: urlStr, authorization: headers.Authorization ?? "" });
    if (urlStr.endsWith(`/repos/${OWNER}/${REPO}/installation`)) {
      return createMockResponse(200, { id: INSTALLATION_ID });
    }
    if (urlStr.includes("/access_tokens")) {
      return createMockResponse(200, {
        token: INSTALLATION_TOKEN,
        expires_at: "2024-01-01T00:00:00Z",
      });
    }
    if (urlStr.includes("/commits/")) {
      return createMockResponse(200, { sha: SHA });
    }
    if (urlStr.includes("/git/trees/")) {
      return createMockResponse(200, { tree: blobEntries, truncated: false });
    }
    if (urlStr.includes("/git/blobs/")) {
      const blobSha = urlStr.split("/").pop();
      const entry = blobEntries.find((candidate) => candidate.sha === blobSha);
      if (!entry) return createMockResponse(404, {});
      const content = FILES[entry.path];
      return createMockResponse(200, {
        content: b64(content),
        encoding: "base64",
        size: Buffer.byteLength(content),
      });
    }
    throw new Error(`unexpected GitHub URL: ${urlStr}`);
  };
  return { fetchFn, calls };
}

function createComposedGitHubResolver(
  fetchFn: typeof fetch,
): ReturnType<typeof createGitHubSourceResolver> {
  const installationResolver = createGitHubApiInstallationResolver({
    appConfig: APP_CONFIG,
    fetch: fetchFn,
  });
  const installationTokenClient = createGitHubAppInstallationTokenClient({
    appConfig: APP_CONFIG,
    fetch: fetchFn,
  });
  const provider = createGitHubAppSourceProvider({
    installationResolver,
    installationTokenClient,
    fetch: fetchFn,
  });
  return createGitHubSourceResolver(provider);
}

function createComposedApplicationService(
  fetchFn: typeof fetch,
): VerificationApplicationService {
  const transport = new FakeSandboxTransport((request) => ({
    schemaVersion: "1.0.0" as const,
    jobId: request.jobId,
    status: "completed" as const,
    exitCode: 0,
    durationMs: 5,
    logsRef: "fixture://logs/github-composition",
    artifactRefs: [],
    resourceUsage: { memoryBytes: 0, cpuTimeMs: 1 },
    errors: [],
  }));
  const pipeline = createVerificationPipeline({
    detector: createProjectDetectionService(),
    executor: createCheckExecutor(
      createSandboxExecutorFromTransport(transport),
    ),
  });
  return new VerificationApplicationService(
    pipeline,
    createComposedGitHubResolver(fetchFn),
  );
}

describe("GitHub composition into the application service", () => {
  it("resolves a provider-neutral GitHub snapshot through the full App-authenticated chain", async () => {
    const { fetchFn, calls } = createGitHubApiMock();
    const appService = createComposedApplicationService(fetchFn);

    const result = await appService.verifySource({
      source: { kind: "snapshot", id: SOURCE_ID },
    });

    expect(result).toBeDefined();
    expect(result.snapshotId).toBe(`${OWNER}--${REPO}--${SHA}`);
    expect(result.status).toBe("needs_changes");
    expect(result.checkResults).toHaveLength(1);

    // Dynamic installation discovery used the App JWT, not the private key.
    const discovery = calls.find((call) => call.url.includes("/installation"));
    expect(discovery).toBeDefined();
    expect(discovery?.authorization).toMatch(/^Bearer /);
    expect(discovery?.authorization).not.toContain(privateKey);

    // Source retrieval used the installation token for every request.
    const sourceCalls = calls.filter(
      (call) =>
        call.url.includes("/commits/") ||
        call.url.includes("/git/trees/") ||
        call.url.includes("/git/blobs/"),
    );
    expect(sourceCalls.length).toBe(1 + 1 + Object.keys(FILES).length);
    for (const call of sourceCalls) {
      expect(call.authorization).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    }
    expect(calls.some((call) => call.url.includes(`/commits/${SHA}`))).toBe(
      true,
    );
  });

  it("keeps synthetic credentials out of the verification result", async () => {
    const { fetchFn } = createGitHubApiMock();
    const appService = createComposedApplicationService(fetchFn);

    const result = await appService.verifySource({
      source: { kind: "snapshot", id: SOURCE_ID },
    });
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain("ghs_");
    expect(serialized).not.toContain("eyJ");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain(String(INSTALLATION_ID));
  });

  it("rejects branch-like references before any network I/O", async () => {
    const fetchFn = vi.fn();
    const appService = createComposedApplicationService(fetchFn as never);

    await expect(
      appService.verifySource({
        source: { kind: "snapshot", id: `${OWNER}:${REPO}:main` },
      }),
    ).rejects.toMatchObject({ name: "InvalidSourceReferenceError" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fails safely with a distinct error when the GitHub App is not installed", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/installation")) return createMockResponse(404, {});
      throw new Error(`unexpected GitHub URL: ${urlStr}`);
    };
    const appService = createComposedApplicationService(fetchFn);

    await expect(
      appService.verifySource({ source: { kind: "snapshot", id: SOURCE_ID } }),
    ).rejects.toMatchObject({
      name: "VerificationApplicationServiceError",
      code: "source_resolution_failed",
      message: "Source resolution failed",
    });
  });

  it("maps installation-token rate limiting without leaking the token", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/installation"))
        return createMockResponse(200, { id: INSTALLATION_ID });
      if (urlStr.includes("/access_tokens")) return createMockResponse(429, {});
      throw new Error(`unexpected GitHub URL: ${urlStr}`);
    };
    const appService = createComposedApplicationService(fetchFn);

    try {
      await appService.verifySource({
        source: { kind: "snapshot", id: SOURCE_ID },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationApplicationServiceError);
      expect((error as Error).message).toBe("Source resolution failed");
      expect(String(error)).not.toContain(INSTALLATION_TOKEN);
      expect(String(error)).not.toContain("Bearer");
      expect(String(error)).not.toContain("Authorization");
    }
  });

  it("preserves the typed installation error as the resolution cause", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/installation")) return createMockResponse(404, {});
      throw new Error(`unexpected GitHub URL: ${urlStr}`);
    };
    const resolver = createComposedGitHubResolver(fetchFn);

    // The GitHub resolver itself surfaces the typed provider error unchanged.
    await expect(
      resolver.resolveSnapshot({ kind: "snapshot", id: SOURCE_ID }),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });
});
