import type {
  CheckDefinition,
  CheckExecution,
  CheckResult,
  Evidence,
} from "@verify-agent/domain";

export type {
  CheckDefinition,
  CheckExecution,
  CheckResult,
} from "@verify-agent/domain";

export type CheckSpec = CheckDefinition & {
  fact: string;
};

export interface Check {
  readonly id: string;
  readonly fact: string;
  execute(input: Record<string, unknown>): Promise<CheckResult>;
}

export interface CheckRegistry {
  readonly checks: Check[];
  register(check: Check): void;
  find(checkId: string): Check | undefined;
}

export interface CheckExecutionContext {
  execution: CheckExecution;
  evidence: Evidence[];
}
