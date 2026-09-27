/**
 * Batch 54A — Explicit GitHub token authentication mode.
 *
 * Corrective fix for the Batch 54 review finding: an ambient `GITHUB_TOKEN`
 * must never silently become the acquisition credential. The semantics are:
 *
 * ```text
 * App fully configured → App provider (ambient token never overrides)
 * App partially configured → fail closed (never silent token fallback)
 * No App + explicit GITHUB_SOURCE_AUTH_MODE=token + GITHUB_TOKEN → token
 * No App + no explicit mode → fail closed
 * ```
 *
 * These tests reconfigure `process.env` and `globalThis.fetch` with strict
 * save/restore, use generated RSA keys (never checked-in secrets), and
 * never touch the network, the real snapshot store, or the sandbox.
 */

import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  readGitHubSourceAuthMode,
  selectGitHubSourceAuthKind,
} from "../packages/adapters-source/src/github.js";
import {
  createConfiguredSourceResolver,
  readSandboxProcessEnvironment,
} from "../apps/api/src/index.js";

const ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_TOKEN",
  "GITHUB_SOURCE_AUTH_MODE",
  "GITHUB_API_BASE_URL",
  "VERIFY_SANDBOX_SNAPSHOT_ROOT",
] as const;

const SHA = "a".repeat(40);
const SOURCE_ID = `octocat:hello-world:${SHA}`;
const PERSONAL_TOKEN = "batch54a-test-personal-token";
const INSTALLATION_TOKEN = "batch54a-test-installation-token";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const PRIVATE_KEY_PEM = privateKey;

const savedEnv = new Map<string, string | undefined>();
const savedFetch: typeof globalThis.fetch | undefined =
  typeof globalThis.fetch === "function" ? globalThis.fetch : undefined;

function setEnv(
  values: Partial<Record<(typeof ENV_KEYS)[number], string>>,
): void {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key] as string;
  }
}

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  if (savedFetch !== undefined) globalThis.fetch = savedFetch;
});

interface RecordedFetch {
  readonly url: string;
  readonly authorization: string | undefined;
}

function stubFetch(recorded: RecordedFetch[]): void {
  const json = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  globalThis.fetch = (async (url: unknown, init?: { headers?: unknown }) => {
    const urlText = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    recorded.push({ url: urlText, authorization: headers.Authorization });
    if (urlText.endsWith("/installation")) {
      return json(200, { id: 4242 });
    }
    if (urlText.endsWith("/access_tokens")) {
      return json(200, {
        token: INSTALLATION_TOKEN,
        expires_at: "2030-01-01T00:00:00.000Z",
      });
    }
    const commitMatch = urlText.match(/\/commits\/([0-9a-f]{40})$/i);
    if (commitMatch) {
      return json(200, { sha: (commitMatch[1] as string).toLowerCase() });
    }
    if (/\/git\/trees\/[0-9a-f]{40}\?recursive=1$/i.test(urlText)) {
      return json(200, { sha: SHA, tree: [], truncated: false });
    }
    return json(404, { message: "Not Found" });
  }) as unknown as typeof globalThis.fetch;
}

describe("Batch 54A — auth mode selection", () => {
  it("complete App configuration selects App even with a token present", () => {
    expect(
      selectGitHubSourceAuthKind({
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
        GITHUB_TOKEN: PERSONAL_TOKEN,
      }),
    ).toBe("app");
  });

  it("partial App configuration never selects token (both directions)", () => {
    expect(
      selectGitHubSourceAuthKind({
        GITHUB_APP_ID: "123456",
        GITHUB_TOKEN: PERSONAL_TOKEN,
      }),
    ).toBe("none");
    expect(
      selectGitHubSourceAuthKind({
        GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
        GITHUB_TOKEN: PERSONAL_TOKEN,
      }),
    ).toBe("none");
    // Explicit token mode does not rescue a half-configured App.
    expect(
      selectGitHubSourceAuthKind({
        GITHUB_APP_ID: "123456",
        GITHUB_TOKEN: PERSONAL_TOKEN,
        GITHUB_SOURCE_AUTH_MODE: "token",
      }),
    ).toBe("none");
  });

  it("no App without explicit mode never selects token", () => {
    expect(selectGitHubSourceAuthKind({})).toBe("none");
    expect(selectGitHubSourceAuthKind({ GITHUB_TOKEN: PERSONAL_TOKEN })).toBe(
      "none",
    );
    expect(
      selectGitHubSourceAuthKind({
        GITHUB_TOKEN: PERSONAL_TOKEN,
        GITHUB_SOURCE_AUTH_MODE: "app",
      }),
    ).toBe("none");
    expect(
      selectGitHubSourceAuthKind({
        GITHUB_TOKEN: PERSONAL_TOKEN,
        GITHUB_SOURCE_AUTH_MODE: "banana",
      }),
    ).toBe("none");
  });

  it("explicit token mode with a token selects token", () => {
    expect(
      selectGitHubSourceAuthKind({
        GITHUB_TOKEN: PERSONAL_TOKEN,
        GITHUB_SOURCE_AUTH_MODE: "token",
      }),
    ).toBe("token");
    // Case-insensitive with surrounding whitespace.
    expect(
      selectGitHubSourceAuthKind({
        GITHUB_TOKEN: PERSONAL_TOKEN,
        GITHUB_SOURCE_AUTH_MODE: "  Token ",
      }),
    ).toBe("token");
    // Explicit mode without a credential still fails closed.
    expect(
      selectGitHubSourceAuthKind({ GITHUB_SOURCE_AUTH_MODE: "token" }),
    ).toBe("none");
  });

  it("readGitHubSourceAuthMode normalizes the opt-in", () => {
    expect(readGitHubSourceAuthMode({})).toBeUndefined();
    expect(readGitHubSourceAuthMode({ GITHUB_SOURCE_AUTH_MODE: "token" })).toBe(
      "token",
    );
    expect(readGitHubSourceAuthMode({ GITHUB_SOURCE_AUTH_MODE: "TOKEN" })).toBe(
      "token",
    );
    expect(
      readGitHubSourceAuthMode({ GITHUB_SOURCE_AUTH_MODE: "" }),
    ).toBeUndefined();
    expect(
      readGitHubSourceAuthMode({ GITHUB_SOURCE_AUTH_MODE: "app" }),
    ).toBeUndefined();
  });
});

