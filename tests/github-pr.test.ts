import { describe, expect, it } from "vitest";
import {
  decideGitHubPullRequestEvent,
  isSupportedGitHubPullRequestAction,
} from "../packages/adapters-source/src/github-pr.js";
import {
  createInMemoryGitHubSourceProvider,
  createSingleGitHubFixtureProvider,
  createGitHubSourceResolver,
} from "../packages/adapters-source/src/github.js";
import { InvalidSourceReferenceError } from "../packages/adapters-source/src/resolver.js";

const OWNER = "octocat";
const REPOSITORY = "hello-world";
const HEAD_SHA = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
const BASE_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PR_NUMBER = 42;

function makeEvent(overrides: Partial<Record<string, unknown>> = {}): unknown {
  const base: Record<string, unknown> = {
    action: "opened",
    repository: { owner: OWNER, name: REPOSITORY },
    pullRequest: {
      number: PR_NUMBER,
      base: { sha: BASE_SHA },
      head: { sha: HEAD_SHA },
    },
  };
  // shallow merge for top-level, but handle nested
  if (overrides.action !== undefined) base.action = overrides.action;
  if (overrides.repository !== undefined)
    base.repository = overrides.repository;
  if (overrides.pullRequest !== undefined)
    base.pullRequest = overrides.pullRequest;
  if (overrides.owner !== undefined) {
    (base.repository as Record<string, unknown>).owner = overrides.owner;
  }
  if (overrides.name !== undefined) {
    (base.repository as Record<string, unknown>).name = overrides.name;
  }
  if (overrides.number !== undefined) {
    (base.pullRequest as Record<string, unknown>).number = overrides.number;
  }
  if (overrides.baseSha !== undefined) {
    (
      (base.pullRequest as Record<string, unknown>).base as Record<
        string,
        unknown
      >
    ).sha = overrides.baseSha;
  }
  if (overrides.headSha !== undefined) {
    (
      (base.pullRequest as Record<string, unknown>).head as Record<
        string,
        unknown
      >
    ).sha = overrides.headSha;
  }
  return base;
}

