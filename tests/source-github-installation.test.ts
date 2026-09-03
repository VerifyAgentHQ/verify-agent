import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubAppAuthenticationError,
  GitHubAppConfigurationError,
  GitHubInstallationTokenError,
  GitHubRateLimitError,
  createGitHubApiInstallationResolver,
  createGitHubAppSourceProvider,
  createStaticGitHubInstallationResolver,
} from "../packages/adapters-source/src/github-app.js";
import { createGitHubApiSourceProvider } from "../packages/adapters-source/src/github.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const APP_CONFIG = { appId: "123456", privateKey };
const OWNER = "octocat";
const REPO = "hello-world";
const SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";

function createMockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("GitHub API installation resolver – valid discovery", () => {
  it("resolves owner/repository to installationId with App JWT", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init as RequestInit;
      return createMockResponse(200, { id: 12345 });
    };
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    const id = await resolver.resolveInstallationId(OWNER, REPO);
    expect(id).toBe(12345);
    expect(capturedUrl).toBe(
      `https://api.github.com/repos/${OWNER}/${REPO}/installation`,
    );
    expect(capturedInit?.method).toBe("GET");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers.Authorization).not.toContain(privateKey);
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect((capturedInit as RequestInit).redirect).toBe("error");
  });

  it("respects custom apiBaseUrl", async () => {
    let capturedUrl = "";
    const fetchFn: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return createMockResponse(200, { id: 999 });
    };
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      apiBaseUrl: "https://api.example.com",
      fetch: fetchFn,
    });
    await resolver.resolveInstallationId(OWNER, REPO);
    expect(capturedUrl).toBe(
      `https://api.example.com/repos/${OWNER}/${REPO}/installation`,
    );
  });
});

describe("GitHub API installation resolver – repository validation", () => {
  it("rejects empty owner without network", async () => {
    const fetchFn = vi.fn(async () => createMockResponse(200, { id: 1 }));
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn as never,
    });
    await expect(
      resolver.resolveInstallationId("", REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects empty repository without network", async () => {
    const fetchFn = vi.fn(async () => createMockResponse(200, { id: 1 }));
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn as never,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, ""),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  for (const bad of [
    "owner/with-slash",
    "owner?query=1",
    "owner#frag",
    "owner..",
    "",
  ]) {
    it(`rejects owner ${JSON.stringify(bad)} without network`, async () => {
      const fetchFn = vi.fn(async () => createMockResponse(200, { id: 1 }));
      const resolver = createGitHubApiInstallationResolver({
        appConfig: APP_CONFIG,
        fetch: fetchFn as never,
      });
      await expect(
        resolver.resolveInstallationId(bad, REPO),
      ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }

  for (const bad of [
    "repo/with-slash",
    "repo?query",
    "repo#frag",
    "repo..",
    "",
  ]) {
    it(`rejects repository ${JSON.stringify(bad)} without network`, async () => {
      const fetchFn = vi.fn(async () => createMockResponse(200, { id: 1 }));
      const resolver = createGitHubApiInstallationResolver({
        appConfig: APP_CONFIG,
        fetch: fetchFn as never,
      });
      await expect(
        resolver.resolveInstallationId(OWNER, bad),
      ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  }
});

describe("GitHub API installation resolver – response validation", () => {
  for (const bad of [
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "123" as unknown as number,
    null as unknown as number,
    undefined as unknown as number,
  ]) {
    it(`rejects invalid id ${String(bad)}`, async () => {
      const fetchFn: typeof fetch = async () =>
        createMockResponse(200, { id: bad });
      const resolver = createGitHubApiInstallationResolver({
        appConfig: APP_CONFIG,
        fetch: fetchFn,
      });
      await expect(
        resolver.resolveInstallationId(OWNER, REPO),
      ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
    });
  }

  it("rejects missing id", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(200, {});
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("rejects malformed JSON", async () => {
    const fetchFn: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error("invalid json");
        },
      }) as unknown as Response;
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("ignores extra fields", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, { id: 777, extra: "ignore", foo: {} });
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    await expect(resolver.resolveInstallationId(OWNER, REPO)).resolves.toBe(
      777,
    );
  });
});

describe("GitHub API installation resolver – status handling", () => {
  for (const status of [401, 403]) {
    it(`maps ${status} to GitHubAppAuthenticationError`, async () => {
      const fetchFn: typeof fetch = async () => createMockResponse(status, {});
      const resolver = createGitHubApiInstallationResolver({
        appConfig: APP_CONFIG,
        fetch: fetchFn,
      });
      await expect(
        resolver.resolveInstallationId(OWNER, REPO),
      ).rejects.toBeInstanceOf(GitHubAppAuthenticationError);
    });
  }

  it("maps 404 to installation-not-found", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(404, {});
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("maps 429 to rate limit", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(429, {});
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, REPO),
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it("maps 500 to provider error", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(500, {});
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("handles network failure", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error("network down");
    };
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });

  it("handles timeout", async () => {
    const fetchFn: typeof fetch = async (_url, init) => {
      const signal = (init as RequestInit).signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        if (signal) {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            (err as unknown as { name: string }).name = "AbortError";
            reject(err);
          });
        }
      });
    };
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
      timeoutMs: 10,
    });
    await expect(
      resolver.resolveInstallationId(OWNER, REPO),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });
});

describe("GitHub API installation resolver – credential isolation", () => {
  it("JWT never appears in errors", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(401, {});
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    try {
      await resolver.resolveInstallationId(OWNER, REPO);
    } catch (e) {
      expect(String(e)).not.toMatch(/eyJ/);
      expect(String(e)).not.toContain(APP_CONFIG.privateKey);
    }
  });

  it("private key never appears in errors", async () => {
    const badConfig = { appId: "123", privateKey: "bad-key" };
    const resolver = createGitHubApiInstallationResolver({
      appConfig: badConfig as never,
      fetch: async () => createMockResponse(200, { id: 1 }),
    });
    try {
      await resolver.resolveInstallationId(OWNER, REPO);
    } catch (e) {
      expect(String(e)).not.toContain("bad-key");
    }
  });

  it("Authorization header never appears in errors", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(500, {});
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    try {
      await resolver.resolveInstallationId(OWNER, REPO);
    } catch (e) {
      expect(String(e)).not.toContain("Authorization");
      expect(String(e)).not.toContain("Bearer");
    }
  });

  it("response body is not echoed", async () => {
    const secretBody = { message: "secret leak", token: "ghs_xxx" };
    const fetchFn: typeof fetch = async () =>
      createMockResponse(404, secretBody);
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
    });
    try {
      await resolver.resolveInstallationId(OWNER, REPO);
    } catch (e) {
      expect(String(e)).not.toContain("secret leak");
      expect(JSON.stringify(e)).not.toContain("ghs_xxx");
    }
  });
});

