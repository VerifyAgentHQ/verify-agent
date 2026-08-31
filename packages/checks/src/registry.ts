import type { Check, CheckRegistry } from "./types.js";

export class DefaultCheckRegistry implements CheckRegistry {
  readonly checks: Check[] = [];

  register(check: Check): void {
    this.checks.push(check);
  }

  find(checkId: string): Check | undefined {
    return this.checks.find((check) => check.id === checkId);
  }
}

export const defaultCheckRegistry = new DefaultCheckRegistry();
