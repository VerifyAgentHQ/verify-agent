import { normalizePath } from "@verify-agent/domain";
import type { DetectionContext } from "./pipeline-types.js";

function safeRelativePath(path: string): string {
  const normalized = normalizePath(path || ".");
  if (normalized.includes("//") || normalized.includes("/./"))
    throw new Error("detection path is not normalized");
  return normalized === "." ? "" : normalized;
}

/**
 * Read-only in-memory detection context over resolved source contents.
 * Mirrors the bounded adapter contract without importing language adapters
 * into the engine.
 */
export function createMemoryDetectionContext(
  files: Readonly<Record<string, string>>,
): DetectionContext {
  const normalized = new Map(
    Object.entries(files).map(([path, content]) => [
      safeRelativePath(path),
      content,
    ]),
  );
  const keyFor = (path: string): string => safeRelativePath(path);
  return {
    exists(path) {
      const key = keyFor(path);
      return (
        normalized.has(key) ||
        [...normalized.keys()].some((file) => file.startsWith(`${key}/`))
      );
    },
    readFile(path) {
      return normalized.get(keyFor(path));
    },
    listDirectory(path = "") {
      const prefix = keyFor(path);
      const start = prefix ? `${prefix}/` : "";
      const entries = new Set<string>();
      for (const file of normalized.keys())
        if (file.startsWith(start))
          entries.add(file.slice(start.length).split("/")[0]);
      return [...entries].sort();
    },
  };
}
