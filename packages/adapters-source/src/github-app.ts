import { createPrivateKey, createSign, createVerify } from "node:crypto";
import { InvalidSourceReferenceError } from "./resolver.js";
import type { ResolvedSource } from "./resolver.js";
import {
  createGitHubApiSourceProvider,
  validateGitHubSnapshotReference,
} from "./github.js";
import type { GitHubSourceProvider } from "./github.js";
import {
  GitHubAuthenticationError,
  GitHubProviderError,
  GitHubRateLimitError,
} from "./github.js";
export { GitHubRateLimitError } from "./github.js";

export interface GitHubAppConfig {
  readonly appId: string;
  readonly privateKey: string;
}

export class GitHubAppConfigurationError extends Error {
  constructor(message = "GitHub App configuration error") {
    super(message);
    this.name = "GitHubAppConfigurationError";
  }
}

export class GitHubAppAuthenticationError extends Error {
  constructor(message = "GitHub App authentication failed") {
    super(message);
    this.name = "GitHubAppAuthenticationError";
  }
}

export class GitHubInstallationTokenError extends Error {
  constructor(message = "GitHub installation token error") {
    super(message);
    this.name = "GitHubInstallationTokenError";
  }
}

export function readGitHubAppConfig(env: NodeJS.ProcessEnv): GitHubAppConfig {
  const rawAppId = env.GITHUB_APP_ID;
  const rawKey = env.GITHUB_APP_PRIVATE_KEY;

  if (typeof rawAppId !== "string" || rawAppId.trim().length === 0) {
    throw new GitHubAppConfigurationError("missing GITHUB_APP_ID");
  }
  const appId = rawAppId.trim();
  if (!/^[0-9]+$/.test(appId)) {
    throw new GitHubAppConfigurationError("GITHUB_APP_ID must be numeric");
  }

  if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
    throw new GitHubAppConfigurationError("missing GITHUB_APP_PRIVATE_KEY");
  }
  const privateKey = rawKey;

  // Preserve exactly, but ensure it looks like a private key to catch obvious misconfiguration
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new GitHubAppConfigurationError(
      "GITHUB_APP_PRIVATE_KEY is not a private key",
    );
  }

  return { appId, privateKey };
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  let str = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4;
  if (pad === 2) str += "==";
  else if (pad === 3) str += "=";
  else if (pad !== 0) throw new Error("invalid base64url");
  return Buffer.from(str, "base64");
}

export interface GitHubAppJwtOptions {
  readonly now?: () => number;
  readonly lifetimeSeconds?: number;
}

const DEFAULT_JWT_LIFETIME = 600; // 10 minutes
const CLOCK_SKEW_SECONDS = 60;

export function createGitHubAppJwt(
  config: GitHubAppConfig,
  options: GitHubAppJwtOptions = {},
): string {
  if (typeof config.appId !== "string" || config.appId.trim().length === 0) {
    throw new GitHubAppConfigurationError("appId must be non-empty");
  }
  if (!/^[0-9]+$/.test(config.appId.trim())) {
    throw new GitHubAppConfigurationError("appId must be numeric");
  }
  if (
    typeof config.privateKey !== "string" ||
    config.privateKey.trim().length === 0
  ) {
    throw new GitHubAppConfigurationError("privateKey must be non-empty");
  }

  const nowMs = options.now ? options.now() : Date.now();
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    throw new GitHubAppConfigurationError("now must return a finite number");
  }
  // now may be ms or seconds – detect by magnitude
  const nowSec = nowMs > 1e12 ? Math.floor(nowMs / 1000) : Math.floor(nowMs);
  if (nowSec <= 0) {
    throw new GitHubAppConfigurationError("invalid clock time");
  }

  const lifetime = options.lifetimeSeconds ?? DEFAULT_JWT_LIFETIME;
  if (!Number.isInteger(lifetime) || lifetime <= 0 || lifetime > 600) {
    throw new GitHubAppConfigurationError("lifetime must be integer 1..600");
  }

  const iat = nowSec - CLOCK_SKEW_SECONDS;
  const exp = iat + lifetime;

  if (exp <= iat) {
    throw new GitHubAppConfigurationError("exp must be > iat");
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: config.appId.trim(), iat, exp };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  let privateKeyObject: ReturnType<typeof createPrivateKey>;
  try {
    privateKeyObject = createPrivateKey(config.privateKey);
  } catch {
    throw new GitHubAppAuthenticationError("invalid private key");
  }

  let signature: Buffer;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(privateKeyObject);
  } catch {
    throw new GitHubAppAuthenticationError("failed to sign JWT");
  }

  const signatureB64 = base64UrlEncode(signature);
  return `${signingInput}.${signatureB64}`;
}

