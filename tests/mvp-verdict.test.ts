import { describe, expect, it } from "vitest";
import { calculateMvpVerdict } from "../apps/api/src/mvp-verdict.js";

describe("MVP verdict authority", () => {
  it("ignores a legacy sandbox error when CI and requirements pass", () => {
    expect(
      calculateMvpVerdict({
        legacyStatus: "error",
        ci: "PASS",
        requirements: [{ text: "Pin CI actions", status: "passed" }],
      }),
    ).toBe("pass");
  });
});
