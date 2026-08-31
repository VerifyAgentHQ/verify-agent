import { describe, expect, it } from "vitest";
import { createEngine } from "../packages/engine/src/runtime.js";

describe("engine Phase 1 boundary", () => {
  it("does not fabricate a verification result before orchestration exists", async () => {
    await expect(createEngine().run({} as never)).rejects.toThrow(
      "Verification orchestration is not implemented",
    );
  });
});
