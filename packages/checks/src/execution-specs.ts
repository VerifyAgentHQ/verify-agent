import type { CheckId } from "@verify-agent/domain";

export type CheckRuntime = "node" | "cargo";

export interface CheckExecutionSpec {
  readonly checkId: CheckId;
  readonly runtime: CheckRuntime;
  readonly executable: string;
  readonly args: readonly string[];
  readonly workingDirectory: ".";
  readonly environment: Readonly<Record<string, string>>;
  readonly memoryLimitBytes?: number;
  readonly timeoutMs?: number;
}

const spec = (
  checkId: string,
  runtime: CheckRuntime,
  executable: string,
  args: readonly string[],
  limits?: { readonly memoryLimitBytes?: number; readonly timeoutMs?: number },
): CheckExecutionSpec => ({
  checkId: checkId as CheckId,
  runtime,
  executable,
  args,
  workingDirectory: ".",
  environment: {},
  ...(limits === undefined ? {} : limits),
});

export const trustedExecutionSpecs: readonly CheckExecutionSpec[] = [
  spec("typescript.typecheck", "node", "typescript", ["--noEmit"], {
    // The repository-wide TypeScript program exceeds the default 512 MiB
    // sandbox envelope. Keep this exception scoped to the trusted typecheck.
    memoryLimitBytes: 1024 * 1024 * 1024,
  }),
  spec("typescript.lint", "node", "typescript-lint", ["."]),
  spec("typescript.test", "node", "typescript-test", ["run"]),
  spec("typescript.build", "node", "typescript-build", ["--build"]),
  spec("rust.check", "cargo", "cargo", ["check"]),
  spec("rust.test", "cargo", "cargo", ["test"]),
  spec("rust.clippy", "cargo", "cargo", ["clippy"]),
  spec("soroban.contract-test", "cargo", "cargo", ["test", "--offline"], {
    memoryLimitBytes: 2 * 1024 * 1024 * 1024,
    timeoutMs: 5 * 60 * 1000,
  }),
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

/**
 * Batch 56C — canonical maximum trusted execution timeout.
 *
 * The outer `SubprocessSandboxTransport` must remain alive longer than any
 * trusted check-specific inner deadline (`resourceLimits.timeoutMs`,
 * enforced inside the sandbox via Docker `wait_with_deadline` plus
 * kill/wait/cleanup/serialization). Deriving the outer timeout from this
 * registry keeps the invariant automatically correct when a future trusted
 * check gains a larger `timeoutMs`.
 *
 * Specs without an explicit `timeoutMs` execute under the caller's
 * `DEFAULT_EXECUTION_LIMITS.timeoutMs` fallback, so the caller supplies
 * that fallback explicitly (the checks package must not depend on the
 * engine's limits to preserve layering). The result is
 * `max(fallbackMs, ...spec.timeoutMs)`.
 */
export function maxTrustedExecutionTimeoutMs(
  fallbackTimeoutMs: number,
  specs: readonly CheckExecutionSpec[] = trustedExecutionSpecs,
): number {
  if (!Number.isSafeInteger(fallbackTimeoutMs) || fallbackTimeoutMs < 1) {
    throw new Error("fallback timeout must be a positive integer");
  }
  let maximum = fallbackTimeoutMs;
  for (const spec of specs) {
    if (spec.timeoutMs !== undefined) {
      if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1) {
        throw new Error("trusted spec timeout must be a positive integer");
      }
      if (spec.timeoutMs > maximum) maximum = spec.timeoutMs;
    }
  }
  return maximum;
}

/**
 * Batch 56C — maximum over explicitly configured trusted spec timeouts.
 *
 * Returns `undefined` when no trusted spec declares an explicit timeout;
 * callers combine with their execution fallback via
 * `maxTrustedExecutionTimeoutMs`.
 */
export function maxTrustedSpecTimeoutMs(
  specs: readonly CheckExecutionSpec[] = trustedExecutionSpecs,
): number | undefined {
  let maximum: number | undefined;
  for (const spec of specs) {
    if (spec.timeoutMs !== undefined) {
      if (maximum === undefined || spec.timeoutMs > maximum) {
        maximum = spec.timeoutMs;
      }
    }
  }
  return maximum;
}
