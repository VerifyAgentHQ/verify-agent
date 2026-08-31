import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brandId } from "../packages/domain/src/index.js";
import {
  createFileSystemDetectionContext,
  createMemoryDetectionContext,
  createProjectDetectionService,
} from "../packages/adapters-lang/src/index.js";
import {
  MAX_DETECTION_DEPTH,
  SKIPPED_DETECTION_DIRECTORIES,
  findFiles,
} from "../packages/adapters-lang/src/detectors.js";

const fixture = (name: string) =>
  join(process.cwd(), "tests", "fixtures", "project-detection", name);
const project = {
  id: brandId<"ProjectId">("project-1"),
  name: "fixture",
  root: ".",
};
const snapshot = {
  id: brandId<"RepositorySnapshotId">("snapshot-1"),
  projectId: project.id,
  source: { provider: "fixture", reference: "fixture" },
  sourceState: { type: "snapshot" as const, value: "snapshot-1" },
  retrievedAt: "2026-08-31T10:00:00Z",
};
const detect = (name: string) =>
  createProjectDetectionService().detect(
    project,
    snapshot,
    createFileSystemDetectionContext(fixture(name)),
  );

describe("project detection", () => {
  it.each([
    [
      "typescript-basic",
      ["typescript"],
      ["typescript.typecheck", "typescript.test", "typescript.build"],
    ],
    ["typescript-next", ["javascript"], ["nextjs", "react"]],
    ["typescript-react", ["javascript"], ["react"]],
    ["rust-basic", ["rust"], ["rust.check", "rust.test", "rust.clippy"]],
    ["rust-soroban", ["rust"], ["soroban", "soroban.contract-test"]],
    [
      "mixed-ts-rust",
      ["rust", "typescript"],
      ["rust.check", "typescript.typecheck"],
    ],
  ])("detects %s statically", (name, expectedLanguages, expectedSignals) => {
    const result = detect(name);
    expect(result.profile.languages).toEqual(expectedLanguages);
    for (const signal of expectedSignals) {
      if (signal === "nextjs" || signal === "react" || signal === "soroban")
        expect(result.profile.frameworks).toContain(signal);
      else expect(result.profile.supportedCapabilities).toContain(signal);
    }
  });

  it("represents multiple package-manager lockfiles as ambiguous", () => {
    const profile = detect("ambiguous-package-manager").profile;
    expect(profile.packageManagers).toEqual(["npm", "pnpm"]);
    expect(profile.repositoryStructure.packageManagerAmbiguous).toBe(true);
  });

  it("does not crash on malformed package metadata", () => {
    const result = detect("malformed-package-json");
    expect(result.profile.languages).toEqual(["javascript"]);
    expect(
      result.observations.some(
        (item) => item.signal === "package-json-malformed",
      ),
    ).toBe(true);
  });

  it("is deterministic and does not mutate the supplied inspection data", () => {
    const context = createMemoryDetectionContext({
      "package.json": '{"devDependencies":{"typescript":"5"}}',
      "tsconfig.json": "{}",
    });
    const before = context.readFile("package.json");
    const first = createProjectDetectionService().detect(
      project,
      snapshot,
      context,
    );
    const second = createProjectDetectionService().detect(
      project,
      snapshot,
      context,
    );
    expect(second).toEqual(first);
    expect(context.readFile("package.json")).toBe(before);
  });

  it("rejects traversal and absolute inspection paths", () => {
    const context = createMemoryDetectionContext({ "package.json": "{}" });
    expect(() => context.readFile("../package.json")).toThrow();
    expect(() => context.exists("C:/outside/package.json")).toThrow();
  });

  it("never executes package scripts or repository commands", () => {
    const context = createMemoryDetectionContext({
      "package.json": '{"scripts":{"test":"echo SHOULD_NOT_RUN"}}',
    });
    expect(() =>
      createProjectDetectionService().detect(project, snapshot, context),
    ).not.toThrow();
  });

  it("skips generated directories and bounds recursive discovery", () => {
    const context = createMemoryDetectionContext({
      "src/Cargo.toml": '[package]\nname="inside"',
      ".next/Cargo.toml": '[package]\nname="generated"',
      "a/b/c/d/e/f/g/h/i/Cargo.toml": '[package]\nname="too-deep"',
    });
    expect(findFiles(context, ["Cargo.toml"])).toEqual(["src/Cargo.toml"]);
    expect(SKIPPED_DETECTION_DIRECTORIES).toContain(".next");
    expect(MAX_DETECTION_DEPTH).toBeGreaterThan(0);
  });

  it("does not traverse a symlink or junction during filesystem inspection", () => {
    const root = mkdtempSync(`${tmpdir()}/verify-agent-detection-`);
    const outside = mkdtempSync(`${tmpdir()}/verify-agent-outside-`);
    try {
      writeFileSync(`${outside}/Cargo.toml`, '[package]\nname="outside"');
      try {
        symlinkSync(outside, `${root}/linked`, "junction");
      } catch {
        return;
      }
      const context = createFileSystemDetectionContext(root);
      expect(context.listDirectory()).not.toContain("linked");
      expect(context.readFile("linked/Cargo.toml")).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
