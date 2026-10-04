import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

describe("redact", () => {
  it("redacts nested sensitive keys", () => {
    expect(
      redact({
        token: "abc",
        nested: { Authorization: "Bearer abc", id: "safe" },
      }),
    ).toEqual({
      token: "[REDACTED]",
      nested: { Authorization: "[REDACTED]", id: "safe" },
    });
  });

  it("preserves ordinary arrays and primitive values", () => {
    expect(redact(["safe", 3, { id: "visible" }])).toEqual([
      "safe",
      3,
      { id: "visible" },
    ]);
  });
});
