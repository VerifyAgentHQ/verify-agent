import { createPrivateKey, createSign, createVerify } from "node:crypto";
import { GitHubRateLimitError } from "./github.js";
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

function normalizeApiBaseUrl(value?: string): string {
  const base = (value ?? DEFAULT_API_BASE_URL).trim().replace(/\/+$/, "");
  if (base.length === 0) return DEFAULT_API_BASE_URL;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new GitHubAppConfigurationError("apiBaseUrl must be http or https");
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
  const apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
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
