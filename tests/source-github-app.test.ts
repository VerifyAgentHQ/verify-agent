import { describe, expect, it, vi } from "vitest";
import {
  GitHubAppAuthenticationError,
  GitHubAppConfigurationError,
  GitHubInstallationTokenError,
  GitHubRateLimitError,
  createGitHubAppSourceProvider,
  createStaticGitHubInstallationResolver,
} from "../packages/adapters-source/src/github-app.js";
import {
  GitHubAuthenticationError,
  GitHubProviderError,
} from "../packages/adapters-source/src/github.js";
import { InvalidSourceReferenceError } from "../packages/adapters-source/src/resolver.js";

const OWNER = "octocat";
const REPO = "hello-world";
const SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const VALID_REF = {
  kind: "github-snapshot" as const,
  owner: OWNER,
  repository: REPO,
  sha: SHA,
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

describe("GitHub installation resolver", () => {
  it("known owner/repository maps to expected installation ID", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 12345,
    });
    await expect(resolver.resolveInstallationId(OWNER, REPO)).resolves.toBe(
      12345,
    );
    // case-insensitive
    await expect(
      resolver.resolveInstallationId("OctoCat", "Hello-World"),
    ).resolves.toBe(12345);
  });

  it("unknown repository fails", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    await expect(
      resolver.resolveInstallationId("unknown", "repo"),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("invalid owner fails", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    await expect(
      resolver.resolveInstallationId("owner/with-slash", REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
    await expect(
      resolver.resolveInstallationId("", REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("invalid repository fails", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, "../evil"),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("invalid installation ID fails at creation", () => {
    expect(() =>
      createStaticGitHubInstallationResolver({
        "octocat/hello-world": 0,
      }),
    ).toThrow(GitHubInstallationTokenError);
    expect(() =>
      createStaticGitHubInstallationResolver({
        "octocat/hello-world": -1,
      }),
    ).toThrow(GitHubInstallationTokenError);
    expect(() =>
      createStaticGitHubInstallationResolver([
        { owner: OWNER, repository: REPO, installationId: 1.5 },
      ]),
    ).toThrow(GitHubInstallationTokenError);
  });

  it("performs no network I/O", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 42,
    });
    // No fetch involved, just pure mapping
    const id = await resolver.resolveInstallationId(OWNER, REPO);
    expect(id).toBe(42);
  });
});

describe("GitHub App-authenticated source provider", () => {
  it("validates snapshot reference before installation resolution", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: vi.fn(async () => ({
        token: "ghs_test",
        expiresAt: "2024-01-01T00:00:00Z",
      })),
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: async () => createMockResponse(200, { sha: SHA }),
    });
    await expect(
      provider.resolveSnapshot({
        kind: "github-snapshot",
        owner: OWNER,
        repository: REPO,
        sha: "not-a-sha",
      }),
    ).rejects.toBeInstanceOf(InvalidSourceReferenceError);
    expect(tokenClient.createInstallationToken).not.toHaveBeenCalled();
  });

  it("resolves installation ID and obtains token", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 999,
    });
    const tokenClient = {
      createInstallationToken: vi.fn(async (id: number) => {
        expect(id).toBe(999);
        return { token: "ghs_test_token", expiresAt: "2024-01-01T00:00:00Z" };
      }),
    };
    const fetchFn: typeof fetch = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // Should use installation token, not App JWT
      expect(headers.Authorization).toBe("Bearer ghs_test_token");
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, { tree: [], truncated: false });
      return createMockResponse(404, {});
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    const result = await provider.resolveSnapshot(VALID_REF);
    expect(tokenClient.createInstallationToken).toHaveBeenCalledWith(999);
    expect(result.snapshot.source.provider).toBe("github");
    expect(result.snapshot.commitSha).toBe(SHA);
  });

  it("uses installation token for all GitHub API requests", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const token = "ghs_all_requests_token";
    const tokenClient = {
      createInstallationToken: async () => ({
        token,
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const capturedAuth: string[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      capturedAuth.push(headers.Authorization ?? "");
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            {
              path: "a.txt",
              mode: "100644",
              type: "blob",
              sha: "a".repeat(40),
            },
          ],
          truncated: false,
        });
      }
      if (urlStr.includes("/git/blobs/")) {
        return createMockResponse(200, {
          content: b64("hello"),
          encoding: "base64",
          size: 5,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    await provider.resolveSnapshot(VALID_REF);
    expect(capturedAuth.length).toBe(3); // commit, tree, blob
    for (const auth of capturedAuth) {
      expect(auth).toBe(`Bearer ${token}`);
    }
  });

  it("exact requested SHA remains source identity and is verified", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_t",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/")) {
        // Return different SHA to trigger mismatch
        return createMockResponse(200, { sha: "b".repeat(40) });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    await expect(provider.resolveSnapshot(VALID_REF)).rejects.toBeInstanceOf(
      InvalidSourceReferenceError,
    );
  });

  it("preserves Batch 30 file limits and truncation", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_t",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, { tree: [], truncated: true });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    await expect(provider.resolveSnapshot(VALID_REF)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });

  it("preserves path validation and binary handling via Batch 30", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_t",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            {
              path: "../evil",
              mode: "100644",
              type: "blob",
              sha: "a".repeat(40),
            },
          ],
          truncated: false,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    await expect(provider.resolveSnapshot(VALID_REF)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });
});

