import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const vitest = fileURLToPath(
  new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
);
const tests = [
  "tests/mvp-verdict.test.ts",
  "tests/mvp-comment.test.ts",
  "tests/sqlite-result-registry.test.ts",
];

const result = spawnSync(
  process.execPath,
  [vitest, "run", ...tests, "--config", "vitest.config.mjs"],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