describe("GitHub PR event → immutable source reference", () => {
  it("supports opened, synchronize, reopened as verify", () => {
    for (const action of ["opened", "synchronize", "reopened"] as const) {
      const event = {
        action,
        repository: { owner: OWNER, name: REPOSITORY },
        pullRequest: {
          number: PR_NUMBER,
          base: { sha: BASE_SHA },
          head: { sha: HEAD_SHA },
        },
      };
      expect(isSupportedGitHubPullRequestAction(action)).toBe(true);
      const decision = decideGitHubPullRequestEvent(event);
      expect(decision.kind).toBe("verify");
      if (decision.kind === "verify") {
        expect(decision.source.kind).toBe("github-snapshot");
        expect(decision.source.owner).toBe(OWNER);
        expect(decision.source.repository).toBe(REPOSITORY);
        expect(decision.source.sha).toBe(HEAD_SHA);
        expect(decision.pullRequestNumber).toBe(PR_NUMBER);
        expect(decision.baseSha).toBe(BASE_SHA);
        expect(decision.headSha).toBe(HEAD_SHA);
        // base SHA must not replace head
        expect(decision.source.sha).not.toBe(BASE_SHA);
      }
    }
  });

  it("uses head SHA, not base SHA, as source identity", () => {
    const event = {
      action: "synchronize",
      repository: { owner: OWNER, name: REPOSITORY },
      pullRequest: {
        number: 7,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    };
    const decision = decideGitHubPullRequestEvent(event);
    expect(decision.kind).toBe("verify");
    if (decision.kind === "verify") {
      expect(decision.source.sha).toBe(HEAD_SHA);
      expect(decision.headSha).toBe(HEAD_SHA);
      expect(decision.baseSha).toBe(BASE_SHA);
    }
  });

  it("ignores unsupported actions without invoking verification", () => {
    for (const action of [
      "closed",
      "edited",
      "labeled",
      "assigned",
      "unlabeled",
    ] as const) {
      const event = {
        action,
        repository: { owner: OWNER, name: REPOSITORY },
        pullRequest: {
          number: PR_NUMBER,
          base: { sha: BASE_SHA },
          head: { sha: HEAD_SHA },
        },
      };
      expect(isSupportedGitHubPullRequestAction(action)).toBe(false);
      const decision = decideGitHubPullRequestEvent(event);
      expect(decision.kind).toBe("ignore");
      if (decision.kind === "ignore") {
        expect(decision.reason).toContain(action);
      }
    }
  });

  it("rejects invalid head SHA via existing validation", () => {
    const invalidShas = [
      "main",
      "abc123",
      "da39a3ee5e6b4b0d3255bfef95601890afd8070", // 39 char
      "da39a3ee5e6b4b0d3255bfef95601890afd80709zz", // invalid hex
      "https://github.com/octocat/hello-world",
      "../evil",
      "/absolute/path",
      "C:\\evil",
      "",
      "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
    ];
    for (const sha of invalidShas) {
      const event = {
        action: "opened",
        repository: { owner: OWNER, name: REPOSITORY },
        pullRequest: {
          number: PR_NUMBER,
          base: { sha: BASE_SHA },
          head: { sha },
        },
      };
      expect(() => decideGitHubPullRequestEvent(event as any)).toThrow(
        InvalidSourceReferenceError,
      );
    }
  });

  it("rejects branch name, short SHA, URL, path-like head SHA", () => {
    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: OWNER, name: REPOSITORY },
        pullRequest: {
          number: 1,
          base: { sha: BASE_SHA },
          head: { sha: "main" },
        },
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: OWNER, name: REPOSITORY },
        pullRequest: {
          number: 1,
          base: { sha: BASE_SHA },
          head: { sha: "abc123" },
        },
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: OWNER, name: REPOSITORY },
        pullRequest: {
          number: 1,
          base: { sha: BASE_SHA },
          head: {
            sha: "https://github.com/o/r/commit/da39a3ee5e6b4b0d3255bfef95601890afd80709",
          },
        },
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: OWNER, name: REPOSITORY },
        pullRequest: {
          number: 1,
          base: { sha: BASE_SHA },
          head: { sha: "../evil" },
        },
      }),
    ).toThrow(InvalidSourceReferenceError);
  });

  it("rejects invalid owner/repository via existing validation", () => {
    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: "owner/with-slash", name: REPOSITORY },
        pullRequest: {
          number: PR_NUMBER,
          base: { sha: BASE_SHA },
          head: { sha: HEAD_SHA },
        },
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: OWNER, name: "../evil" },
        pullRequest: {
          number: PR_NUMBER,
          base: { sha: BASE_SHA },
          head: { sha: HEAD_SHA },
        },
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: "", name: REPOSITORY },
        pullRequest: {
          number: PR_NUMBER,
          base: { sha: BASE_SHA },
          head: { sha: HEAD_SHA },
        },
      }),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: OWNER, name: "" },
        pullRequest: {
          number: PR_NUMBER,
          base: { sha: BASE_SHA },
          head: { sha: HEAD_SHA },
        },
      }),
    ).toThrow(InvalidSourceReferenceError);
  });

  it("rejects missing fields via invalid-source error", () => {
    expect(() => decideGitHubPullRequestEvent({} as any)).toThrow(
      InvalidSourceReferenceError,
    );
    expect(() =>
      decideGitHubPullRequestEvent({
        // @ts-expect-error missing repository
        action: "opened",
        pullRequest: {
          number: PR_NUMBER,
          base: { sha: BASE_SHA },
          head: { sha: HEAD_SHA },
        },
      } as any),
    ).toThrow(InvalidSourceReferenceError);

    expect(() =>
      decideGitHubPullRequestEvent({
        action: "opened",
        repository: { owner: OWNER, name: REPOSITORY },
        // @ts-expect-error missing pullRequest
      } as any),
    ).toThrow(InvalidSourceReferenceError);
  });

  it("is deterministic and does not mutate input", () => {
    const event = {
      action: "reopened",
      repository: { owner: OWNER, name: REPOSITORY },
      pullRequest: {
        number: PR_NUMBER,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    };
    const clone = JSON.parse(JSON.stringify(event));
    const first = decideGitHubPullRequestEvent(event);
    const second = decideGitHubPullRequestEvent(event);
    expect(first).toEqual(second);
    expect(event).toEqual(clone);
    // ensure new object each call
    expect(first).not.toBe(second);
  });

  it("composes with deterministic fixture provider via GitHubSourceResolver", async () => {
    const event = {
      action: "opened",
      repository: { owner: OWNER, name: REPOSITORY },
      pullRequest: {
        number: PR_NUMBER,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    };
    const decision = decideGitHubPullRequestEvent(event);
    expect(decision.kind).toBe("verify");
    if (decision.kind !== "verify") return;

    const fixtureContents = {
      "package.json": JSON.stringify({ name: "test" }),
      "src/index.ts": "export const x=1;\n",
    };
    const provider = createSingleGitHubFixtureProvider({
      owner: decision.source.owner,
      repository: decision.source.repository,
      sha: decision.source.sha,
      sourceContents: fixtureContents,
    });
    const resolver = createGitHubSourceResolver(provider);

    // Verify via GitHubSnapshotReference directly
    const direct = await provider.resolveSnapshot(decision.source);
    expect(direct.snapshot.source.provider).toBe("github");
    expect(direct.sourceContents).toEqual(fixtureContents);

    // Verify via generic SourceResolver (adapter)
    const viaResolver = await resolver.resolveSnapshot({
      kind: "snapshot",
      id: `${decision.source.owner}:${decision.source.repository}:${decision.source.sha}`,
    });
    expect(viaResolver.snapshot.id).toBe(direct.snapshot.id);
    expect(viaResolver.sourceContents).toEqual(fixtureContents);
  });

  it("ignores unsupported action without attempting source resolution", async () => {
    const event = {
      action: "closed",
      repository: { owner: OWNER, name: REPOSITORY },
      pullRequest: {
        number: PR_NUMBER,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    };
    const decision = decideGitHubPullRequestEvent(event);
    expect(decision.kind).toBe("ignore");
    // Ensure no provider call is needed – decision is ignore
    // Simulate that a naive implementation would not have validated SHA
    // but ours returns ignore before validation of SHA? Actually we validate SHA only for verify actions.
    // For unsupported action, we should not throw even if SHA is invalid? Let's test that unsupported action bypasses validation.
    const eventWithBadSha = {
      action: "closed",
      repository: { owner: OWNER, name: REPOSITORY },
      pullRequest: {
        number: PR_NUMBER,
        base: { sha: "bad-sha" },
        head: { sha: "also-bad" },
      },
    };
    const decision2 = decideGitHubPullRequestEvent(eventWithBadSha);
    expect(decision2.kind).toBe("ignore");
  });

  it("exposes via apps/github-bot boundary", async () => {
    const bot = await import("../apps/github-bot/src/index.js");
    expect(typeof bot.decideGitHubPullRequestEvent).toBe("function");
    expect(typeof bot.isSupportedGitHubPullRequestAction).toBe("function");
    const event = {
      action: "synchronize",
      repository: { owner: OWNER, name: REPOSITORY },
      pullRequest: {
        number: 99,
        base: { sha: BASE_SHA },
        head: { sha: HEAD_SHA },
      },
    };
    const decision = bot.decideGitHubPullRequestEvent(event as any);
    expect(decision.kind).toBe("verify");
  });
});
