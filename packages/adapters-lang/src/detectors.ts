import type {
  DetectionContext,
  DetectionObservation,
  LanguageDetector,
} from "./types.js";

const obs = (
  detectorId: string,
  signal: string,
  value: string | boolean,
  evidence: string[],
  confidence: "high" | "medium" | "low",
): DetectionObservation => ({
  detectorId,
  signal,
  value,
  evidence,
  confidence,
});

export const MAX_DETECTION_DEPTH = 8;
export const SKIPPED_DETECTION_DIRECTORIES = [
  ".git",
  "node_modules",
  "target",
  ".next",
  "dist",
  "build",
  "coverage",
] as const;

export function findFiles(
  context: DetectionContext,
  names: readonly string[],
  directory = "",
  depth = 0,
): string[] {
  const matches: string[] = [];
  for (const entry of context.listDirectory(directory)) {
    if (
      SKIPPED_DETECTION_DIRECTORIES.includes(
        entry as (typeof SKIPPED_DETECTION_DIRECTORIES)[number],
      )
    )
      continue;
    const path = directory ? `${directory}/${entry}` : entry;
    if (names.includes(entry) && context.readFile(path) !== undefined)
      matches.push(path);
    if (depth < MAX_DETECTION_DEPTH && context.listDirectory(path).length > 0)
      matches.push(...findFiles(context, names, path, depth + 1));
  }
  return matches.sort();
}

function readPackage(context: DetectionContext): {
  data?: Record<string, unknown>;
  malformed: boolean;
} {
  const raw = context.readFile("package.json");
  if (raw === undefined) return { malformed: false };
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? { data: value as Record<string, unknown>, malformed: false }
      : { malformed: true };
  } catch {
    return { malformed: true };
  }
}

export function packageNames(
  data: Record<string, unknown> | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const values = data?.[field];
    if (values && typeof values === "object" && !Array.isArray(values))
      for (const name of Object.keys(values)) names.add(name);
  }
  return names;
}

export const typescriptDetector: LanguageDetector = {
  id: "typescript-javascript",
  detect(context) {
    const pkg = readPackage(context);
    const result: DetectionObservation[] = [];
    if (context.exists("tsconfig.json"))
      result.push(
        obs("typescript", "tsconfig-present", true, ["tsconfig.json"], "high"),
      );
    if (context.exists("jsconfig.json"))
      result.push(
        obs("javascript", "jsconfig-present", true, ["jsconfig.json"], "high"),
      );
    if (context.exists("package.json"))
      result.push(
        obs(
          "javascript",
          "package-json-present",
          true,
          ["package.json"],
          "medium",
        ),
      );
    if (pkg.malformed)
      result.push(
        obs(
          "javascript",
          "package-json-malformed",
          true,
          ["package.json"],
          "low",
        ),
      );
    const names = packageNames(pkg.data);
    if (names.has("typescript") || context.exists("tsconfig.json"))
      result.push(
        obs(
          "typescript",
          "typescript-signal",
          "typescript",
          [
            "package.json",
            ...(context.exists("tsconfig.json") ? ["tsconfig.json"] : []),
          ],
          "high",
        ),
      );
    else if (context.exists("package.json"))
      result.push(
        obs(
          "javascript",
          "javascript-signal",
          "javascript",
          ["package.json"],
          "medium",
        ),
      );
    for (const file of findFiles(context, [
      "next.config.js",
      "next.config.mjs",
      "next.config.ts",
      "vite.config.js",
      "vite.config.ts",
      "vitest.config.ts",
      "jest.config.js",
      "eslint.config.js",
      ".eslintrc.json",
      ".prettierrc",
      "prettier.config.js",
    ]))
      result.push(
        obs("typescript", "configuration-present", file, [file], "medium"),
      );
    for (const name of [
      "next",
      "react",
      "vite",
      "vitest",
      "jest",
      "eslint",
      "prettier",
    ])
      if (names.has(name))
        result.push(
          obs(
            "typescript",
            "package-tool-present",
            name,
            ["package.json"],
            "high",
          ),
        );
    return result;
  },
};

export const rustDetector: LanguageDetector = {
  id: "rust",
  detect(context) {
    const result: DetectionObservation[] = [];
    for (const path of findFiles(context, ["Cargo.toml"])) {
      const manifest = context.readFile(path) ?? "";
      result.push(obs("rust", "cargo-manifest-present", path, [path], "high"));
      if (/^\s*\[workspace\]/m.test(manifest))
        result.push(
          obs("rust", "cargo-workspace-present", true, [path], "high"),
        );
      if (
        /soroban-sdk|stellar-sdk|stellar_sdk|soroban-cli/i.test(manifest) ||
        context.exists(`${path.slice(0, -"Cargo.toml".length)}soroban.toml`)
      )
        result.push(obs("rust", "soroban-signal", "soroban", [path], "high"));
    }
    for (const path of findFiles(context, ["Cargo.lock"]))
      result.push(obs("rust", "cargo-lock-present", true, [path], "medium"));
    return result;
  },
};

export const defaultLanguageDetectors: readonly LanguageDetector[] = [
  typescriptDetector,
  rustDetector,
];
