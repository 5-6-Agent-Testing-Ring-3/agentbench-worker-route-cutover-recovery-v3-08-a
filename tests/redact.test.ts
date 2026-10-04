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

it("redacts all runtime values embedded in free text and hides raw errors", async () => {
  const { config } = await import("./helpers.js");
  const text = JSON.stringify(
    redact({ details: Object.values(config).join(" ") }, config),
  );
  for (const value of Object.values(config) as string[])
    expect(text).not.toContain(value);
  expect(JSON.stringify(redact(new Error(config.token), config))).not.toContain(
    config.token,
  );
});