describe("Batch 54A — configured resolver behavior", () => {
  it("Test 1 — complete App wins; ambient token never used", async () => {
    setEnv({
      GITHUB_APP_ID: "123456",
      GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
      GITHUB_TOKEN: PERSONAL_TOKEN,
    });
    const recorded: RecordedFetch[] = [];
    stubFetch(recorded);
    const resolver = createConfiguredSourceResolver();
    const resolved = await resolver.resolveSnapshot({
      kind: "snapshot",
      id: SOURCE_ID,
    });
    expect(resolved.snapshot.sourceState.value).toBe(SHA);
    // The App flow ran (installation token minted and used)...
    expect(
      recorded.some(
        (request) => request.authorization === `Bearer ${INSTALLATION_TOKEN}`,
      ),
    ).toBe(true);
    // ...and the ambient personal token never authenticated anything.
    for (const request of recorded) {
      expect(request.authorization).not.toBe(`Bearer ${PERSONAL_TOKEN}`);
    }
  });

  it("Test 2 — partial App configuration fails closed without touching the network", async () => {
    for (const partial of [
      { GITHUB_APP_ID: "123456", GITHUB_TOKEN: PERSONAL_TOKEN },
      {
        GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
        GITHUB_TOKEN: PERSONAL_TOKEN,
      },
    ]) {
      setEnv(partial);
      const recorded: RecordedFetch[] = [];
      stubFetch(recorded);
      const resolver = createConfiguredSourceResolver();
      await expect(
        resolver.resolveSnapshot({ kind: "snapshot", id: SOURCE_ID }),
      ).rejects.toMatchObject({ name: "InvalidSourceReferenceError" });
      expect(recorded).toHaveLength(0);
      // Clear only the current iteration's keys; saved originals stay in
      // savedEnv for afterEach restoration.
      for (const key of ENV_KEYS) {
        if (process.env[key] !== undefined) delete process.env[key];
      }
    }
  });

  it("Test 3 — no App and no explicit mode fails closed with a token present", async () => {
    setEnv({ GITHUB_TOKEN: PERSONAL_TOKEN });
    const recorded: RecordedFetch[] = [];
    stubFetch(recorded);
    const resolver = createConfiguredSourceResolver();
    const error = await resolver
      .resolveSnapshot({ kind: "snapshot", id: SOURCE_ID })
      .catch((cause: unknown) => cause);
    expect(error).toMatchObject({ name: "InvalidSourceReferenceError" });
    expect(String((error as Error).message)).not.toContain(PERSONAL_TOKEN);
    expect(recorded).toHaveLength(0);
  });

  it("Test 4 — explicit token mode resolves through the token provider", async () => {
    setEnv({
      GITHUB_TOKEN: PERSONAL_TOKEN,
      GITHUB_SOURCE_AUTH_MODE: "token",
    });
    const recorded: RecordedFetch[] = [];
    stubFetch(recorded);
    const resolver = createConfiguredSourceResolver();
    const resolved = await resolver.resolveSnapshot({
      kind: "snapshot",
      id: SOURCE_ID,
    });
    expect(resolved.snapshot.sourceState.value).toBe(SHA);
    expect(
      recorded.some((request) => request.url.includes(`/commits/${SHA}`)),
    ).toBe(true);
    for (const request of recorded) {
      expect(request.authorization).toBe(`Bearer ${PERSONAL_TOKEN}`);
    }
  });

  it("Test 5 — App credentials and mode flags never reach the sandbox environment", () => {
    expect(
      readSandboxProcessEnvironment({
        VERIFY_SANDBOX_SNAPSHOT_ROOT: "/srv/snapshots",
        VERIFY_SANDBOX_DOCKER_EXECUTABLE: "/usr/bin/docker",
        VERIFY_SANDBOX_DOCKER_HOST: "npipe:////./pipe/docker_engine",
        VERIFY_SANDBOX_SYSTEM_ROOT: "C:\\Windows",
        VERIFY_SANDBOX_TEMP_ROOT: "/tmp/verify",
        GITHUB_TOKEN: PERSONAL_TOKEN,
        GITHUB_APP_ID: "123456",
        GITHUB_APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
        GITHUB_SOURCE_AUTH_MODE: "token",
        GITHUB_WEBHOOK_SECRET: "webhook-secret",
        VERIFY_INTERNAL_RESULT_TOKEN: "result-token",
      }),
    ).toEqual({
      VERIFY_SANDBOX_SNAPSHOT_ROOT: "/srv/snapshots",
      VERIFY_SANDBOX_DOCKER_EXECUTABLE: "/usr/bin/docker",
      VERIFY_SANDBOX_DOCKER_HOST: "npipe:////./pipe/docker_engine",
      VERIFY_SANDBOX_SYSTEM_ROOT: "C:\\Windows",
      VERIFY_SANDBOX_TEMP_ROOT: "/tmp/verify",
    });
  });
});
