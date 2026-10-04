import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../src/cloudflare-client.js";
import { JournalStore } from "../src/journal.js";
import { status } from "../src/status.js";
import { canaryRoute, config, productionRoute } from "./helpers.js";

describe("status", () => {
  it("combines journal and live routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-status-"));
    const client = {
      listRoutes: vi.fn(async () => [productionRoute, canaryRoute]),
    } as unknown as CloudflareClient;
    await expect(
      status(client, config, new JournalStore(join(directory, "journal.json"))),
    ).resolves.toMatchObject({
      productionRoute,
      canaryRoute,
      journal: null,
    });
  });

  it("falls back to the journal when production is absent from live routes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-status-"));
    const store = new JournalStore(join(directory, "journal.json"));
    await store.write({
      schemaVersion: 1,
      runId: "run",
      startedAt: "2025-08-23T00:00:00.000Z",
      previousProduction: productionRoute,
      candidateDeploymentId: null,
      productionChanged: false,
      completed: false,
    });
    const client = {
      listRoutes: vi.fn(async () => []),
    } as unknown as CloudflareClient;
    await expect(status(client, config, store)).resolves.toMatchObject({
      productionRoute,
      canaryRoute: null,
    });
  });
});
