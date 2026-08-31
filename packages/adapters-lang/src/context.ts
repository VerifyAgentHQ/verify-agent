import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { normalizePath } from "@verify-agent/domain";
import type { DetectionContext } from "./types.js";

function safeRelativePath(path: string): string {
  const normalized = normalizePath(path || ".");
  if (normalized.includes("//") || normalized.includes("/./"))
    throw new Error("detection path is not normalized");
  return normalized === "." ? "" : normalized;
}

export function createFileSystemDetectionContext(
  root: string,
): DetectionContext {
  const rootPath = resolve(root);
  const realRootPath = realpathSync.native(rootPath);
  const resolveSafe = (path: string): string => {
    const candidate = resolve(rootPath, safeRelativePath(path));
    const outside = relative(rootPath, candidate);
    if (outside === ".." || outside.startsWith(`..${sep}`))
      throw new Error("detection path escapes repository root");
    return candidate;
  };
  const guardExisting = (candidate: string): boolean => {
    try {
      if (lstatSync(candidate).isSymbolicLink()) return false;
      const realPath = realpathSync.native(candidate);
      const relativePath = relative(realRootPath, realPath);
      if (relativePath === ".." || relativePath.startsWith(`..${sep}`))
        throw new Error("detection path resolves outside repository root");
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("outside repository")
      )
        throw error;
      return false;
    }
  };
  return {
    exists(path) {
      const candidate = resolveSafe(path);
      try {
        return (
          statSync(candidate, { throwIfNoEntry: false }) !== undefined &&
          guardExisting(candidate)
        );
      } catch {
        return false;
      }
    },
    readFile(path) {
      const candidate = resolveSafe(path);
      try {
        if (!guardExisting(candidate)) return undefined;
        return readFileSync(candidate, "utf8");
      } catch {
        return undefined;
      }
    },
    listDirectory(path = "") {
      const candidate = resolveSafe(path);
      try {
        if (!guardExisting(candidate)) return [];
        return readdirSync(candidate, { withFileTypes: true })
          .filter((entry) => !entry.isSymbolicLink())
          .map((entry) => entry.name)
          .sort();
      } catch {
        return [];
      }
    },
  };
}

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
