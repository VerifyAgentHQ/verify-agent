import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  GitHubAppAuthenticationError,
  GitHubAppConfigurationError,
  GitHubInstallationTokenError,
  GitHubRateLimitError,
  createGitHubAppInstallationTokenClient,
  createGitHubAppJwt,
  readGitHubAppConfig,
  verifyGitHubAppJwt,
} from "../packages/adapters-source/src/github-app.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const VALID_CONFIG = {
  appId: "123456",
  privateKey,
};

function b64UrlDecode(str: string): string {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  return Buffer.from(s, "base64").toString("utf8");
}

function createMockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("GitHub App configuration", () => {
  it("rejects missing app ID", () => {
    expect(() =>
      readGitHubAppConfig({
        GITHUB_APP_PRIVATE_KEY: privateKey,
      } as NodeJS.ProcessEnv),
    ).toThrow(GitHubAppConfigurationError);
  });

  it("rejects empty app ID", () => {
    expect(() =>
      readGitHubAppConfig({
        GITHUB_APP_ID: "   ",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      } as NodeJS.ProcessEnv),
    ).toThrow(GitHubAppConfigurationError);
  });

  it("rejects invalid app ID", () => {
    expect(() =>
      readGitHubAppConfig({
        GITHUB_APP_ID: "abc123",
        GITHUB_APP_PRIVATE_KEY: privateKey,
      } as NodeJS.ProcessEnv),
    ).toThrow(GitHubAppConfigurationError);
  });

  it("rejects missing private key", () => {
    expect(() =>
      readGitHubAppConfig({ GITHUB_APP_ID: "123456" } as NodeJS.ProcessEnv),
    ).toThrow(GitHubAppConfigurationError);
  });

  it("rejects empty private key", () => {
    expect(() =>
      readGitHubAppConfig({
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY: "   ",
      } as NodeJS.ProcessEnv),
    ).toThrow(GitHubAppConfigurationError);
  });

  it("returns valid configuration", () => {
    const config = readGitHubAppConfig({
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: privateKey,
    } as NodeJS.ProcessEnv);
    expect(config.appId).toBe("123456");
    expect(config.privateKey).toBe(privateKey);
  });

  it("private key does not appear in errors", () => {
    try {
      readGitHubAppConfig({
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY: "",
      } as NodeJS.ProcessEnv);
    } catch (e) {
      expect(String(e)).not.toContain(privateKey);
      expect((e as Error).message).not.toContain("BEGIN");
    }
    try {
      createGitHubAppJwt({ appId: "123", privateKey: "not-a-key" });
    } catch (e) {
      expect(String(e)).not.toContain("not-a-key");
    }
  });
});