describe("Integration with Batch 34", () => {
  it("dynamic resolver + token client + Batch 30 provider → ResolvedSource", async () => {
    const installationId = 12345;
    const apiResolverFetch: typeof fetch = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toMatch(/^Bearer /);
      const urlStr = String(url);
      if (urlStr.includes("/repos/") && urlStr.includes("/installation")) {
        expect(urlStr).toBe(
          `https://api.github.com/repos/${OWNER}/${REPO}/installation`,
        );
        return createMockResponse(200, { id: installationId });
      }
      throw new Error(`unexpected url ${urlStr}`);
    };

    const tokenFetch: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("/access_tokens")) {
        expect(urlStr).toBe(
          `https://api.github.com/app/installations/${installationId}/access_tokens`,
        );
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers.Authorization).toMatch(/^Bearer /);
        return createMockResponse(200, {
          token: "ghs_dynamic_token",
          expires_at: "2024-01-01T00:00:00Z",
        });
      }
      throw new Error(`unexpected token url ${urlStr}`);
    };

    const sourceFetch: typeof fetch = async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ghs_dynamic_token");
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, { tree: [], truncated: false });
      return createMockResponse(404, {});
    };

    // Combine into one fetch that handles all three phases for simplicity
    const combinedFetch: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      if (
        urlStr.includes("/repos/") &&
        urlStr.includes("/installation") &&
        !urlStr.includes("/access_tokens")
      ) {
        return apiResolverFetch(url, init);
      }
      if (urlStr.includes("/access_tokens")) {
        return tokenFetch(url, init);
      }
      return sourceFetch(url, init);
    };

    const { createGitHubAppInstallationTokenClient } =
      await import("../packages/adapters-source/src/github-app.js");
    const installationResolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: combinedFetch,
    });
    const tokenClient = createGitHubAppInstallationTokenClient({
      appConfig: APP_CONFIG,
      fetch: combinedFetch,
    });

    const provider = createGitHubAppSourceProvider({
      installationResolver,
      installationTokenClient: tokenClient,
      fetch: combinedFetch,
    });

    const result = await provider.resolveSnapshot({
      kind: "github-snapshot",
      owner: OWNER,
      repository: REPO,
      sha: SHA,
    });

    expect(result.snapshot.commitSha).toBe(SHA);
    expect(result.snapshot.source.provider).toBe("github");
    expect(JSON.stringify(result)).not.toContain("ghs_dynamic_token");
  });

  it("installation token used only after discovery succeeds", async () => {
    let tokenCalled = false;
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: async () => createMockResponse(404, {}),
    });
    const tokenClient = {
      createInstallationToken: async () => {
        tokenCalled = true;
        return { token: "ghs_t", expiresAt: "2024-01-01T00:00:00Z" };
      },
    } as never;
    const provider = createGitHubAppSourceProvider({
      installationResolver: resolver,
      installationTokenClient: tokenClient,
      fetch: async () => createMockResponse(200, { sha: SHA }),
    });
    await expect(
      provider.resolveSnapshot({
        kind: "github-snapshot",
        owner: OWNER,
        repository: REPO,
        sha: SHA,
      }),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
    expect(tokenCalled).toBe(false);
  });

  it("rejects http apiBaseUrl before fetch", async () => {
    const fetchFn = vi.fn(async () => createMockResponse(200, { id: 1 }));
    expect(() =>
      createGitHubApiInstallationResolver({
        appConfig: APP_CONFIG,
        apiBaseUrl: "http://example.test",
        fetch: fetchFn as never,
      }),
    ).toThrow(GitHubAppConfigurationError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("http rejection exposes no JWT or private key", () => {
    try {
      createGitHubApiInstallationResolver({
        appConfig: APP_CONFIG,
        apiBaseUrl: "http://example.test",
        fetch: async () => createMockResponse(200, { id: 1 }),
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GitHubAppConfigurationError);
      expect(String(e)).not.toContain(APP_CONFIG.privateKey);
      expect(String(e)).not.toMatch(/eyJ/);
      expect(String(e)).not.toContain("Authorization");
    }
  });

  it("slow response body times out without leaking credentials", async () => {
    const fetchFn: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => new Promise(() => {}),
      }) as unknown as Response;
    const resolver = createGitHubApiInstallationResolver({
      appConfig: APP_CONFIG,
      fetch: fetchFn,
      timeoutMs: 10,
    });
    let err: unknown;
    try {
      await resolver.resolveInstallationId(OWNER, REPO);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitHubInstallationTokenError);
    expect(String(err)).toContain("timed out");
    expect(String(err)).not.toContain(APP_CONFIG.privateKey);
    expect(String(err)).not.toMatch(/eyJ/);
    expect(String(err)).not.toContain("Authorization");
  });

  it("fast response succeeds and clears the timer", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const fetchFn: typeof fetch = async () =>
        createMockResponse(200, { id: 4242 });
      const resolver = createGitHubApiInstallationResolver({
        appConfig: APP_CONFIG,
        fetch: fetchFn,
        timeoutMs: 10,
      });
      await expect(resolver.resolveInstallationId(OWNER, REPO)).resolves.toBe(
        4242,
      );
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });

  it("error response clears the timer", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    try {
      const fetchFn: typeof fetch = async () => createMockResponse(200, {});
      const resolver = createGitHubApiInstallationResolver({
        appConfig: APP_CONFIG,
        fetch: fetchFn,
        timeoutMs: 10,
      });
      await expect(
        resolver.resolveInstallationId(OWNER, REPO),
      ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });

  it("requested SHA remains unchanged", async () => {
    const resolver = createStaticGitHubInstallationResolver({
      "octocat/hello-world": 123,
    });
    const tokenClient = {
      createInstallationToken: async () => ({
        token: "ghs_t",
        expiresAt: "2024-01-01T00:00:00Z",
      }),
    } as never;
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
      installationTokenClient: tokenClient,
      fetch: fetchFn,
    });
    const result = await provider.resolveSnapshot({
      kind: "github-snapshot",
      owner: OWNER,
      repository: REPO,
      sha: SHA,
    });
    expect(result.snapshot.sourceState.value).toBe(SHA);
    expect(result.snapshot.commitSha).toBe(SHA);
  });
});
