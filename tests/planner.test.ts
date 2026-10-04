import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlan, readLiveState } from "../src/planner.js";
import { required } from "../src/safety.js";
import { JournalStore } from "../src/journal.js";
import { clock, config, recovery, remote } from "./helpers.js";

describe("read-only plan", () => {
  it("is byte deterministic, reads both deployments/settings and writes nothing", async () => {
    const r = remote();
    const dir = await mkdtemp(join(tmpdir(), "plan-"));
    const store = new JournalStore(join(dir, "missing.json"));
    const a = await createPlan(r.client, config, clock, store);
    expect(JSON.stringify(a)).toBe(
      JSON.stringify(await createPlan(r.client, config, clock, store)),
    );
    expect(a.actions).toContain("restore-pre-existing-canary-route");
    expect(a.blocked).toEqual([]);
    expect(r.events).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
    expect(await readLiveState(r.client)).toEqual(r.live);
  });
  it("plans owned creation and deletion for absent canary", async () => {
    const plan = await createPlan(remote(false).client, config, clock);
    expect(plan.actions).toContain("delete-only-recorded-owned-canary-route");
  });
  it("reports missing production and ambiguous candidate deployments", async () => {
    const r = remote();
    r.live = {
      ...r.live,
      productionRoute: null,
      candidateDeployment: { ...r.live.candidateDeployment, versions: [] },
    };
    expect((await createPlan(r.client, config, clock)).blocked).toHaveLength(2);
  });
  it("refuses an unjournaled production candidate and reports scoped recovery", async () => {
    const r = remote();
    r.live = {
      ...r.live,
      productionRoute: {
        ...required(r.live.productionRoute),
        script: "candidate",
      },
    };
    expect((await createPlan(r.client, config, clock)).blocked[0]).toContain(
      "without a recovery journal",
    );
    const dir = await mkdtemp(join(tmpdir(), "plan-"));
    const store = new JournalStore(join(dir, "journal.json"));
    await store.write({ ...recovery(), scope: "0".repeat(64) });
    expect(
      (await createPlan(r.client, config, clock, store)).blocked[0],
    ).toContain("different resource scope");
    await store.write({ ...recovery(), phase: "complete" });
    expect(
      (await createPlan(r.client, config, clock, store)).actions,
    ).toContain("no-op-if-bundle-and-live-state-match");
  });
});
