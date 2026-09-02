import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DependencyProvisioningError,
  OfflineDependencyProvisioner,
  PnpmDependencyArtifactBuilder,
  artifactDirectoryContentHash,
  createDependencyArtifact,
  dependencyArtifactContentHash,
  dependencyArtifactId,
  readArtifactFile,
} from "../packages/engine/src/index.js";
import {
  brandId,
  type DependencyIdentityInput,
} from "../packages/domain/src/index.js";

const roots: string[] = [];
const snapshotId = brandId<"RepositorySnapshotId">("fixture-snapshot");

function identity(
  overrides: Partial<DependencyIdentityInput> = {},
): DependencyIdentityInput {
  return {
    snapshotId,
    manifestHash: "a".repeat(64),
    lockfileHash: "b".repeat(64),
    ecosystem: "node",
    packageManager: "pnpm",
    packageManagerVersion: "11.21.0",
    toolchainVersion: "node-24.19.0",
    platform: { operatingSystem: "linux", architecture: "amd64" },
    provisioningConfig: { offline: "true" },
    generatedArtifactInputs: ["tsconfig.json"],
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-agent-deps-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("offline dependency provisioning", () => {
  it("creates stable identities and excludes runtime timestamps", () => {
    const first = identity();
    const second = identity();
    expect(dependencyArtifactContentHash(first)).toBe(
      dependencyArtifactContentHash(second),
    );
    expect(dependencyArtifactId(first)).toBe(dependencyArtifactId(second));
    expect(
      dependencyArtifactContentHash({
        ...first,
        generatedAt: "2026-09-01T00:00:00Z",
      }),
    ).toBe(dependencyArtifactContentHash(first));
    expect(
      dependencyArtifactContentHash(identity({ lockfileHash: "c".repeat(64) })),
    ).not.toBe(dependencyArtifactContentHash(first));
    expect(
      dependencyArtifactContentHash(
        identity({ toolchainVersion: "node-25.0.0" }),
      ),
    ).not.toBe(dependencyArtifactContentHash(first));
    expect(
      dependencyArtifactContentHash(
        identity({ provisioningConfig: { offline: "false" } }),
      ),
    ).not.toBe(dependencyArtifactContentHash(first));
    expect(
      dependencyArtifactContentHash(
        identity({ packageManagerVersion: "11.22.0" }),
      ),
    ).not.toBe(dependencyArtifactContentHash(first));
    expect(
      dependencyArtifactContentHash(
        identity({
          platform: { operatingSystem: "windows", architecture: "amd64" },
        }),
      ),
    ).not.toBe(dependencyArtifactContentHash(first));
  });

  it("materializes an operator-provided fixture artifact without execution or network", async () => {
    const root = await temporaryRoot();
    const store = join(root, "store");
    const destination = join(root, "workspace");
    const artifact = createDependencyArtifact(identity());
    await mkdir(
      join(store, artifact.artifactId, "node_modules", "typescript"),
      {
        recursive: true,
      },
    );
    await writeFile(
      join(
        store,
        artifact.artifactId,
        "node_modules",
        "typescript",
        "package.json",
      ),
      '{"name":"typescript","version":"fixture"}\n',
    );

    const environment = await new OfflineDependencyProvisioner(store).provision(
      { identity: identity(), artifact, offlineOnly: true },
      destination,
    );
    expect(environment.artifactId).toBe(artifact.artifactId);
    expect(environment.contentHash).toBe(artifact.contentHash);
    expect(
      await readFile(
        join(destination, "node_modules", "typescript", "package.json"),
        "utf8",
      ),
    ).toContain('"typescript"');
  });

  it.skipIf(process.env.VERIFY_DEPENDENCY_BUILD !== "1")(
    "builds and materializes a real pnpm artifact in the trusted build stage",
    async () => {
      const root = await temporaryRoot();
      const fixture = join(process.cwd(), "tests", "fixtures", "dependencies");
      const nodeExecutable = process.env.NODE_EXECUTABLE;
      const pnpmScript = process.env.PNPM_SCRIPT;
      if (!nodeExecutable || !pnpmScript)
        throw new Error("NODE_EXECUTABLE and PNPM_SCRIPT are required");
      const packageJson = await readFile(join(fixture, "package.json"), "utf8");
      const lockfile = await readFile(join(fixture, "pnpm-lock.yaml"), "utf8");
      await mkdir(join(root, "build"), { recursive: true });
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      const built = await new PnpmDependencyArtifactBuilder({
        platform: { operatingSystem: "linux", architecture: "amd64" },
        pnpmExecutable: nodeExecutable,
        pnpmExecutableArgs: [pnpmScript],
        buildRoot: join(root, "build"),
        artifactRoot: join(root, "artifacts"),
        environment: {
          PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Windows",
          Path: "C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Windows",
          SystemRoot: "C:\\Windows",
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          COREPACK_HOME: "C:\\Users\\user\\AppData\\Local\\node\\corepack",
          NODE_USE_SYSTEM_CA: "1",
        },
        allowNetworkDuringBuild: true,
        timeoutMs: 60_000,
      }).build({
        identity: identity({
          manifestHash: digest(packageJson),
          lockfileHash: digest(lockfile),
        }),
        packageJson,
        lockfile,
      });
      expect(built.artifactContentHash).toMatch(/^[a-f0-9]{64}$/);
      const destination = join(root, "workspace");
      await new OfflineDependencyProvisioner(join(root, "artifacts")).provision(
        {
          identity: identity({
            manifestHash: digest(packageJson),
            lockfileHash: digest(lockfile),
          }),
          artifact: built,
          offlineOnly: true,
        },
        destination,
      );
      expect(
        await readFile(
          join(destination, "node_modules", "typescript", "package.json"),
          "utf8",
        ),
      ).toContain("5.9.3");
    },
    120_000,
  );

  it.skipIf(process.env.VERIFY_DEPENDENCY_OFFLINE_EXECUTION !== "1")(
    "runs TypeScript from the provisioned artifact with offline mode enabled",
    async () => {
      const root = await temporaryRoot();
      const fixture = join(process.cwd(), "tests", "fixtures", "dependencies");
      const nodeExecutable = process.env.NODE_EXECUTABLE;
      const pnpmScript = process.env.PNPM_SCRIPT;
      if (!nodeExecutable || !pnpmScript)
        throw new Error("NODE_EXECUTABLE and PNPM_SCRIPT are required");
      const packageJson = await readFile(join(fixture, "package.json"), "utf8");
      const lockfile = await readFile(join(fixture, "pnpm-lock.yaml"), "utf8");
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex");
      await mkdir(join(root, "build"), { recursive: true });
      const identityInput = identity({
        manifestHash: digest(packageJson),
        lockfileHash: digest(lockfile),
      });
      const artifact = await new PnpmDependencyArtifactBuilder({
        platform: { operatingSystem: "linux", architecture: "amd64" },
        pnpmExecutable: nodeExecutable,
        pnpmExecutableArgs: [pnpmScript],
        buildRoot: join(root, "build"),
        artifactRoot: join(root, "artifacts"),
        environment: {
          PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Windows",
          Path: "C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Windows",
          SystemRoot: "C:\\Windows",
          ComSpec: "C:\\Windows\\System32\\cmd.exe",
          COREPACK_HOME: "C:\\Users\\user\\AppData\\Local\\node\\corepack",
          NODE_USE_SYSTEM_CA: "1",
        },
        allowNetworkDuringBuild: true,
        timeoutMs: 120_000,
      }).build({ identity: identityInput, packageJson, lockfile });
      const workspace = join(root, "workspace");
      await mkdir(workspace, { recursive: true });
      await Promise.all(
        ["package.json", "pnpm-lock.yaml", "tsconfig.json"].map((file) =>
          cp(join(fixture, file), join(workspace, file)),
        ),
      );
      await cp(join(fixture, "src"), join(workspace, "src"), {
        recursive: true,
      });
      await new OfflineDependencyProvisioner(join(root, "artifacts")).provision(
        { identity: identityInput, artifact, offlineOnly: true },
        workspace,
      );
      await new Promise<void>((resolveRun, rejectRun) => {
        const child = spawn(
          nodeExecutable,
          [pnpmScript, "exec", "tsc", "--noEmit", "--pretty", "false"],
          {
            cwd: workspace,
            env: {
              PATH: "C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Windows",
              Path: "C:\\Program Files\\nodejs;C:\\Windows\\System32;C:\\Windows",
              SystemRoot: "C:\\Windows",
              ComSpec: "C:\\Windows\\System32\\cmd.exe",
              COREPACK_HOME: "C:\\Users\\user\\AppData\\Local\\node\\corepack",
              NODE_USE_SYSTEM_CA: "1",
              npm_config_offline: "true",
            },
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let diagnostics = "";
        child.stdout?.on("data", (chunk: Buffer) => {
          diagnostics += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          diagnostics += chunk.toString("utf8");
        });
        child.once("error", rejectRun);
        child.once("exit", (code) =>
          code === 0
            ? resolveRun()
            : rejectRun(
                new Error(
                  `offline tsc exited with ${String(code)}: ${diagnostics.slice(-4096)}`,
                ),
              ),
        );
      });
    },
    180_000,
  );

  it("fails closed for unavailable artifacts and mismatched identities", async () => {
    const root = await temporaryRoot();
    const store = join(root, "store");
    await mkdir(store, { recursive: true });
    const artifact = createDependencyArtifact(identity(), {
      availability: "unavailable",
    });
    const provisioner = new OfflineDependencyProvisioner(store);
    await expect(
      provisioner.provision(
        { identity: identity(), artifact, offlineOnly: true },
        join(root, "out"),
      ),
    ).rejects.toThrow(DependencyProvisioningError);

    const available = createDependencyArtifact(identity());
    await expect(
      provisioner.provision(
        {
          identity: identity({ lockfileHash: "c".repeat(64) }),
          artifact: available,
          offlineOnly: true,
        },
        join(root, "out"),
      ),
    ).rejects.toThrow("identity mismatch");
  });

  it("rejects an artifact incompatible with the runner platform", async () => {
    const root = await temporaryRoot();
    const artifact = createDependencyArtifact(
      identity({
        platform: { operatingSystem: "windows", architecture: "amd64" },
      }),
    );
    await expect(
      new OfflineDependencyProvisioner(root, {
        operatingSystem: "linux",
        architecture: "amd64",
      }).provision(
        {
          identity: identity({
            platform: { operatingSystem: "windows", architecture: "amd64" },
          }),
          artifact,
          offlineOnly: true,
        },
        join(root, "out"),
      ),
    ).rejects.toThrow("platform is incompatible");
  });

  it("rejects Windows paths embedded in Linux launchers", async () => {
    const root = await temporaryRoot();
    const store = join(root, "store");
    const artifact = createDependencyArtifact(identity());
    const directory = join(store, artifact.artifactId, "node_modules", ".bin");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "tsc"), "#!/bin/sh\nC:\\\\host\\\\tsc\n");
    const checked = createDependencyArtifact(identity(), {
      artifactContentHash: await artifactDirectoryContentHash(
        join(store, artifact.artifactId),
      ),
    });
    await expect(
      new OfflineDependencyProvisioner(store).provision(
        { identity: identity(), artifact: checked, offlineOnly: true },
        join(root, "out"),
      ),
    ).rejects.toThrow("Windows path");
  });

  it("rejects actual Windows drive-letter and UNC paths in Linux launchers", async () => {
    const cases = [
      "C:\\Users\\foo\\bar.js",
      "D:\\tmp\\thing",
      "Z:\\workspace\\file",
      "\\\\server\\share\\thing",
      "C:/Users/foo/bar.js",
      "C:\\\\Users\\\\foo\\\\bar.js",
    ];
    for (const windowsPath of cases) {
      const root = await temporaryRoot();
      const store = join(root, "store");
      const artifact = createDependencyArtifact(identity());
      const directory = join(
        store,
        artifact.artifactId,
        "node_modules",
        ".bin",
      );
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "launcher"),
        `#!/bin/sh\nexec node "${windowsPath}"\n`,
      );
      const checked = createDependencyArtifact(identity(), {
        artifactContentHash: await artifactDirectoryContentHash(
          join(store, artifact.artifactId),
        ),
      });
      await expect(
        new OfflineDependencyProvisioner(store).provision(
          { identity: identity(), artifact: checked, offlineOnly: true },
          join(root, "out"),
        ),
      ).rejects.toThrow("Windows path");
    }
  });

  it("accepts source literal %s:\\ and realistic jsesc launcher", async () => {
    const root = await temporaryRoot();
    const store = join(root, "store");
    const artifact = createDependencyArtifact(identity());
    const directory = join(store, artifact.artifactId, "node_modules", ".bin");
    await mkdir(directory, { recursive: true });
    // Isolated format-string literal
    await writeFile(
      join(directory, "jsesc"),
      "#!/usr/bin/env node\nlog('%s:\\\\n')\n",
    );
    let checked = createDependencyArtifact(identity(), {
      artifactContentHash: await artifactDirectoryContentHash(
        join(store, artifact.artifactId),
      ),
    });
    await expect(
      new OfflineDependencyProvisioner(store).provision(
        { identity: identity(), artifact: checked, offlineOnly: true },
        join(root, "out-a"),
      ),
    ).resolves.toBeDefined();

    // Realistic jsesc launcher containing %s:\ in surrounding JS source
    const realisticJsesc = `#!/usr/bin/env node
(function() {
  var log = console.log;
  log('jsesc v%s - https://mths.be/jsesc', '1.0');
  log('\\nStack trace using jsesc@%s:\\n', 'stack');
})();\n`;
    const root2 = await temporaryRoot();
    const store2 = join(root2, "store");
    const artifact2 = createDependencyArtifact(identity());
    const dir2 = join(store2, artifact2.artifactId, "node_modules", ".bin");
    await mkdir(dir2, { recursive: true });
    await writeFile(join(dir2, "jsesc"), realisticJsesc);
    checked = createDependencyArtifact(identity(), {
      artifactContentHash: await artifactDirectoryContentHash(
        join(store2, artifact2.artifactId),
      ),
    });
    await expect(
      new OfflineDependencyProvisioner(store2).provision(
        { identity: identity(), artifact: checked, offlineOnly: true },
        join(root2, "out-b"),
      ),
    ).resolves.toBeDefined();

    // Escaped representation that is still harmless: format string with escaped backslash
    const root3 = await temporaryRoot();
    const store3 = join(root3, "store");
    const artifact3 = createDependencyArtifact(identity());
    const dir3 = join(store3, artifact3.artifactId, "node_modules", ".bin");
    await mkdir(dir3, { recursive: true });
    await writeFile(
      join(dir3, "tool"),
      '#!/bin/sh\n# format: "%s:\\\\n" and escaped "\\\\n"\n',
    );
    checked = createDependencyArtifact(identity(), {
      artifactContentHash: await artifactDirectoryContentHash(
        join(store3, artifact3.artifactId),
      ),
    });
    await expect(
      new OfflineDependencyProvisioner(store3).provision(
        { identity: identity(), artifact: checked, offlineOnly: true },
        join(root3, "out-c"),
      ),
    ).resolves.toBeDefined();

    // Normal Linux launcher content should be accepted
    const root4 = await temporaryRoot();
    const store4 = join(root4, "store");
    const artifact4 = createDependencyArtifact(identity());
    const dir4 = join(store4, artifact4.artifactId, "node_modules", ".bin");
    await mkdir(dir4, { recursive: true });
    await writeFile(
      join(dir4, "tsc"),
      "#!/usr/bin/env node\nrequire('../lib/tsc.js')\n",
    );
    checked = createDependencyArtifact(identity(), {
      artifactContentHash: await artifactDirectoryContentHash(
        join(store4, artifact4.artifactId),
      ),
    });
    await expect(
      new OfflineDependencyProvisioner(store4).provision(
        { identity: identity(), artifact: checked, offlineOnly: true },
        join(root4, "out-d"),
      ),
    ).resolves.toBeDefined();
  });

  it("rejects a modified integrity-checked artifact", async () => {
    const root = await temporaryRoot();
    const store = join(root, "store");
    const artifact = createDependencyArtifact(identity(), {
      artifactContentHash: "c".repeat(64),
    });
    await mkdir(join(store, artifact.artifactId), { recursive: true });
    await writeFile(
      join(store, artifact.artifactId, "package.json"),
      "modified\n",
    );
    await expect(
      new OfflineDependencyProvisioner(store).provision(
        { identity: identity(), artifact, offlineOnly: true },
        join(root, "out"),
      ),
    ).rejects.toThrow("integrity mismatch");
  });

  it("rejects artifact path traversal", async () => {
    const root = await temporaryRoot();
    await expect(
      readArtifactFile(root, "artifact", "../outside"),
    ).rejects.toThrow("unsafe");
  });

  it("does not provide an execution source that could overwrite sandbox provenance", () => {
    const artifact = createDependencyArtifact(identity());
    expect(artifact).not.toHaveProperty("executionSource");
    expect(artifact.availability).toBe("offline_capable");
  });
});
