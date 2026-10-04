import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { required } from "../src/safety.js";
import { JournalStore } from "../src/journal.js";
import { applyRollout, rollback, verifyCompleted } from "../src/rollout.js";
import {
  clock,
  config,
  logger,
  productionRoute,
  recovery,
  remote,
} from "./helpers.js";

async function setup(canary = true) {
  const dir = await mkdtemp(join(tmpdir(), "rollout-"));
  const store = new JournalStore(join(dir, "journal.json"));
  const evidencePath = join(dir, "evidence.json");
  const r = remote(canary);
  const apply = () =>
    applyRollout(r.client, config, store, clock, logger, {
      bundle: "export default {};",
      evidencePath,
      fetcher: r.fetcher,
    });
  const back = () => rollback(r.client, config, store, clock, r.fetcher);
  return { r, store, apply, back, evidencePath };
}
describe("recoverable rollout", () => {
  it.each([true, false])(
    "validates before cutover, preserves owned boundaries, no-op reruns, rollback and final cutover (existing canary=%s)",
    async (canary) => {
      const { r, store, apply, back, evidencePath } = await setup(canary);
      const before = structuredClone(r.live);
      const result = await apply();
      expect(result.validation).toBe("passed");
      expect(JSON.parse(await readFile(evidencePath, "utf8"))).toEqual(result);
      expect(r.events.indexOf("route:production:candidate")).toBeGreaterThan(
        r.events.indexOf("probe:canary:/api/config"),
      );
      expect(r.live.canaryRoute).toEqual(before.canaryRoute);
      expect(r.api.deleteCanary).toHaveBeenCalledTimes(canary ? 0 : 1);
      expect(r.live.stableDeployment).toEqual(before.stableDeployment);
      await apply();
      expect(r.api.uploadCandidate).toHaveBeenCalledTimes(1);
      expect(r.api.deployCandidate).toHaveBeenCalledTimes(1);
      await back();
      expect(r.live.productionRoute).toEqual(before.productionRoute);
      expect(r.live.candidateDeployment.versions).toEqual(
        before.candidateDeployment.versions,
      );
      await back();
      expect(r.api.deployCandidate).toHaveBeenCalledTimes(2);
      await apply();
      expect((await store.read())?.phase).toBe("complete");
      expect(r.api.uploadCandidate).toHaveBeenCalledTimes(1);
    },
  );
  it("fails candidate contract validation without sending production traffic", async () => {
    const { r, store, apply } = await setup();
    const good = required(r.fetcher.getMockImplementation());
    r.fetcher.mockImplementation(async (input, init) =>
      String(input).includes(config.canaryHostname)
        ? new Response("{}")
        : good(input, init),
    );
    await expect(apply()).rejects.toThrow("baseline restored");
    expect(r.events).not.toContain("route:production:candidate");
    expect(r.live.productionRoute).toEqual(productionRoute);
    expect((await store.read())?.phase).toBe("rolled-back");
  });
  it.each([false, true])(
    "recovers a route failure immediately around cutover (after=%s)",
    async (after) => {
      const { r, apply } = await setup();
      const replace = required(r.api.replaceRoute.getMockImplementation());
      r.api.replaceRoute.mockImplementation(async (route, script) => {
        if (route.pattern === "production" && script === "candidate") {
          if (after) await replace(route, script);
          throw new Error("lost response");
        }
        return replace(route, script);
      });
      if (after)
        await expect(apply()).resolves.toMatchObject({ validation: "passed" });
      else {
        await expect(apply()).rejects.toThrow("baseline restored");
        expect(r.live.productionRoute).toEqual(productionRoute);
      }
    },
  );
  it("restores production and candidate deployment after post-cutover public failure", async () => {
    const { r, store, apply } = await setup();
    const good = required(r.fetcher.getMockImplementation());
    r.fetcher.mockImplementation(async (input, init) =>
      String(input).includes(config.productionHostname) &&
      r.live.productionRoute?.script === "candidate"
        ? new Response("{}")
        : good(input, init),
    );
    await expect(apply()).rejects.toThrow("baseline restored");
    expect(r.live.productionRoute).toEqual(productionRoute);
    expect((await store.read())?.phase).toBe("rolled-back");
  });
  it("reconciles deployment success with a lost POST response", async () => {
    const { r, apply } = await setup();
    const deploy = required(r.api.deployCandidate.getMockImplementation());
    r.api.deployCandidate.mockImplementationOnce(async (versions) => {
      await deploy(versions);
      throw new Error("timeout");
    });
    await expect(apply()).resolves.toMatchObject({ validation: "passed" });
    expect(r.api.deployCandidate).toHaveBeenCalledTimes(1);
  });
  it("recovers an interrupted cutover by reading live state before another upload", async () => {
    const { r, store, apply } = await setup();
    const j = recovery(r.live);
    await store.write({
      ...j,
      phase: "cutover-intent",
      candidateVersionId: "version-new-candidate",
    });
    await r.api.deployCandidate([
      { version_id: "version-new-candidate", percentage: 100 },
    ]);
    r.live = {
      ...r.live,
      productionRoute: { ...productionRoute, script: "candidate" },
      canaryRoute: { ...required(r.live.canaryRoute), script: "candidate" },
    };
    await apply();
    expect(r.events.indexOf("route:production:stable")).toBeLessThan(
      r.events.lastIndexOf("route:production:candidate"),
    );
    expect(r.api.uploadCandidate).not.toHaveBeenCalled();
  });
  it("handles propagation delay without repeated mutations", async () => {
    const { r, apply } = await setup();
    const good = required(r.fetcher.getMockImplementation());
    let stale = 2;
    r.fetcher.mockImplementation(async (input, init) =>
      String(input).includes(config.canaryHostname) && stale-- > 0
        ? new Response("{}")
        : good(input, init),
    );
    await apply();
    expect(r.api.uploadCandidate).toHaveBeenCalledTimes(1);
    expect(r.fetcher.mock.calls.length).toBeGreaterThan(15);
  });
  it("refuses missing, mismatched, stale and changed-bundle recovery", async () => {
    const { r, store, apply, back, evidencePath } = await setup();
    await expect(back()).rejects.toThrow("No recovery journal");
    await store.write({ ...recovery(), scope: "0".repeat(64) });
    await expect(apply()).rejects.toThrow("scope mismatch");
    await store.write(recovery());
    await expect(
      applyRollout(r.client, config, store, clock, logger, {
        bundle: "different bundle",
        evidencePath,
        fetcher: r.fetcher,
      }),
    ).rejects.toThrow("Bundle differs");
    r.live = {
      ...r.live,
      stableDeployment: { ...r.live.stableDeployment, id: "external-change" },
    };
    await expect(back()).rejects.toThrow("Stable deployment");
    expect(r.api.replaceRoute).not.toHaveBeenCalled();
  });
  it("does not trust a complete journal when production disappeared", async () => {
    const { r, store, apply } = await setup();
    await apply();
    r.live = { ...r.live, productionRoute: null };
    await expect(apply()).rejects.toThrow("recovery could not be verified");
    await expect(
      verifyCompleted(
        r.client,
        config,
        required(await store.read()),
        clock,
        r.fetcher,
      ),
    ).rejects.toThrow();
  });
  it("does not claim rollback success when restoration cannot be verified", async () => {
    const { r, store, apply, back } = await setup();
    await apply();
    r.fetcher.mockResolvedValue(new Response("{}"));
    await expect(back()).rejects.toThrow("Public endpoint");
    expect((await store.read())?.phase).toBe("rollback-intent");
    expect(r.live.productionRoute?.script).toBe("stable");
  });
  it("preserves a canary with ambiguous creation ownership and restores production", async () => {
    const { r, store, apply } = await setup(false);
    const create = required(r.api.createCanary.getMockImplementation());
    r.api.createCanary.mockImplementationOnce(async () => {
      await create();
      throw new Error("lost response");
    });
    await expect(apply()).rejects.toThrow(
      "full recovery could not be verified",
    );
    expect(r.live.productionRoute?.script).toBe("stable");
    expect(r.api.deleteCanary).not.toHaveBeenCalled();
    expect((await store.read())?.phase).toBe("rollback-intent");
  });
  it("restores production if owned cleanup fails, retaining recovery intent", async () => {
    const { r, store, apply } = await setup(false);
    r.api.deleteCanary.mockRejectedValue(new Error("unavailable"));
    await expect(apply()).rejects.toThrow(
      "full recovery could not be verified",
    );
    expect(r.live.productionRoute?.script).toBe("stable");
    expect((await store.read())?.phase).toBe("rollback-intent");
  });
  it("rejects candidate and route drift before rollback", async () => {
    const { r, apply, back } = await setup();
    await apply();
    r.live = {
      ...r.live,
      candidateDeployment: {
        ...r.live.candidateDeployment,
        versions: [{ version_id: "unrelated", percentage: 100 }],
      },
    };
    await expect(back()).rejects.toThrow("Candidate deployment drifted");
  });
  it("scans supplied bundle before any remote mutation", async () => {
    const { r, store, evidencePath } = await setup();
    await expect(
      applyRollout(r.client, config, store, clock, logger, {
        bundle: config.token,
        evidencePath,
        fetcher: r.fetcher,
      }),
    ).rejects.toThrow("Credential material");
    expect(r.api.uploadCandidate).not.toHaveBeenCalled();
  });
  it("excludes concurrent apply while baseline validation is in flight", async () => {
    const { r, store, apply } = await setup();
    await store.withLock(recovery().scope, async () => {
      await expect(apply()).rejects.toThrow("Concurrent rollout");
      expect(r.api.uploadCandidate).not.toHaveBeenCalled();
    });
  });
});