// Test-only helper to verify JWT structure
export function verifyGitHubAppJwt(
  token: string,
  publicKey: string,
): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid JWT");
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(
    base64UrlDecode(headerB64).toString("utf8"),
  ) as Record<string, unknown>;
  const payload = JSON.parse(
    base64UrlDecode(payloadB64).toString("utf8"),
  ) as Record<string, unknown>;
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = base64UrlDecode(signatureB64);
  const verifier = createVerify("RSA-SHA256");
  verifier.update(signingInput);
  verifier.end();
  const ok = verifier.verify(publicKey, signature);
  if (!ok) throw new Error("invalid signature");
  return { header, payload };
}

export interface GitHubInstallationToken {
  readonly token: string;
  readonly expiresAt: string;
}

export interface GitHubAppInstallationTokenClientOptions {
  readonly appConfig: GitHubAppConfig;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export interface GitHubAppInstallationTokenClient {
  createInstallationToken(
    installationId: number,
  ): Promise<GitHubInstallationToken>;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";

function normalizeApiBaseUrl(
  value?: string,
  options?: { readonly requireHttps?: boolean },
): string {
  const base = (value ?? DEFAULT_API_BASE_URL).trim().replace(/\/+$/, "");
  if (base.length === 0) return DEFAULT_API_BASE_URL;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new GitHubAppConfigurationError("apiBaseUrl must be http or https");
    }
    if (options?.requireHttps === true && url.protocol !== "https:") {
      throw new GitHubAppConfigurationError(
        "apiBaseUrl must be https for authenticated requests",
      );
    }
    if (url.username || url.password) {
      throw new GitHubAppConfigurationError(
        "apiBaseUrl must not contain credentials",
      );
    }
    if (base.includes("..")) {
      throw new GitHubAppConfigurationError(
        "apiBaseUrl must not contain traversal",
      );
    }
  } catch (error) {
    if (
      error instanceof GitHubAppConfigurationError ||
      (error instanceof Error && error.name === "GitHubAppConfigurationError")
    ) {
      throw error;
    }
    throw new GitHubAppConfigurationError("invalid apiBaseUrl");
  }
  return base;
}

function validateInstallationId(value: unknown): number {
  if (typeof value !== "number") {
    throw new GitHubInstallationTokenError("installationId must be a number");
  }
  if (!Number.isInteger(value)) {
    throw new GitHubInstallationTokenError("installationId must be an integer");
  }
  if (!Number.isSafeInteger(value)) {
    throw new GitHubInstallationTokenError(
      "installationId must be a safe integer",
    );
  }
  if (value <= 0) {
    throw new GitHubInstallationTokenError("installationId must be positive");
  }
  return value;
}

