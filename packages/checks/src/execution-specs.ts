import type { CheckId } from "@verify-agent/domain";

export type CheckRuntime = "node" | "cargo";

export interface CheckExecutionSpec {
  readonly checkId: CheckId;
  readonly runtime: CheckRuntime;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: ".";
  readonly environment: Readonly<Record<string, string>>;
}

const spec = (
  checkId: string,
  runtime: CheckRuntime,
  executable: string,
  args: readonly string[],
): CheckExecutionSpec => ({
  checkId: checkId as CheckId,
  runtime,
  executable,
  args,
  workingDirectory: ".",
  environment: {},
});

export const trustedExecutionSpecs: readonly CheckExecutionSpec[] = [
  spec("typescript.typecheck", "node", "pnpm", ["exec", "tsc", "--noEmit"]),
  spec("typescript.lint", "node", "pnpm", ["exec", "eslint", "."]),
  spec("typescript.test", "node", "pnpm", ["exec", "vitest", "run"]),
  spec("typescript.build", "node", "pnpm", ["exec", "tsc", "--build"]),
  spec("rust.check", "cargo", "cargo", ["check"]),
  spec("rust.test", "cargo", "cargo", ["test"]),
  spec("rust.clippy", "cargo", "cargo", ["clippy"]),
  spec("soroban.contract-test", "cargo", "cargo", ["test"]),
];

export interface TrustedExecutionSpecRegistry {
  readonly specs: readonly CheckExecutionSpec[];
  find(checkId: CheckId): CheckExecutionSpec | undefined;
}

export function createTrustedExecutionSpecRegistry(
  specs: readonly CheckExecutionSpec[] = trustedExecutionSpecs,
): TrustedExecutionSpecRegistry {
  const ordered = [...specs].sort((a, b) =>
    String(a.checkId).localeCompare(String(b.checkId)),
  );
  return {
    specs: ordered,
    find(checkId) {
      return ordered.find((candidate) => candidate.checkId === checkId);
    },
  };
}
