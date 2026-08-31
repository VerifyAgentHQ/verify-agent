import { validateProjectProfile } from "@verify-agent/domain";
import type {
  Project,
  ProjectProfile,
  RepositorySnapshot,
} from "@verify-agent/domain";
import { defaultLanguageDetectors, packageNames } from "./detectors.js";
import type {
  DetectionContext,
  DetectionObservation,
  ProjectDetectionResult,
  ProjectDetectionService,
} from "./types.js";

const scores = { high: 1, medium: 0.65, low: 0.3 } as const;
const unique = (values: readonly string[]) => [...new Set(values)].sort();
function readPackage(
  context: DetectionContext,
): Record<string, unknown> | undefined {
  const raw = context.readFile("package.json");
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function createProjectDetectionService(
  detectors = defaultLanguageDetectors,
): ProjectDetectionService {
  return {
    detect(
      project: Project,
      snapshot: RepositorySnapshot,
      context: DetectionContext,
    ): ProjectDetectionResult {
      const observations = detectors.flatMap((detector) =>
        detector.detect(context),
      );
      const pkg = readPackage(context);
      const names = packageNames(pkg);
      const languages = unique([
        ...observations
          .filter(
            (item) =>
              item.signal === "typescript-signal" ||
              item.signal === "javascript-signal",
          )
          .map((item) => String(item.value)),
        ...(observations.some(
          (item) => item.signal === "cargo-manifest-present",
        )
          ? ["rust"]
          : []),
      ]);
      const frameworks = unique([
        ...(observations.some(
          (item) =>
            item.value === "next" ||
            (typeof item.value === "string" &&
              item.value.startsWith("next.config")),
        )
          ? ["nextjs"]
          : []),
        ...(names.has("react") ? ["react"] : []),
        ...(observations.some((item) => item.signal === "soroban-signal")
          ? ["soroban"]
          : []),
      ]);
      const hasCargo = observations.some(
        (item) => item.signal === "cargo-manifest-present",
      );
      const packageManagers = unique([
        ...(context.exists("pnpm-lock.yaml") ? ["pnpm"] : []),
        ...(context.exists("package-lock.json") ? ["npm"] : []),
        ...(context.exists("yarn.lock") ? ["yarn"] : []),
        ...(hasCargo ? ["cargo"] : []),
      ]);
      const detectedTools = unique(
        observations
          .filter(
            (item) =>
              item.signal === "package-tool-present" ||
              item.signal === "tsconfig-present",
          )
          .map((item) =>
            String(item.value === true ? "typescript" : item.value),
          )
          .concat(
            observations
              .filter((item) => item.signal === "configuration-present")
              .flatMap((item) => {
                const file = String(item.value);
                if (file.startsWith("eslint") || file.startsWith(".eslint"))
                  return ["eslint"];
                if (file.startsWith("prettier") || file === ".prettierrc")
                  return ["prettier"];
                if (file.startsWith("vitest")) return ["vitest"];
                if (file.startsWith("jest")) return ["jest"];
                if (file.startsWith("vite")) return ["vite"];
                if (file.startsWith("next")) return ["next"];
                return [];
              }),
          )
          .concat(hasCargo ? ["cargo"] : []),
      );
      const testFrameworks = unique([
        ...(names.has("vitest") || detectedTools.includes("vitest")
          ? ["vitest"]
          : []),
        ...(names.has("jest") || detectedTools.includes("jest")
          ? ["jest"]
          : []),
      ]);
      const buildSystems = unique([
        ...(hasCargo ? ["cargo"] : []),
        ...(context.exists("vite.config.ts") || context.exists("vite.config.js")
          ? ["vite"]
          : []),
      ]);
      const scripts =
        pkg?.scripts &&
        typeof pkg.scripts === "object" &&
        !Array.isArray(pkg.scripts)
          ? (pkg.scripts as Record<string, unknown>)
          : {};
      const capabilities = unique([
        ...(languages.includes("typescript") || languages.includes("javascript")
          ? [
              "dependency.audit",
              ...(observations.some(
                (item) => item.signal === "tsconfig-present",
              )
                ? ["typescript.typecheck"]
                : []),
              ...(detectedTools.includes("eslint") ? ["typescript.lint"] : []),
              ...(detectedTools.includes("vitest") ||
              detectedTools.includes("jest")
                ? ["typescript.test"]
                : []),
              ...(typeof scripts.build === "string"
                ? ["typescript.build"]
                : []),
            ]
          : []),
        ...(languages.includes("rust")
          ? ["rust.check", "rust.test", "rust.clippy"]
          : []),
        ...(frameworks.includes("soroban") ? ["soroban.contract-test"] : []),
      ]);
      const confidence =
        observations.length === 0
          ? 0
          : Math.max(...observations.map((item) => scores[item.confidence]));
      const profile: ProjectProfile = {
        projectId: project.id,
        snapshotId: snapshot.id,
        languages,
        frameworks,
        packageManagers,
        buildSystems,
        testFrameworks,
        detectedTools,
        repositoryStructure: {
          hasSrc: context.exists("src"),
          hasTests: context.exists("tests") || context.exists("test"),
          hasApps: context.exists("apps"),
          hasPackages: context.exists("packages"),
          hasContracts: context.exists("contracts"),
          isMonorepo:
            context.exists("apps") ||
            context.exists("packages") ||
            observations.some(
              (item) =>
                item.signal === "cargo-workspace-present" ||
                (item.signal === "cargo-manifest-present" &&
                  item.evidence.some((path) => path.includes("/"))),
            ),
          packageManagerAmbiguous:
            packageManagers.filter((manager) => manager !== "cargo").length > 1,
        },
        supportedCapabilities: capabilities,
        detectionConfidence: confidence,
      };
      validateProjectProfile(profile);
      return { profile, observations };
    },
  };
}