export function createGitHubAppInstallationTokenClient(
  options: GitHubAppInstallationTokenClientOptions,
): GitHubAppInstallationTokenClient {
  const { appConfig, now } = options;
  if (
    !appConfig ||
    typeof appConfig.appId !== "string" ||
    typeof appConfig.privateKey !== "string"
  ) {
    throw new GitHubAppConfigurationError("appConfig is required");
  }
  // Validate config eagerly without leaking key
  if (
    appConfig.appId.trim().length === 0 ||
    appConfig.privateKey.trim().length === 0
  ) {
    throw new GitHubAppConfigurationError("appConfig missing");
  }
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl, {
    requireHttps: true,
  });
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new GitHubInstallationTokenError("fetch not available");
  }

  if (appConfig.privateKey.includes("BEGIN") === false) {
    throw new GitHubAppConfigurationError("private key missing header");
  }

  return {
    async createInstallationToken(
      installationId: number,
    ): Promise<GitHubInstallationToken> {
      const id = validateInstallationId(installationId);
      let jwt: string;
      try {
        jwt = createGitHubAppJwt(appConfig, { now });
      } catch (error) {
        if (
          error instanceof GitHubAppConfigurationError ||
          error instanceof GitHubAppAuthenticationError ||
          (error instanceof Error &&
            (error.name === "GitHubAppConfigurationError" ||
              error.name === "GitHubAppAuthenticationError"))
        ) {
          throw error;
        }
        throw new GitHubAppAuthenticationError("failed to create app JWT");
      }

      const url = `${apiBaseUrl}/app/installations/${encodeURIComponent(String(id))}/access_tokens`;
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${jwt}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "verify-agent",
          },
          redirect: "error",
        });
      } catch {
        throw new GitHubInstallationTokenError(
          "GitHub App token request failed",
        );
      }

      if (!response.ok) {
        const status = response.status;
        if (status === 401)
          throw new GitHubAppAuthenticationError(
            "GitHub App authentication failed",
          );
        if (status === 403)
          throw new GitHubAppAuthenticationError(
            "GitHub App authorization failed",
          );
        if (status === 404)
          throw new GitHubInstallationTokenError(
            "GitHub installation not found",
          );
        if (status === 429)
          throw new GitHubRateLimitError("GitHub rate limit exceeded");
        if (status >= 500)
          throw new GitHubInstallationTokenError("GitHub server error");
        throw new GitHubInstallationTokenError(
          `GitHub request failed with status ${status}`,
        );
      }

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new GitHubInstallationTokenError("invalid GitHub token response");
      }

      if (typeof data !== "object" || data === null || Array.isArray(data)) {
        throw new GitHubInstallationTokenError("invalid GitHub token response");
      }
      const record = data as Record<string, unknown>;
      const token = record.token;
      const expiresAt = record.expires_at ?? record.expiresAt;

      if (typeof token !== "string" || token.trim().length === 0) {
        throw new GitHubInstallationTokenError("missing installation token");
      }
      if (typeof expiresAt !== "string" || expiresAt.trim().length === 0) {
        throw new GitHubInstallationTokenError("missing token expiration");
      }
      // Validate expiresAt is ISO date
      if (Number.isNaN(Date.parse(expiresAt))) {
        throw new GitHubInstallationTokenError("invalid token expiration");
      }

      return {
        token: token.trim(),
        expiresAt: expiresAt.trim(),
      };
    },
  };
}

export interface GitHubInstallationResolver {
  resolveInstallationId(owner: string, repository: string): Promise<number>;
}

export function createStaticGitHubInstallationResolver(
  entries:
    | Record<string, number>
    | Map<string, number>
    | ReadonlyArray<{
        readonly owner: string;
        readonly repository: string;
        readonly installationId: number;
      }>,
): GitHubInstallationResolver {
  const map = new Map<string, number>();

  const addEntry = (
    owner: string,
    repository: string,
    installationId: number,
  ): void => {
    if (owner.includes("..") || repository.includes("..")) {
      throw new GitHubInstallationTokenError("invalid owner or repository");
    }
    const fakeRef = {
      kind: "github-snapshot" as const,
      owner,
      repository,
      sha: "a".repeat(40),
    };
    try {
      validateGitHubSnapshotReference(fakeRef);
    } catch {
      throw new GitHubInstallationTokenError("invalid owner or repository");
    }
    if (
      !Number.isInteger(installationId) ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0
    ) {
      throw new GitHubInstallationTokenError(
        "installationId must be a positive safe integer",
      );
    }
    const key = `${owner.toLowerCase()}/${repository.toLowerCase()}`;
    if (map.has(key)) {
      throw new Error(`duplicate installation mapping for ${key}`);
    }
    map.set(key, installationId);
  };

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      addEntry(entry.owner, entry.repository, entry.installationId);
    }
  } else if (entries instanceof Map) {
    for (const [key, id] of entries.entries()) {
      const slash = key.indexOf("/");
      if (slash === -1)
        throw new GitHubInstallationTokenError(`invalid map key: ${key}`);
      const owner = key.slice(0, slash);
      const repo = key.slice(slash + 1);
      addEntry(owner, repo, id);
    }
  } else {
    for (const [key, id] of Object.entries(entries)) {
      const slash = key.indexOf("/");
      if (slash === -1)
        throw new GitHubInstallationTokenError(`invalid record key: ${key}`);
      const owner = key.slice(0, slash);
      const repo = key.slice(slash + 1);
      addEntry(owner, repo, id);
    }
  }

  return {
    async resolveInstallationId(
      owner: string,
      repository: string,
    ): Promise<number> {
      if (owner.includes("..") || repository.includes("..")) {
        throw new GitHubInstallationTokenError("invalid owner or repository");
      }
      const fakeRef = {
        kind: "github-snapshot" as const,
        owner,
        repository,
        sha: "a".repeat(40),
      };
      try {
        validateGitHubSnapshotReference(fakeRef);
      } catch {
        throw new GitHubInstallationTokenError("invalid owner or repository");
      }
      const key = `${owner.toLowerCase()}/${repository.toLowerCase()}`;
      const id = map.get(key);
      if (id === undefined) {
        throw new GitHubInstallationTokenError(
          `unknown repository: ${owner}/${repository}`,
        );
      }
      return id;
    },
  };
}