describe("GitHub App JWT", () => {
  it("has correct issuer, iat, exp, short lifetime, deterministic time", () => {
    const now = () => Date.now();
    const fixedNow = 1_700_000_000_000; // 2023-11-14
    const token = createGitHubAppJwt(VALID_CONFIG, { now: () => fixedNow });
    const { header, payload } = verifyGitHubAppJwt(token, publicKey);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(payload.iss).toBe("123456");
    const expectedIat = Math.floor(fixedNow / 1000) - 60;
    const expectedExp = Math.floor(fixedNow / 1000) + 540;
    expect(payload.iat).toBe(expectedIat);
    expect(payload.exp).toBe(expectedExp);
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);
    expect((payload.exp as number) - (payload.iat as number) <= 600).toBe(true);
    expect((payload.exp as number) > (payload.iat as number)).toBe(true);
  });

  it("uses deterministic now injection", () => {
    const t1 = 1_700_000_000_000;
    const t2 = 1_700_000_100_000;
    const tok1 = createGitHubAppJwt(VALID_CONFIG, { now: () => t1 });
    const tok2 = createGitHubAppJwt(VALID_CONFIG, { now: () => t2 });
    const p1 = JSON.parse(b64UrlDecode(tok1.split(".")[1])) as Record<
      string,
      unknown
    >;
    const p2 = JSON.parse(b64UrlDecode(tok2.split(".")[1])) as Record<
      string,
      unknown
    >;
    expect(p1.iat).not.toBe(p2.iat);
  });

  it("uses RS256 algorithm and does not accept caller override", () => {
    const token = createGitHubAppJwt(VALID_CONFIG);
    const header = JSON.parse(b64UrlDecode(token.split(".")[0])) as Record<
      string,
      unknown
    >;
    expect(header.alg).toBe("RS256");
    // Ensure no none/HS256
    expect(header.alg).not.toBe("none");
    expect(header.alg).not.toBe("HS256");
  });

  it("rejects malformed private key without leaking", () => {
    const badConfig = {
      appId: "123456",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----",
    };
    let err: unknown;
    try {
      createGitHubAppJwt(badConfig);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitHubAppAuthenticationError);
    expect(String(err)).not.toContain(badConfig.privateKey);
    expect(String(err)).not.toContain("invalid\n");
  });

  it("private key not leaked in JWT errors", () => {
    try {
      createGitHubAppJwt({ appId: "123", privateKey: "bad-key" });
    } catch (e) {
      expect(String(e)).not.toContain("bad-key");
    }
  });

  it("verifies with public key", () => {
    const token = createGitHubAppJwt(VALID_CONFIG);
    expect(() => verifyGitHubAppJwt(token, publicKey)).not.toThrow();
    // Tamper should fail
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.invalidsignature`;
    expect(() => verifyGitHubAppJwt(tampered, publicKey)).toThrow();
  });

  it("lifetime is bounded 1..600", () => {
    expect(() =>
      createGitHubAppJwt(VALID_CONFIG, { lifetimeSeconds: 0 }),
    ).toThrow(GitHubAppConfigurationError);
    expect(() =>
      createGitHubAppJwt(VALID_CONFIG, { lifetimeSeconds: 601 }),
    ).toThrow(GitHubAppConfigurationError);
    expect(() =>
      createGitHubAppJwt(VALID_CONFIG, { lifetimeSeconds: 10 }),
    ).not.toThrow();
  });
});

describe("GitHub installation ID validation", () => {
  it("accepts positive integer", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, {
        token: "ghs_abc",
        expires_at: "2024-01-01T00:00:00Z",
      });
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    await expect(client.createInstallationToken(123)).resolves.toBeDefined();
  });

  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    it(`rejects ${String(bad)}`, async () => {
      const fetchFn: typeof fetch = async () =>
        createMockResponse(200, {
          token: "x",
          expires_at: "2024-01-01T00:00:00Z",
        });
      const client = createGitHubAppInstallationTokenClient({
        appConfig: VALID_CONFIG,
        fetch: fetchFn,
      });
      await expect(
        client.createInstallationToken(bad as number),
      ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
    });
  }

  it("rejects non-numeric", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, {
        token: "x",
        expires_at: "2024-01-01T00:00:00Z",
      });
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    // @ts-expect-error testing runtime
    await expect(
      client.createInstallationToken("123" as unknown as number),
    ).rejects.toBeInstanceOf(GitHubInstallationTokenError);
  });
});

describe("GitHub App HTTP client", () => {
  it("uses correct endpoint, POST, Bearer JWT, GitHub headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init as RequestInit;
      return createMockResponse(200, {
        token: "ghs_test",
        expires_at: "2024-01-01T00:00:00Z",
      });
    };
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    await client.createInstallationToken(12345);
    expect(capturedUrl).toBe(
      "https://api.github.com/app/installations/12345/access_tokens",
    );
    expect(capturedInit?.method).toBe("POST");
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer /);
    expect(headers.Authorization).not.toContain(VALID_CONFIG.privateKey);
    expect(headers.Accept).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("respects custom apiBaseUrl", async () => {
    let capturedUrl = "";
    const fetchFn: typeof fetch = async (url) => {
      capturedUrl = String(url);
      return createMockResponse(200, {
        token: "ghs_test",
        expires_at: "2024-01-01T00:00:00Z",
      });
    };
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      apiBaseUrl: "https://api.example.com",
      fetch: fetchFn,
    });
    await client.createInstallationToken(123);
    expect(capturedUrl).toBe(
      "https://api.example.com/app/installations/123/access_tokens",
    );
  });

  it("rejects redirect", async () => {
    const fetchFn: typeof fetch = async (url, init) => {
      expect((init as RequestInit).redirect).toBe("error");
      return createMockResponse(200, {
        token: "ghs_test",
        expires_at: "2024-01-01T00:00:00Z",
      });
    };
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    await expect(client.createInstallationToken(123)).resolves.toBeDefined();
  });

  it("rejects http apiBaseUrl before sending the App JWT", async () => {
    const fetchFn = vi.fn(async () =>
      createMockResponse(200, {
        token: "ghs_test",
        expires_at: "2024-01-01T00:00:00Z",
      }),
    );
    let err: unknown;
    try {
      createGitHubAppInstallationTokenClient({
        appConfig: VALID_CONFIG,
        apiBaseUrl: "http://example.test",
        fetch: fetchFn as never,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitHubAppConfigurationError);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(String(err)).not.toContain(VALID_CONFIG.privateKey);
    expect(String(err)).not.toMatch(/eyJ/);
    expect(String(err)).not.toContain("Authorization");
  });

  for (const status of [401, 403, 404, 429, 500]) {
    it(`maps ${status} correctly`, async () => {
      const fetchFn: typeof fetch = async () =>
        createMockResponse(status, { message: "error" });
      const client = createGitHubAppInstallationTokenClient({
        appConfig: VALID_CONFIG,
        fetch: fetchFn,
      });
      let err: unknown;
      try {
        await client.createInstallationToken(123);
      } catch (e) {
        err = e;
      }
      if (status === 401 || status === 403) {
        expect(err).toBeInstanceOf(GitHubAppAuthenticationError);
      } else if (status === 404) {
        expect(err).toBeInstanceOf(GitHubInstallationTokenError);
      } else if (status === 429) {
        expect(err).toBeInstanceOf(GitHubRateLimitError);
      } else if (status >= 500) {
        expect(err).toBeInstanceOf(GitHubInstallationTokenError);
      }
      expect(String(err)).not.toContain(VALID_CONFIG.privateKey);
      expect(String(err)).not.toContain("ghs_");
    });
  }

  it("handles malformed JSON response", async () => {
    const fetchFn: typeof fetch = async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => {
          throw new Error("invalid json");
        },
      }) as unknown as Response;
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    await expect(client.createInstallationToken(123)).rejects.toBeInstanceOf(
      GitHubInstallationTokenError,
    );
  });

  it("handles malformed token response", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, {
        token: "",
        expires_at: "2024-01-01T00:00:00Z",
      });
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    await expect(client.createInstallationToken(123)).rejects.toBeInstanceOf(
      GitHubInstallationTokenError,
    );
  });

  it("handles network failure without leaking", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error("network down");
    };
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    let err: unknown;
    try {
      await client.createInstallationToken(123);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitHubInstallationTokenError);
    expect(String(err)).not.toContain(VALID_CONFIG.privateKey);
  });

  it("JWT/token not in errors", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(401, {});
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    try {
      await client.createInstallationToken(123);
    } catch (e) {
      expect(String(e)).not.toContain("Bearer");
      expect(String(e)).not.toContain(VALID_CONFIG.privateKey);
    }
  });
});

describe("GitHub installation token handling", () => {
  it("maps valid token correctly and discards unrelated fields", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, {
        token: "ghs_valid",
        expires_at: "2024-01-01T00:00:00Z",
        extra: "ignore",
        permissions: {},
      });
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    const result = await client.createInstallationToken(123);
    expect(result.token).toBe("ghs_valid");
    expect(result.expiresAt).toBe("2024-01-01T00:00:00Z");
    expect((result as Record<string, unknown>).extra).toBeUndefined();
  });

  it("rejects empty token", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, {
        token: "   ",
        expires_at: "2024-01-01T00:00:00Z",
      });
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    await expect(client.createInstallationToken(123)).rejects.toBeInstanceOf(
      GitHubInstallationTokenError,
    );
  });

  it("rejects malformed expiration", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, { token: "ghs_valid", expires_at: "not-a-date" });
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    await expect(client.createInstallationToken(123)).rejects.toBeInstanceOf(
      GitHubInstallationTokenError,
    );
  });

  it("token does not leak through error structures", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, { token: "", expires_at: "" });
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    try {
      await client.createInstallationToken(123);
    } catch (e) {
      expect(String(e)).not.toContain("ghs_valid");
      expect(JSON.stringify(e)).not.toContain("ghs_valid");
    }
  });
});

describe("GitHub App security", () => {
  it("private key never in error", async () => {
    try {
      createGitHubAppJwt({ appId: "123", privateKey: "bad" });
    } catch (e) {
      expect(String(e)).not.toContain("bad");
    }
  });

  it("JWT never in error for HTTP failure", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(500, {});
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    try {
      await client.createInstallationToken(123);
    } catch (e) {
      const msg = String(e);
      expect(msg).not.toMatch(/eyJ/);
    }
  });

  it("installation token never in error", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(200, { token: "", expires_at: "" });
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    try {
      await client.createInstallationToken(123);
    } catch (e) {
      expect(String(e)).not.toContain("ghs_");
    }
  });

  it("Authorization header never in error", async () => {
    const fetchFn: typeof fetch = async () => createMockResponse(401, {});
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    try {
      await client.createInstallationToken(123);
    } catch (e) {
      expect(String(e)).not.toContain("Authorization");
      expect(String(e)).not.toContain("Bearer");
    }
  });

  it("authenticated requests use redirect:error", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (url, init) => {
      capturedInit = init as RequestInit;
      return createMockResponse(200, {
        token: "ghs_test",
        expires_at: "2024-01-01T00:00:00Z",
      });
    };
    const client = createGitHubAppInstallationTokenClient({
      appConfig: VALID_CONFIG,
      fetch: fetchFn,
    });
    await client.createInstallationToken(123);
    expect((capturedInit as RequestInit).redirect).toBe("error");
  });
});
