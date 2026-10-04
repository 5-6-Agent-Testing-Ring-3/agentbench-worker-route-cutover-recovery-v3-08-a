import { describe, expect, it, vi } from "vitest";
import { validateEndpoint } from "../src/validation.js";
import { clock, config, settings } from "./helpers.js";
import worker from "../src/worker.js";

describe("public contract", () => {
  it("checks health, identity, configuration, missing paths and forbidden methods", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) =>
      worker.fetch(new Request(input, init), {
        RELEASE_VERSION: "v2",
        WORKER_ROLE: "candidate",
      }),
    );
    await validateEndpoint(
      config.canaryHostname,
      settings("candidate").identity,
      clock,
      fetcher,
    );
    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const call of fetcher.mock.calls) {
      expect(call[1]?.redirect).toBe("error");
      expect(call[1]?.signal).toBeDefined();
    }
  });
  it.each(["identity", "features", "json", "headers", "status", "transport"])(
    "rejects persistent %s failures with bounded probes",
    async (failure) => {
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        if (failure === "transport") throw new Error(config.token);
        const good = worker.fetch(new Request(input, init), {
          RELEASE_VERSION: failure === "identity" ? "old" : "v2",
          WORKER_ROLE: "candidate",
        });
        if (failure === "identity") return good;
        if (failure === "json")
          return new Response("malformed", {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          });
        if (failure === "headers") return new Response("{}");
        if (failure === "status") return new Response("{}", { status: 503 });
        if (String(input).endsWith("/api/config"))
          return new Response('{"schemaVersion":1,"features":[]}', {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          });
        return good;
      });
      await expect(
        validateEndpoint(
          config.canaryHostname,
          settings("candidate").identity,
          clock,
          fetcher,
        ),
      ).rejects.toThrow("propagation budget");
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(18);
    },
  );
});
