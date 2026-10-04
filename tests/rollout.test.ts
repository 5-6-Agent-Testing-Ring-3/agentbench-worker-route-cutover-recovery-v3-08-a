import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CloudflareClient } from "../src/cloudflare-client.js";
import { JournalStore } from "../src/journal.js";
import { applyRollout, rollback } from "../src/rollout.js";
import {
  canaryRoute,
  clock,
  config,
  deployment,
  logger,
  productionRoute,
} from "./helpers.js";

function client(): CloudflareClient {
  return {
    listRoutes: vi.fn(async () => [productionRoute, canaryRoute]),
    listDeployments: vi.fn(async () => [deployment]),
    uploadCandidate: vi.fn(async () => ({ id: "deployment-v2" })),
    replaceRoute: vi.fn(
      async (id: string, pattern: string, script: string) => ({
        id,
        pattern,
        script,
      }),
    ),
    createRoute: vi.fn(async (pattern: string, script: string) => ({
      id: "created",
      pattern,
      script,
    })),
    deleteRoute: vi.fn(async () => undefined),
  } as unknown as CloudflareClient;
}

describe("rollout", () => {
  it("applies a successful rollout and writes evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-apply-"));
    const evidencePath = join(directory, "artifacts", "evidence.json");
    const store = new JournalStore(join(directory, ".rollout", "journal.json"));
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    );
    const evidence = await applyRollout(
      client(),
      config,
      store,
      clock,
      logger,
      {
        bundle: "bundle",
        evidencePath,
        fetcher,
      },
    );
    expect(evidence).toMatchObject({
      candidateDeploymentId: "deployment-v2",
      healthPassed: true,
    });
    expect(JSON.parse(await readFile(evidencePath, "utf8"))).toMatchObject({
      runId: evidence.runId,
    });
  });

  it("rolls back using the journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-back-"));
    const store = new JournalStore(join(directory, "journal.json"));
    await store.write({
      schemaVersion: 1,
      runId: "run",
      startedAt: "2025-08-23T00:00:00.000Z",
      previousProduction: productionRoute,
      candidateDeploymentId: "deployment-v2",
      productionChanged: true,
      completed: false,
    });
    const api = client();
    await expect(rollback(api, config, store)).resolves.toMatchObject({
      script: config.stableWorker,
    });
  });

  it("rejects rollback without recovery data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-back-"));
    const store = new JournalStore(join(directory, "journal.json"));
    await expect(rollback(client(), config, store)).rejects.toThrow(
      "No previous production route",
    );
  });
});
