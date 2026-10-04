import { describe, expect, it, vi } from "vitest";
import { createPlan, readLiveState } from "../src/planner.js";
import type { CloudflareClient } from "../src/cloudflare-client.js";
import {
  canaryRoute,
  clock,
  config,
  deployment,
  productionRoute,
} from "./helpers.js";

function client(): CloudflareClient {
  return {
    listRoutes: vi.fn(async () => [productionRoute, canaryRoute]),
    listDeployments: vi.fn(async () => [deployment]),
  } as unknown as CloudflareClient;
}

describe("planner", () => {
  it("reads the relevant live state", async () => {
    await expect(readLiveState(client(), config)).resolves.toMatchObject({
      productionRoute,
      canaryRoute,
    });
  });

  it("creates a deterministic action list", async () => {
    const plan = await createPlan(client(), config, clock);
    expect(plan.generatedAt).toBe("2025-08-23T00:00:00.000Z");
    expect(plan.actions.map((action) => action.kind)).toEqual([
      "deploy-candidate",
      "set-canary",
      "set-production",
      "remove-canary",
    ]);
  });

  it("plans route creation when no route exists", async () => {
    const api = {
      listRoutes: vi.fn(async () => []),
      listDeployments: vi.fn(async () => []),
    } as unknown as CloudflareClient;
    const plan = await createPlan(api, config, clock);
    expect(plan.baseline.productionRoute).toBeNull();
    expect(plan.actions.some((action) => action.kind === "remove-canary")).toBe(
      false,
    );
  });
});