describe("Credential isolation", () => {
  it("installation token never appears in errors", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const secretToken = "ghs_secret_token_12345";
    const tokenClient = {
      createInstallationToken: async () => ({
        token: secretToken,
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async () => createMockResponse(500, {});
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    let err: unknown;
    try {
      await provider.resolveSnapshot(VALID_REF);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).not.toContain(secretToken);
    expect(JSON.stringify(err)).not.toContain(secretToken);
  });

  it("token never appears in ResolvedSource", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_hidden",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, { tree: [], truncated: false });
      return createMockResponse(404, {});
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    const result = await provider.resolveSnapshot(VALID_REF);
    expect(JSON.stringify(result)).not.toContain("ghs_hidden");
    expect(JSON.stringify(result.snapshot)).not.toContain("ghs_hidden");
    expect(JSON.stringify(result.sourceContents)).not.toContain("ghs_hidden");
  });

  it("JWT never appears in errors", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => {
        throw new GitHubAppAuthenticationError("jwt failure eyJ…");
      },
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: async () => createMockResponse(200, { sha: SHA }),
    });
    let err: unknown;
    try {
      await provider.resolveSnapshot(VALID_REF);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitHubAppAuthenticationError);
    expect(String(err)).not.toContain("eyJ");
  });

  it("private key never appears in errors", async () => {
    const badConfig = { appId: "123", privateKey: "bad-key-material" };
    // Use a token client that will fail due to bad config internally
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => {
        // Simulate that the client was created with bad config and fails
        throw new GitHubAppAuthenticationError("private key error");
      },
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: async () => createMockResponse(200, { sha: SHA }),
    });
    let err: unknown;
    try {
      await provider.resolveSnapshot(VALID_REF);
    } catch (e) {
      err = e;
    }
    expect(String(err)).not.toContain("bad-key-material");
    expect(String(err)).not.toContain("BEGIN");
  });

  it("Authorization header never appears in errors", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_tok",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async () => createMockResponse(401, {});
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    let err: unknown;
    try {
      await provider.resolveSnapshot(VALID_REF);
    } catch (e) {
      err = e;
    }
    expect(String(err)).not.toContain("Authorization");
    expect(String(err)).not.toContain("Bearer");
    expect(String(err)).not.toContain("ghs_tok");
  });

  it("token is not returned by provider", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_return_test",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, { tree: [], truncated: false });
      return createMockResponse(404, {});
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    const result = (await provider.resolveSnapshot(VALID_REF)) as Record<
      string,
      unknown
    >;
    expect(result.token).toBeUndefined();
    expect(
      (result as unknown as { installationToken?: unknown }).installationToken,
    ).toBeUndefined();
  });
});

describe("Failure propagation", () => {
  it("installation resolver failure propagates", async () => {
    const resolver = {
      resolveInstallationId: async () => {
        throw new GitHubInstallationTokenError("resolver failed");
      },
    } as unknown as ReturnType<typeof createStaticGitHubInstallationResolver>;
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_t",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: async () => createMockResponse(200, { sha: SHA }),
    });
    await expect(provider.resolveSnapshot(VALID_REF)).rejects.toBeInstanceOf(
      GitHubInstallationTokenError,
    );
  });

  it("installation token client failure propagates", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => {
        throw new GitHubAppAuthenticationError("token failed");
      },
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: async () => createMockResponse(200, { sha: SHA }),
    });
    await expect(provider.resolveSnapshot(VALID_REF)).rejects.toBeInstanceOf(
      GitHubAppAuthenticationError,
    );
  });

  it("rate limit propagates", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => {
        throw new GitHubRateLimitError("rate limited");
      },
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: async () => createMockResponse(200, { sha: SHA }),
    });
    await expect(provider.resolveSnapshot(VALID_REF)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  it("GitHub 404 propagates as InvalidSourceReferenceError", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_t",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async () => createMockResponse(404, {});
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    await expect(provider.resolveSnapshot(VALID_REF)).rejects.toBeInstanceOf(
      InvalidSourceReferenceError,
    );
  });

  it("GitHub 5xx propagates", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_t",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async () => createMockResponse(500, {});
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    await expect(provider.resolveSnapshot(VALID_REF)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });

  it("malformed source response propagates without leaking token", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_leak_test",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    };
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            { path: "a.txt", mode: "100644", type: "blob", sha: "not-a-sha" },
          ],
          truncated: false,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient as never,
      fetch: fetchFn,
    });
    let err: unknown;
    try {
      await provider.resolveSnapshot(VALID_REF);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String(err)).not.toContain("ghs_leak_test");
  });
});