export interface GitHubApiInstallationResolverOptions {
  readonly appConfig: GitHubAppConfig;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}

export function createGitHubApiInstallationResolver(
  options: GitHubApiInstallationResolverOptions,
): GitHubInstallationResolver {
  const { appConfig, now } = options;
  if (
    !appConfig ||
    typeof appConfig.appId !== "string" ||
    typeof appConfig.privateKey !== "string"
  ) {
    throw new GitHubAppConfigurationError("appConfig is required");
  }
  if (
    appConfig.appId.trim().length === 0 ||
    appConfig.privateKey.trim().length === 0
  ) {
    throw new GitHubAppConfigurationError("appConfig missing");
  }
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl, {
    requireHttps: true,
  });
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new GitHubInstallationTokenError("fetch not available");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new GitHubAppConfigurationError("timeoutMs must be positive integer");
  }

  return {
    async resolveInstallationId(
      owner: string,
      repository: string,
    ): Promise<number> {
      if (owner.includes("..") || repository.includes("..")) {
        throw new GitHubInstallationTokenError("invalid owner or repository");
      }
      const fakeRef = {
        kind: "github-snapshot" as const,
        owner,
        repository,
        sha: "a".repeat(40),
      };
      try {
        validateGitHubSnapshotReference(fakeRef);
      } catch {
        throw new GitHubInstallationTokenError("invalid owner or repository");
      }

      let jwt: string;
      try {
        jwt = createGitHubAppJwt(appConfig, { now });
      } catch (error) {
        if (
          error instanceof GitHubAppConfigurationError ||
          error instanceof GitHubAppAuthenticationError ||
          (error instanceof Error &&
            (error.name === "GitHubAppConfigurationError" ||
              error.name === "GitHubAppAuthenticationError"))
        ) {
          throw error;
        }
        throw new GitHubAppAuthenticationError("failed to create app JWT");
      }

      const url = `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/installation`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const abortError = (): Error => {
        const error = new Error("aborted");
        error.name = "AbortError";
        return error;
      };
      try {
        let response: Response;
        try {
          response = await fetchFn(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${jwt}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "verify-agent",
            },
            redirect: "error",
            signal: controller.signal,
          });
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            throw new GitHubInstallationTokenError(
              "GitHub installation discovery timed out",
            );
          }
          throw new GitHubInstallationTokenError(
            "GitHub installation discovery failed",
          );
        }

        if (!response.ok) {
          const status = response.status;
          if (status === 401)
            throw new GitHubAppAuthenticationError(
              "GitHub App authentication failed",
            );
          if (status === 403)
            throw new GitHubAppAuthenticationError(
              "GitHub App authorization failed",
            );
          if (status === 404)
            throw new GitHubInstallationTokenError(
              "GitHub App not installed for repository",
            );
          if (status === 429)
            throw new GitHubRateLimitError("GitHub rate limit exceeded");
          if (status >= 500)
            throw new GitHubInstallationTokenError("GitHub server error");
          throw new GitHubInstallationTokenError(
            `GitHub request failed with status ${status}`,
          );
        }

        let data: unknown;
        try {
          data = await Promise.race([
            response.json(),
            new Promise<never>((_, reject) => {
              if (controller.signal.aborted) {
                reject(abortError());
              } else {
                controller.signal.addEventListener(
                  "abort",
                  () => reject(abortError()),
                  { once: true },
                );
              }
            }),
          ]);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") {
            throw new GitHubInstallationTokenError(
              "GitHub installation discovery timed out",
            );
          }
          throw new GitHubInstallationTokenError(
            "invalid GitHub installation response",
          );
        }

        if (typeof data !== "object" || data === null || Array.isArray(data)) {
          throw new GitHubInstallationTokenError(
            "invalid GitHub installation response",
          );
        }
        const record = data as Record<string, unknown>;
        const id = record.id;
        if (
          typeof id !== "number" ||
          !Number.isInteger(id) ||
          !Number.isSafeInteger(id) ||
          id <= 0
        ) {
          throw new GitHubInstallationTokenError(
            "invalid installation id in response",
          );
        }
        return id;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export interface GitHubAppSourceProviderOptions {
  readonly installationResolver: GitHubInstallationResolver;
  readonly installationTokenClient: GitHubAppInstallationTokenClient;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxFileBytes?: number;
  readonly retrievedAt?: string;
}

