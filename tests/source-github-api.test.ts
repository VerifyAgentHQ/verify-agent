import { describe, expect, it } from "vitest";
import {
  GitHubAuthenticationError,
  GitHubProviderError,
  GitHubRateLimitError,
  createGitHubApiSourceProvider,
  createGitHubSourceResolver,
  encodeGitHubSnapshotReference,
} from "../packages/adapters-source/src/github.js";
import { InvalidSourceReferenceError } from "../packages/adapters-source/src/resolver.js";

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";

const REFERENCE = {
  kind: "github-snapshot" as const,
  owner: OWNER,
  repository: REPOSITORY,
  sha: SHA,
};

const BLOB_A = "a".repeat(40);
const BLOB_B = "b".repeat(40);
const BLOB_C = "c".repeat(40);
const BLOB_D = "d".repeat(40);
const BLOB_E = "e".repeat(40);
const BLOB_F = "f".repeat(40);

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function binaryB64(): string {
  return Buffer.from([0x00, 0x01, 0x02, 0x48, 0x65]).toString("base64");
}

type FetchCall = { url: string; init?: RequestInit };

function createMockResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("GitHub API source provider", () => {
  it("resolves commit, tree, and blobs into snapshot and source contents", async () => {
    const calls: FetchCall[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      const urlStr = String(url);
      calls.push({ url: urlStr, init });
      if (urlStr.includes(`/commits/${SHA}`)) {
        return createMockResponse(200, { sha: SHA });
      }
      if (urlStr.includes(`/git/trees/${SHA}`)) {
        return createMockResponse(200, {
          sha: SHA,
          tree: [
            {
              path: "package.json",
              mode: "100644",
              type: "blob",
              sha: BLOB_A,
              size: 10,
            },
            {
              path: "src/index.ts",
              mode: "100644",
              type: "blob",
              sha: BLOB_B,
              size: 20,
            },
            { path: "src", mode: "040000", type: "tree", sha: BLOB_C },
          ],
          truncated: false,
        });
      }
      if (urlStr.includes(`/git/blobs/${BLOB_A}`)) {
        return createMockResponse(200, {
          sha: BLOB_A,
          content: b64('{"name":"fixture"}'),
          encoding: "base64",
          size: 10,
        });
      }
      if (urlStr.includes(`/git/blobs/${BLOB_B}`)) {
        return createMockResponse(200, {
          sha: BLOB_B,
          content: b64("export const v=42;\n"),
          encoding: "base64",
          size: 20,
        });
      }
      return createMockResponse(404, { message: "not found" });
    };

    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    const result = await provider.resolveSnapshot(REFERENCE);

    expect(result.snapshot.source.provider).toBe("github");
    expect(result.snapshot.source.reference).toBe(SHA);
    expect(result.snapshot.sourceState).toEqual({ type: "commit", value: SHA });
    expect(result.snapshot.commitSha).toBe(SHA);
    expect(result.snapshot.projectId).toBe(`${OWNER}--${REPOSITORY}`);
    expect(result.snapshot.id).toBe(`${OWNER}--${REPOSITORY}--${SHA}`);
    expect(result.sourceContents).toEqual({
      "package.json": '{"name":"fixture"}',
      "src/index.ts": "export const v=42;\n",
    });
    expect(calls.length).toBe(4);
    expect(calls.every((c) => !c.url.includes("evil"))).toBe(true);
    expect(Object.isFrozen(result.sourceContents)).toBe(true);
    expect(Object.isFrozen(result.snapshot)).toBe(true);
  });

  it("fails closed on SHA mismatch", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/")) {
        return createMockResponse(200, {
          sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      InvalidSourceReferenceError,
    );
  });

  it("maps 404 to InvalidSourceReferenceError", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(404, { message: "not found" });
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      InvalidSourceReferenceError,
    );
  });

  it("maps 401/403 to GitHubAuthenticationError without token leakage", async () => {
    const secret = "ghp_secrettoken123";
    for (const status of [401, 403]) {
      const fetchFn: typeof fetch = async () =>
        createMockResponse(status, { message: "auth" });
      const provider = createGitHubApiSourceProvider({
        token: secret,
        fetch: fetchFn,
      });
      let error: unknown;
      try {
        await provider.resolveSnapshot(REFERENCE);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(GitHubAuthenticationError);
      expect(String((error as Error).message)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it("maps 429 to GitHubRateLimitError", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(429, { message: "rate" });
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  it("maps 500 to GitHubProviderError without leaking body", async () => {
    const fetchFn: typeof fetch = async () =>
      createMockResponse(500, { secret: "leak" });
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    let error: unknown;
    try {
      await provider.resolveSnapshot(REFERENCE);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(GitHubProviderError);
    expect(String((error as Error).message)).not.toContain("leak");
    expect(JSON.stringify(error)).not.toContain("leak");
  });

  it("skips binary content deterministically", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            { path: "text.txt", mode: "100644", type: "blob", sha: BLOB_A },
            { path: "binary.bin", mode: "100644", type: "blob", sha: BLOB_B },
          ],
          truncated: false,
        });
      }
      if (urlStr.includes(BLOB_A)) {
        return createMockResponse(200, {
          content: b64("hello text"),
          encoding: "base64",
          size: 10,
        });
      }
      if (urlStr.includes(BLOB_B)) {
        return createMockResponse(200, {
          content: binaryB64(),
          encoding: "base64",
          size: 5,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    const result = await provider.resolveSnapshot(REFERENCE);
    expect(result.sourceContents["text.txt"]).toBe("hello text");
    expect(result.sourceContents["binary.bin"]).toBeUndefined();
    expect(Object.keys(result.sourceContents)).toEqual(["text.txt"]);
  });

  it("rejects unsafe tree paths", async () => {
    const cases = [
      "../evil",
      "/absolute",
      "..\\evil",
      "C:\\evil",
      "a//b",
      "a/../b",
    ];
    for (const evilPath of cases) {
      const fetchFn: typeof fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes("/commits/"))
          return createMockResponse(200, { sha: SHA });
        if (urlStr.includes("/git/trees/")) {
          return createMockResponse(200, {
            tree: [
              { path: evilPath, mode: "100644", type: "blob", sha: BLOB_A },
            ],
            truncated: false,
          });
        }
        return createMockResponse(404, {});
      };
      const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
      await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
        GitHubProviderError,
      );
    }
  });

  it("fails when file count exceeds limit", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            { path: "a.txt", mode: "100644", type: "blob", sha: BLOB_A },
            { path: "b.txt", mode: "100644", type: "blob", sha: BLOB_B },
          ],
          truncated: false,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({
      fetch: fetchFn,
      maxFiles: 1,
    });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });

  it("fails when per-file size exceeds limit", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            {
              path: "big.txt",
              mode: "100644",
              type: "blob",
              sha: BLOB_A,
              size: 999999,
            },
          ],
          truncated: false,
        });
      }
      if (urlStr.includes("/git/blobs/")) {
        return createMockResponse(200, {
          content: b64("x"),
          encoding: "base64",
          size: 999999,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({
      fetch: fetchFn,
      maxFileBytes: 100,
    });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });

  it("fails when total bytes exceeds limit", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            { path: "a.txt", mode: "100644", type: "blob", sha: BLOB_A },
            { path: "b.txt", mode: "100644", type: "blob", sha: BLOB_B },
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
    const provider = createGitHubApiSourceProvider({
      fetch: fetchFn,
      maxTotalBytes: 5,
    });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });

  it("fails on truncated tree", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, { tree: [], truncated: true });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });

  it("sends token only to configured API and never leaks it", async () => {
    const token = "ghp_testtoken123456";
    const customBase = "https://api.example.com";
    const calls: FetchCall[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, { tree: [], truncated: false });
      return createMockResponse(404, {});
    };

    const provider = createGitHubApiSourceProvider({
      token,
      apiBaseUrl: customBase,
      fetch: fetchFn,
    });
    await provider.resolveSnapshot(REFERENCE);

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith(customBase)).toBe(true);
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${token}`);
    }

    const failingFetch: typeof fetch = async () => createMockResponse(500, {});
    const failingProvider = createGitHubApiSourceProvider({
      token,
      fetch: failingFetch,
    });
    let err: unknown;
    try {
      await failingProvider.resolveSnapshot(REFERENCE);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitHubProviderError);
    expect(String(err)).not.toContain(token);
    const result = await provider.resolveSnapshot(REFERENCE);
    expect(JSON.stringify(result.snapshot)).not.toContain(token);
    expect(JSON.stringify(result.sourceContents)).not.toContain(token);
  });

  it("does not expose token when token not supplied", async () => {
    const calls: FetchCall[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, { tree: [], truncated: false });
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await provider.resolveSnapshot(REFERENCE);
    for (const call of calls) {
      const headers = (call.init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    }
  });

  it("validates branch/tag refs are rejected before network", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error("should not be called");
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await expect(
      provider.resolveSnapshot({
        kind: "github-snapshot",
        owner: OWNER,
        repository: REPOSITORY,
        sha: "main",
      }),
    ).rejects.toBeInstanceOf(InvalidSourceReferenceError);
    await expect(
      provider.resolveSnapshot({
        kind: "github-snapshot",
        owner: OWNER,
        repository: REPOSITORY,
        sha: "https://github.com/o/r",
      }),
    ).rejects.toBeInstanceOf(InvalidSourceReferenceError);
  });

  it("integrates via createGitHubSourceResolver -> SourceResolver", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            {
              path: "package.json",
              mode: "100644",
              type: "blob",
              sha: BLOB_A,
            },
          ],
          truncated: false,
        });
      }
      if (urlStr.includes(BLOB_A)) {
        return createMockResponse(200, {
          content: b64('{"ok":true}'),
          encoding: "base64",
          size: 10,
        });
      }
      return createMockResponse(404, {});
    };
    const apiProvider = createGitHubApiSourceProvider({ fetch: fetchFn });
    const resolver = createGitHubSourceResolver(apiProvider);
    const encoded = encodeGitHubSnapshotReference(REFERENCE);
    const result = await resolver.resolveSnapshot({
      kind: "snapshot",
      id: encoded,
    });
    expect(result.snapshot.commitSha).toBe(SHA);
    expect(result.sourceContents["package.json"]).toBe('{"ok":true}');

    await expect(
      resolver.resolveSnapshot({ kind: "snapshot", id: "bad:id" }),
    ).rejects.toBeInstanceOf(InvalidSourceReferenceError);
  });

  it("does not follow arbitrary URLs from API responses", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/")) {
        return createMockResponse(200, {
          sha: SHA,
          url: "https://evil.com/steal",
        });
      }
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            {
              path: "a.txt",
              mode: "100644",
              type: "blob",
              sha: BLOB_A,
              url: "https://evil.com/blob",
            },
          ],
          truncated: false,
        });
      }
      if (urlStr.includes("/git/blobs/")) {
        return createMockResponse(200, {
          content: b64("safe"),
          encoding: "base64",
          size: 4,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    const result = await provider.resolveSnapshot(REFERENCE);
    expect(result.sourceContents["a.txt"]).toBe("safe");
  });

  it("handles network failure as GitHubProviderError without leakage", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error("network down");
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });

  it("passes redirect: error to every fetch", async () => {
    const calls: FetchCall[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, {
          tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: BLOB_A }],
          truncated: false,
        });
      if (urlStr.includes("/git/blobs/"))
        return createMockResponse(200, {
          content: b64("hi"),
          encoding: "base64",
          size: 2,
        });
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await provider.resolveSnapshot(REFERENCE);
    expect(calls.length).toBe(3);
    for (const call of calls) {
      expect((call.init as RequestInit & { redirect?: string }).redirect).toBe(
        "error",
      );
      expect(call.init?.method).toBe("GET");
    }
  });

  it("fails safely on redirect and does not leak token", async () => {
    const token = "ghp_redirect_secret";
    const fetchFn: typeof fetch = async () => {
      throw new TypeError("redirect");
    };
    const provider = createGitHubApiSourceProvider({ token, fetch: fetchFn });
    let err: unknown;
    try {
      await provider.resolveSnapshot(REFERENCE);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GitHubProviderError);
    expect(String(err)).not.toContain(token);
    expect(String(err)).not.toContain("redirect");
  });

  it("rejects http base URL with token", () => {
    expect(() =>
      createGitHubApiSourceProvider({
        token: "ghp_secret",
        apiBaseUrl: "http://api.github.com",
        fetch: async () => createMockResponse(200, {}),
      }),
    ).toThrow(InvalidSourceReferenceError);
  });

  it("allows https base URL with token", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, { tree: [], truncated: false });
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({
      token: "ghp_secret",
      apiBaseUrl: "https://api.github.com",
      fetch: fetchFn,
    });
    await expect(provider.resolveSnapshot(REFERENCE)).resolves.toBeDefined();
  });

  it("allows http base URL without token", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/"))
        return createMockResponse(200, { tree: [], truncated: false });
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({
      apiBaseUrl: "http://api.example.com",
      fetch: fetchFn,
    });
    await expect(provider.resolveSnapshot(REFERENCE)).resolves.toBeDefined();
  });

  it("rejects apiBaseUrl with embedded credentials", () => {
    expect(() =>
      createGitHubApiSourceProvider({
        apiBaseUrl: "https://user:pass@api.github.com",
        fetch: async () => createMockResponse(200, {}),
      }),
    ).toThrow(InvalidSourceReferenceError);
    expect(() =>
      createGitHubApiSourceProvider({
        apiBaseUrl: "https://user:pass@example.com",
        fetch: async () => createMockResponse(200, {}),
      }),
    ).toThrow(InvalidSourceReferenceError);
  });

  it("rejects invalid base64 content", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: BLOB_A }],
          truncated: false,
        });
      }
      if (urlStr.includes("/git/blobs/")) {
        return createMockResponse(200, {
          content: "!!!",
          encoding: "base64",
          size: 10,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });

  it("accepts valid base64 with padding", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [{ path: "a.txt", mode: "100644", type: "blob", sha: BLOB_A }],
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
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    const result = await provider.resolveSnapshot(REFERENCE);
    expect(result.sourceContents["a.txt"]).toBe("hello");
  });

  it("rejects invalid blob SHA before blob fetch", async () => {
    let blobFetched = false;
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
      if (urlStr.includes("/git/blobs/")) {
        blobFetched = true;
        return createMockResponse(200, {
          content: b64("x"),
          encoding: "base64",
          size: 1,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({ fetch: fetchFn });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
    expect(blobFetched).toBe(false);
  });

  it("fails early when tree is larger than maxFiles*2", async () => {
    const fetchFn: typeof fetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes("/commits/"))
        return createMockResponse(200, { sha: SHA });
      if (urlStr.includes("/git/trees/")) {
        return createMockResponse(200, {
          tree: [
            { path: "a.txt", mode: "100644", type: "blob", sha: BLOB_A },
            { path: "b.txt", mode: "100644", type: "blob", sha: BLOB_B },
            { path: "c.txt", mode: "100644", type: "blob", sha: BLOB_C },
          ],
          truncated: false,
        });
      }
      return createMockResponse(404, {});
    };
    const provider = createGitHubApiSourceProvider({
      fetch: fetchFn,
      maxFiles: 1,
    });
    await expect(provider.resolveSnapshot(REFERENCE)).rejects.toBeInstanceOf(
      GitHubProviderError,
    );
  });
});
