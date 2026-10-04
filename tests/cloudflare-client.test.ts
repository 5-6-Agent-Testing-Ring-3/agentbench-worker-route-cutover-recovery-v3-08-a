import { describe, expect, it, vi } from "vitest";
import { CloudflareClient, parseDeployment } from "../src/cloudflare-client.js";
import { apiResponse, clock, config, productionRoute } from "./helpers.js";

const rawProduction = {
  id: productionRoute.id,
  pattern: `${config.productionHostname}/*`,
  script: config.stableWorker,
};
const rawCanary = {
  id: "new-canary",
  pattern: `${config.canaryHostname}/*`,
  script: config.candidateWorker,
};
const rawSettings = {
  compatibility_date: "2025-08-23",
  compatibility_flags: [],
  bindings: [
    { type: "plain_text", name: "RELEASE_VERSION", text: "v2" },
    { type: "plain_text", name: "WORKER_ROLE", text: "candidate" },
    { type: "secret_text", name: "KEEP_ME" },
  ],
};
const rawDeployment = {
  id: "deployment",
  created_on: "2026-10-04T00:00:00Z",
  versions: [{ version_id: "version", percentage: 100 }],
};

describe("CloudflareClient", () => {
  it("normalizes scoped routes and authenticates only API requests", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      apiResponse([
        rawProduction,
        { id: "other", pattern: "other.example.test/*", script: "unrelated" },
      ]),
    );
    const api = new CloudflareClient(config, clock, fetcher);
    expect(await api.listRoutes()).toEqual([productionRoute]);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${config.token}`);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it.each([
    [{ ...rawProduction, pattern: "*.example.test/*" }],
    [rawProduction, rawProduction],
    [{ ...rawProduction, script: "unrelated" }],
    [{ ...rawCanary, pattern: "other.example.test/*" }],
    [{ ...rawProduction, pattern: `https://${config.productionHostname}/*` }],
    [{ ...rawProduction, pattern: `${config.productionHostname}/api/*` }],
  ])(
    "rejects ambiguous or out-of-scope route inventory %#",
    async (...routes) => {
      const api = new CloudflareClient(
        config,
        clock,
        vi.fn(async () => apiResponse(routes)),
      );
      await expect(api.listRoutes()).rejects.toThrow();
    },
  );
  it("accepts a disabled route as live state", async () => {
    const api = new CloudflareClient(
      config,
      clock,
      vi.fn(async () => apiResponse([{ ...rawProduction, script: null }])),
    );
    expect((await api.listRoutes())[0]?.script).toBeNull();
  });
  it("honors bounded rate limit and transient backoff", async () => {
    const localClock = { ...clock, sleep: vi.fn(async () => undefined) };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(apiResponse(null, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(apiResponse(null, 503))
      .mockResolvedValueOnce(apiResponse([]));
    const api = new CloudflareClient(config, localClock, fetcher);
    expect(await api.listRoutes()).toEqual([]);
    expect(localClock.sleep.mock.calls).toEqual([[2000], [500]]);
    const exhausted = vi.fn<typeof fetch>(async () => apiResponse(null, 429));
    await expect(
      new CloudflareClient(config, localClock, exhausted).listRoutes(),
    ).rejects.toThrow("429");
    expect(exhausted).toHaveBeenCalledTimes(4);
    const longLimit = vi.fn<typeof fetch>(async () =>
      apiResponse(null, 429, { "retry-after": "9999" }),
    );
    await expect(
      new CloudflareClient(config, localClock, longLimit).listRoutes(),
    ).rejects.toThrow("Retry-After exceeds");
    expect(longLimit).toHaveBeenCalledTimes(1);
  });
  it.each(["Sun, 04 Oct 2026 00:00:02 GMT", "invalid"])(
    "handles Retry-After %s",
    async (retry) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(apiResponse(null, 429, { "retry-after": retry }))
        .mockResolvedValueOnce(apiResponse([]));
      expect(
        await new CloudflareClient(config, clock, fetcher).listRoutes(),
      ).toEqual([]);
    },
  );
  it("bounds timeouts and never exposes raw remote errors", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(config.token);
    });
    await expect(
      new CloudflareClient(config, clock, fetcher).listRoutes(),
    ).rejects.toThrow("transport failure");
    expect(fetcher).toHaveBeenCalledTimes(4);
    const failed = new CloudflareClient(
      config,
      clock,
      vi.fn(async () => new Response(config.token, { status: 403 })),
    );
    await expect(failed.listRoutes()).rejects.toThrow("HTTP 403");
  });
  it.each([
    "not json",
    '{"success":false,"result":[]}',
    '{"success":true}',
    "null",
    '{"success":true,"result":{}}',
  ])("rejects malformed envelopes %#", async (body) => {
    await expect(
      new CloudflareClient(
        config,
        clock,
        vi.fn(async () => new Response(body)),
      ).listRoutes(),
    ).rejects.toThrow();
  });
  it("parses the real deployment envelope and preserves version percentages", async () => {
    const api = new CloudflareClient(
      config,
      clock,
      vi.fn(async () => apiResponse({ deployments: [rawDeployment] })),
    );
    expect((await api.listDeployments("stable"))[0]?.versions).toEqual(
      rawDeployment.versions,
    );
    expect(() =>
      parseDeployment({
        ...rawDeployment,
        versions: [{ version_id: "v", percentage: 25 }],
      }),
    ).toThrow("total 100");
    expect(() =>
      parseDeployment({
        ...rawDeployment,
        versions: [{ version_id: "v", percentage: 0 }],
      }),
    ).toThrow("percentage");
    await expect(
      new CloudflareClient(
        config,
        clock,
        vi.fn(async () => apiResponse([])),
      ).listDeployments("stable"),
    ).rejects.toThrow();
  });
  it("inherits bindings from the captured version using strict multipart upload", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith("/settings")) return apiResponse(rawSettings);
      expect(String(input)).toContain("/versions?bindings_inherit=strict");
      const form = init?.body as FormData;
      const metadata = JSON.parse(String(form.get("metadata"))) as {
        bindings: unknown[];
      };
      expect(metadata.bindings).toContainEqual({
        name: "KEEP_ME",
        type: "inherit",
        version_id: "old-version",
      });
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      return apiResponse({ id: "new-version" });
    });
    const api = new CloudflareClient(config, clock, fetcher);
    expect((await api.settings("candidate")).bindingTypes).toContain(
      "secret_text",
    );
    expect(
      await api.uploadCandidate("export default {};", "old-version"),
    ).toEqual({ id: "new-version" });
  });
  it("refuses unsupported settings before an upload", async () => {
    const api = new CloudflareClient(
      config,
      clock,
      vi.fn(async () => apiResponse({ ...rawSettings, assets: {} })),
    );
    await expect(api.uploadCandidate("bundle", "v1")).rejects.toThrow(
      "Unsupported",
    );
  });
  it("never replays ambiguous POSTs but permits explicit rate-limit retry", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => apiResponse(null, 500));
    await expect(
      new CloudflareClient(config, clock, fetcher).deployCandidate(
        rawDeployment.versions,
      ),
    ).rejects.toThrow("unknown");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(apiResponse(null, 429))
      .mockResolvedValueOnce(apiResponse(rawDeployment));
    expect(
      (
        await new CloudflareClient(config, clock, limited).deployCandidate(
          rawDeployment.versions,
        )
      ).id,
    ).toBe("deployment");
    const timeout = vi.fn<typeof fetch>(async () => {
      throw new Error("timeout");
    });
    await expect(
      new CloudflareClient(config, clock, timeout).deployCandidate(
        rawDeployment.versions,
      ),
    ).rejects.toThrow("unknown");
    expect(timeout).toHaveBeenCalledTimes(1);
  });
  it("guards route changes and deletion with fresh reads", async () => {
    let routes = [rawProduction];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      if (!init?.method) return apiResponse(routes);
      if (init.method === "POST") {
        routes.push(rawCanary);
        return apiResponse(rawCanary);
      }
      if (init.method === "DELETE") {
        routes = routes.filter((r) => r.id !== rawCanary.id);
        return apiResponse(null);
      }
      if (init.method === "PUT") {
        expect(String(input)).toContain(rawProduction.id);
        return apiResponse(rawProduction);
      }
      throw new Error("unexpected");
    });
    const api = new CloudflareClient(config, clock, fetcher);
    await api.replaceRoute(productionRoute, "candidate");
    await api.replaceRoute(productionRoute, null);
    const canary = await api.createCanary();
    await expect(api.createCanary()).rejects.toThrow("Canary appeared");
    await expect(api.deleteCanary(productionRoute)).rejects.toThrow(
      "Only owned",
    );
    await expect(
      api.deleteCanary({ ...canary, id: "different" }),
    ).rejects.toThrow("ownership changed");
    await api.deleteCanary(canary);
    await api.deleteCanary(canary);
    await expect(
      api.replaceRoute({ ...productionRoute, id: "different" }, "stable"),
    ).rejects.toThrow("drift");
  });
});