export function createGitHubAppSourceProvider(
  options: GitHubAppSourceProviderOptions,
): GitHubSourceProvider {
  const {
    installationResolver,
    installationTokenClient,
    apiBaseUrl,
    fetch: fetchFn,
    maxFiles,
    maxTotalBytes,
    maxFileBytes,
    retrievedAt,
  } = options;

  if (
    !installationResolver ||
    typeof installationResolver.resolveInstallationId !== "function"
  ) {
    throw new GitHubAppConfigurationError("installationResolver is required");
  }
  if (
    !installationTokenClient ||
    typeof installationTokenClient.createInstallationToken !== "function"
  ) {
    throw new GitHubAppConfigurationError(
      "installationTokenClient is required",
    );
  }

  return {
    async resolveSnapshot(reference): Promise<ResolvedSource> {
      validateGitHubSnapshotReference(reference);

      let installationId: number;
      try {
        installationId = await installationResolver.resolveInstallationId(
          reference.owner,
          reference.repository,
        );
      } catch (error) {
        if (
          error instanceof GitHubInstallationTokenError ||
          error instanceof GitHubAppConfigurationError ||
          error instanceof GitHubAppAuthenticationError ||
          (error instanceof Error &&
            (error.name === "GitHubInstallationTokenError" ||
              error.name === "GitHubAppConfigurationError" ||
              error.name === "GitHubAppAuthenticationError"))
        ) {
          throw error;
        }
        throw new GitHubInstallationTokenError(
          "failed to resolve installation",
        );
      }

      let installationToken: { token: string };
      try {
        const result =
          await installationTokenClient.createInstallationToken(installationId);
        installationToken = { token: result.token };
      } catch (error) {
        if (
          error instanceof GitHubAppConfigurationError ||
          (error instanceof Error &&
            error.name === "GitHubAppConfigurationError")
        ) {
          throw new GitHubAppConfigurationError(
            "GitHub App configuration error",
          );
        }
        if (
          error instanceof GitHubAppAuthenticationError ||
          (error instanceof Error &&
            error.name === "GitHubAppAuthenticationError")
        ) {
          throw new GitHubAppAuthenticationError(
            "GitHub App authentication failed",
          );
        }
        if (
          error instanceof GitHubInstallationTokenError ||
          (error instanceof Error &&
            error.name === "GitHubInstallationTokenError")
        ) {
          throw new GitHubInstallationTokenError(
            "GitHub installation token error",
          );
        }
        if (
          error instanceof GitHubRateLimitError ||
          (error instanceof Error && error.name === "GitHubRateLimitError")
        ) {
          throw new GitHubRateLimitError("GitHub rate limit exceeded");
        }
        throw new GitHubInstallationTokenError(
          "failed to create installation token",
        );
      }

      const token = installationToken.token;
      if (typeof token !== "string" || token.trim().length === 0) {
        throw new GitHubInstallationTokenError("missing installation token");
      }

      const apiProvider = createGitHubApiSourceProvider({
        token: token.trim(),
        apiBaseUrl,
        fetch: fetchFn,
        maxFiles,
        maxTotalBytes,
        maxFileBytes,
        retrievedAt,
      });

      try {
        return await apiProvider.resolveSnapshot(reference);
      } catch (error) {
        if (
          error instanceof InvalidSourceReferenceError ||
          error instanceof GitHubAppConfigurationError ||
          error instanceof GitHubAppAuthenticationError ||
          error instanceof GitHubInstallationTokenError ||
          error instanceof GitHubRateLimitError ||
          (error instanceof Error &&
            (error.name === "InvalidSourceReferenceError" ||
              error.name === "GitHubAppConfigurationError" ||
              error.name === "GitHubAppAuthenticationError" ||
              error.name === "GitHubInstallationTokenError" ||
              error.name === "GitHubRateLimitError" ||
              error.name === "GitHubProviderError" ||
              error.name === "GitHubAuthenticationError"))
        ) {
          throw error;
        }
        // Ensure token not in message
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes(token)) {
          throw new GitHubInstallationTokenError(
            "GitHub source request failed",
          );
        }
        throw error;
      }
    },
  };
}