it.each(["cutover-intent", "production-verified"])(
  "recovers a failed durable journal write at %s",
  async (phase) => {
    const { r, store, apply } = await setup();
    const write = store.write.bind(store);
    let failed = false;
    vi.spyOn(store, "write").mockImplementation(async (journal) => {
      if (journal.phase === phase && !failed) {
        failed = true;
        throw new Error("simulated disk failure");
      }
      return write(journal);
    });
    await expect(apply()).rejects.toThrow("baseline restored");
    expect(r.live.productionRoute).toEqual(productionRoute);
    expect((await store.read())?.phase).toBe("rolled-back");
  },
);

it("retries rollback after candidate deployment restoration fails", async () => {
  const { r, store, apply, back } = await setup();
  await apply();
  r.api.deployCandidate.mockRejectedValueOnce(new Error("unavailable"));
  await expect(back()).rejects.toThrow("did not converge");
  expect(r.live.productionRoute).toEqual(productionRoute);
  expect((await store.read())?.phase).toBe("rollback-intent");
  await back();
  expect((await store.read())?.phase).toBe("rolled-back");
});

it("rejects an external redeployment of even the same candidate version", async () => {
  const { r, apply, back } = await setup();
  await apply();
  r.live = {
    ...r.live,
    candidateDeployment: {
      ...r.live.candidateDeployment,
      id: "external-deployment",
    },
  };
  await expect(back()).rejects.toThrow("Candidate deployment drifted");
});

it("reconciles cleanup that succeeded before its response was lost", async () => {
  const { r, apply } = await setup(false);
  const remove = required(r.api.deleteCanary.getMockImplementation());
  r.api.deleteCanary.mockImplementationOnce(async () => {
    await remove();
    throw new Error("lost response");
  });
  await expect(apply()).resolves.toMatchObject({
    cleanup: "owned-route-removed",
  });
  expect(r.live.canaryRoute).toBeNull();
});
