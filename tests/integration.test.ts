import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CloudflareClient } from "../src/cloudflare-client.js";
import { JournalStore } from "../src/journal.js";
import { createPlan } from "../src/planner.js";
import { applyRollout, rollback } from "../src/rollout.js";
import { required } from "../src/safety.js";
import worker from "../src/worker.js";
import {
  apiResponse,
  clock,
  config as fixtureConfig,
  logger,
} from "./helpers.js";

const config = { ...fixtureConfig, zoneId: "integration-zone" };

describe("HTTP adapter integration (no network)", () => {
  it("plans, deploys via multipart, probes, cuts over, restores versions and performs final cutover", async () => {
    let routes = [
      {
        id: "prod-id",
        pattern: `${config.productionHostname}/*`,
        script: config.stableWorker,
      },
    ];
    const stable = {
      id: "stable-deployment",
      created_on: clock.now().toISOString(),
      versions: [{ version_id: "stable-version", percentage: 100 }],
    };
    let candidate = {
      ...stable,
      id: "previous-candidate",
      versions: [{ version_id: "previous-version", percentage: 100 }],
    };
    let sequence = 0;
    let uploads = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (url.hostname !== "api.cloudflare.com") {
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
        const route = routes.find((r) => r.pattern === `${url.hostname}/*`);
        const role =
          route?.script === config.stableWorker ? "stable" : "candidate";
        return worker.fetch(new Request(url, init), {
          RELEASE_VERSION: role === "stable" ? "v1" : "v2",
          WORKER_ROLE: role,
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        `Bearer ${config.token}`,
      );
      if (url.pathname.endsWith("/settings")) {
        const role = url.pathname.includes(config.stableWorker)
          ? "stable"
          : "candidate";
        return apiResponse({
          compatibility_date: "2025-08-23",
          bindings: [
            {
              name: "RELEASE_VERSION",
              type: "plain_text",
              text: role === "stable" ? "v1" : "v2",
            },
            { name: "WORKER_ROLE", type: "plain_text", text: role },
            { name: "PRESERVED_SECRET", type: "secret_text" },
          ],
        });
      }
      if (url.pathname.endsWith("/deployments")) {
        if (method === "GET")
          return apiResponse({
            deployments: [
              url.pathname.includes(config.stableWorker) ? stable : candidate,
            ],
          });
        expect(url.pathname).toContain(config.candidateWorker);
        const body = JSON.parse(String(init?.body)) as {
          versions: typeof candidate.versions;
        };
        candidate = {
          ...candidate,
          id: `deployment-${String(++sequence)}`,
          versions: body.versions,
        };
        return apiResponse(candidate);
      }
      if (url.pathname.endsWith("/versions")) {
        expect(method).toBe("POST");
        expect(url.pathname).toContain(config.candidateWorker);
        expect(init?.body).toBeInstanceOf(FormData);
        uploads++;
        return apiResponse({ id: "uploaded-version" });
      }
      if (url.pathname.endsWith("/routes") && method === "GET")
        return apiResponse(routes);
      if (url.pathname.endsWith("/routes") && method === "POST") {
        const route = {
          ...(JSON.parse(String(init?.body)) as {
            pattern: string;
            script: string;
          }),
          id: "owned-id",
        };
        routes.push(route);
        return apiResponse(route);
      }
      const id = url.pathname.split("/").at(-1);
      const existing = required(routes.find((r) => r.id === id));
      if (method === "PUT") {
        const route = {
          ...existing,
          ...(JSON.parse(String(init?.body)) as {
            pattern: string;
            script: string;
          }),
        };
        routes = routes.map((r) => (r.id === id ? route : r));
        return apiResponse(route);
      }
      expect(method).toBe("DELETE");
      expect(id).toBe("owned-id");
      routes = routes.filter((r) => r.id !== id);
      return apiResponse(null);
    });
    const client = new CloudflareClient(config, clock, fetcher);
    const dir = await mkdtemp(join(tmpdir(), "integration-"));
    const store = new JournalStore(join(dir, "journal.json"));
    const plan = await createPlan(
      client,
      config,
      clock,
      store,
      "export default {};",
    );
    expect(plan.blocked).toEqual([]);
    expect(uploads).toBe(0);
    const apply = () =>
      applyRollout(client, config, store, clock, logger, {
        bundle: "export default {};",
        evidencePath: join(dir, "evidence.json"),
        fetcher,
      });
    await apply();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.script).toBe(config.candidateWorker);
    await rollback(client, config, store, clock, fetcher);
    expect(routes[0]?.script).toBe(config.stableWorker);
    expect(candidate.versions[0]?.version_id).toBe("previous-version");
    expect(stable.id).toBe("stable-deployment");
    await apply();
    expect(routes[0]?.script).toBe(config.candidateWorker);
    expect(uploads).toBe(1);
  });
});
