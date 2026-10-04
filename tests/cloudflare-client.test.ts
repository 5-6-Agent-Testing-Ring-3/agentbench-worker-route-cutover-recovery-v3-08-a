import { describe, expect, it, vi } from "vitest";
import { CloudflareClient } from "../src/cloudflare-client.js";
import { clock, config } from "./helpers.js";

function response(result: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, result }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CloudflareClient", () => {
  it("lists routes with bearer authentication", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response([]));
    const client = new CloudflareClient(config, clock, fetcher);
    await expect(client.listRoutes()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/workers/routes"),
      expect.objectContaining({}),
    );
  });

  it("retries a transient response", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(null, 500))
      .mockResolvedValueOnce(response([]));
    const client = new CloudflareClient(config, clock, fetcher);
    await expect(client.listRoutes()).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-transient API error", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            success: false,
            result: null,
            errors: [{ code: 1000, message: "invalid" }],
          }),
          { status: 400 },
        ),
    );
    const client = new CloudflareClient(config, clock, fetcher);
    await expect(client.listRoutes()).rejects.toThrow(
      "Cloudflare request failed",
    );
  });

  it("creates, replaces, deletes routes and uploads a candidate", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/scripts/") && init?.method === "PUT")
        return response({ id: "deployment-v2" });
      if (init?.method === "DELETE") return response(null);
      return response({
        id: "route",
        pattern: "example/*",
        script: "candidate",
      });
    });
    const client = new CloudflareClient(config, clock, fetcher);
    await expect(client.uploadCandidate("bundle")).resolves.toEqual({
      id: "deployment-v2",
    });
    await expect(
      client.createRoute("example/*", "candidate"),
    ).resolves.toMatchObject({ id: "route" });
    await expect(
      client.replaceRoute("route", "example/*", "candidate"),
    ).resolves.toMatchObject({ id: "route" });
    await expect(client.deleteRoute("route")).resolves.toBeUndefined();
  });
});
