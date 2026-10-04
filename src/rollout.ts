import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CloudflareClient } from "./cloudflare-client.js";
import type { JournalStore } from "./journal.js";
import { createPlan, readLiveState } from "./planner.js";
import {
  assertClean,
  required,
  ensure,
  hash,
  same,
  scope,
  SafetyError,
  systemClock,
} from "./safety.js";
import { validateEndpoint } from "./validation.js";
import type {
  Clock,
  Evidence,
  Journal,
  LiveState,
  Logger,
  Phase,
  Route,
  RuntimeConfig,
} from "./types.js";

export interface ApplyOptions {
  readonly bundle: string;
  readonly evidencePath: string;
  readonly fetcher?: typeof fetch;
}
function assertJournal(j: Journal, config: RuntimeConfig): void {
  ensure(j.scope === scope(config), "Recovery journal scope mismatch");
  ensure(
    j.baseline.productionRoute?.pattern === "production" &&
      j.baseline.productionRoute.script === "stable",
    "Incomplete production recovery data",
  );
  ensure(
    j.baseline.stableDeployment.versions.length > 0 &&
      j.baseline.candidateDeployment.versions.length === 1,
    "Incomplete deployment recovery data",
  );
  ensure(
    j.baseline.canaryRoute === null ||
      j.baseline.canaryRoute.pattern === "canary",
    "Invalid canary recovery data",
  );
}
function stableUnchanged(j: Journal, live: LiveState): void {
  ensure(
    same(live.stableDeployment, j.baseline.stableDeployment) &&
      same(live.stableSettings, j.baseline.stableSettings),
    "Stable deployment or settings drifted; refusing stale recovery data",
  );
  ensure(
    live.productionRoute?.id === j.baseline.productionRoute?.id &&
      live.productionRoute?.pattern === "production",
    "Production route identity drifted; refusing stale recovery data",
  );
}
function candidateIsOurs(j: Journal, live: LiveState): boolean {
  return (
    j.candidateVersionId !== null &&
    (j.candidateDeploymentId === null ||
      live.candidateDeployment.id === j.candidateDeploymentId) &&
    same(live.candidateDeployment.versions, [
      { version_id: j.candidateVersionId, percentage: 100 },
    ])
  );
}
async function save(
  store: JournalStore,
  j: Journal,
  clock: Clock,
  phase: Phase,
  updates: Partial<Journal> = {},
): Promise<Journal> {
  const next = {
    ...j,
    ...updates,
    phase,
    transitions: [...j.transitions, { at: clock.now().toISOString(), phase }],
  };
  await store.write(next);
  return next;
}
async function waitLive(
  client: CloudflareClient,
  clock: Clock,
  check: (live: LiveState) => boolean,
): Promise<LiveState> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const live = await readLiveState(client);
    if (check(live)) return live;
    if (attempt < 5) await clock.sleep(Math.min(500 * 2 ** attempt, 8000));
  }
  throw new SafetyError(
    "Authenticated state did not converge within propagation budget; use status and rollback",
  );
}
async function setRoute(
  client: CloudflareClient,
  route: Route,
  script: Route["script"],
  clock: Clock,
): Promise<void> {
  if (route.script === script) return;
  try {
    await client.replaceRoute(route, script);
  } catch {
    // PUT may have succeeded. The bounded authenticated poll below decides.
  }
  await waitLive(client, clock, (live) =>
    same(
      route.pattern === "production" ? live.productionRoute : live.canaryRoute,
      { ...route, script },
    ),
  );
}
async function cleanup(
  client: CloudflareClient,
  j: Journal,
  clock: Clock,
): Promise<void> {
  const live = await readLiveState(client);
  const previous = j.baseline.canaryRoute;
  if (previous) {
    ensure(
      live.canaryRoute?.id === previous.id,
      "Pre-existing canary route identity changed; refusing cleanup",
    );
    await setRoute(client, live.canaryRoute, previous.script, clock);
  } else if (live.canaryRoute) {
    ensure(
      j.ownedCanaryId !== null &&
        live.canaryRoute.id === j.ownedCanaryId &&
        live.canaryRoute.script === "candidate",
      "Canary ownership is unproven; preserve route and investigate",
    );
    try {
      await client.deleteCanary(live.canaryRoute);
    } catch {
      // DELETE may have succeeded; confirm absence below before claiming cleanup.
    }
  }
  await waitLive(client, clock, (state) => same(state.canaryRoute, previous));
}
async function restore(
  client: CloudflareClient,
  config: RuntimeConfig,
  store: JournalStore,
  clock: Clock,
  fetcher: typeof fetch,
): Promise<LiveState> {
  let j = await store.read();
  ensure(j, "No recovery journal is available");
  assertJournal(j, config);
  const live = await readLiveState(client);
  stableUnchanged(j, live);
  const previous = j.baseline.productionRoute;
  ensure(previous && live.productionRoute, "Missing production recovery route");
  const candidateBefore =
    same(live.candidateDeployment, j.baseline.candidateDeployment) ||
    (j.restoredCandidateDeploymentId === live.candidateDeployment.id &&
      same(
        live.candidateDeployment.versions,
        j.baseline.candidateDeployment.versions,
      ));
  ensure(
    candidateBefore ||
      candidateIsOurs(j, live) ||
      (j.phase === "rollback-intent" &&
        same(
          live.candidateDeployment.versions,
          j.baseline.candidateDeployment.versions,
        )),
    "Candidate deployment drifted; refusing stale recovery data",
  );
  ensure(
    same(live.candidateSettings, j.baseline.candidateSettings),
    "Candidate settings drifted; refusing stale recovery data",
  );
  if (j.phase === "rolled-back")
    ensure(
      same(live.productionRoute, previous) && candidateBefore,
      "Previously rolled-back journal is stale",
    );
  if (live.productionRoute.script === "candidate")
    ensure(
      j.candidateVersionId &&
        [
          "cutover-intent",
          "production-verified",
          "cleanup-intent",
          "complete",
          "rollback-intent",
        ].includes(j.phase),
      "Production cutover has no matching recovery intent",
    );
  else
    ensure(same(live.productionRoute, previous), "Production target drifted");
  j = await save(store, j, clock, "rollback-intent");
  // Restore traffic first. Stable code and its original deployment were never overwritten.
  await setRoute(client, live.productionRoute, previous.script, clock);
  await validateEndpoint(
    config.productionHostname,
    j.baseline.stableSettings.identity,
    clock,
    fetcher,
  );
  if (
    !candidateBefore &&
    !same(
      live.candidateDeployment.versions,
      j.baseline.candidateDeployment.versions,
    )
  ) {
    const beforeRestore = await readLiveState(client);
    stableUnchanged(j, beforeRestore);
    ensure(
      same(beforeRestore.productionRoute, previous) &&
        candidateIsOurs(j, beforeRestore),
      "State drifted before candidate restoration",
    );
    try {
      await client.deployCandidate(j.baseline.candidateDeployment.versions);
    } catch {
      /* Reconcile an ambiguous deployment response below. */
    }
  }
  const baselineVersions = j.baseline.candidateDeployment.versions;
  const candidateRestored = await waitLive(client, clock, (state) =>
    same(state.candidateDeployment.versions, baselineVersions),
  );
  j = await save(store, j, clock, "rollback-intent", {
    restoredCandidateDeploymentId: candidateRestored.candidateDeployment.id,
  });
  await cleanup(client, j, clock);
  const final = await readLiveState(client);
  stableUnchanged(j, final);
  ensure(
    same(final.productionRoute, previous) &&
      same(final.canaryRoute, j.baseline.canaryRoute) &&
      same(
        final.candidateDeployment.versions,
        j.baseline.candidateDeployment.versions,
      ) &&
      same(final.candidateSettings, j.baseline.candidateSettings),
    "Rollback verification failed; preserve journal and retry rollback",
  );
  await validateEndpoint(
    config.productionHostname,
    j.baseline.stableSettings.identity,
    clock,
    fetcher,
  );
  await save(store, j, clock, "rolled-back");
  return final;
}
export async function rollback(
  client: CloudflareClient,
  config: RuntimeConfig,
  store: JournalStore,
  clock: Clock = systemClock,
  fetcher: typeof fetch = fetch,
): Promise<LiveState> {
  return store.withLock(scope(config), () =>
    restore(client, config, store, clock, fetcher),
  );
}
export async function verifyCompleted(
  client: CloudflareClient,
  config: RuntimeConfig,
  j: Journal,
  clock: Clock,
  fetcher: typeof fetch,
): Promise<LiveState> {
  assertJournal(j, config);
  function check(live: LiveState): void {
    stableUnchanged(j, live);
    ensure(
      j.phase === "complete" &&
        live.productionRoute?.script === "candidate" &&
        live.candidateDeployment.id === j.candidateDeploymentId &&
        candidateIsOurs(j, live) &&
        same(live.candidateSettings, j.baseline.candidateSettings) &&
        same(live.canaryRoute, j.baseline.canaryRoute),
      "Completed rollout has drifted; inspect status before rollback",
    );
  }
  const live = await readLiveState(client);
  check(live);
  await validateEndpoint(
    config.productionHostname,
    live.candidateSettings.identity,
    clock,
    fetcher,
  );
  const final = await readLiveState(client);
  check(final);
  return final;
}
export async function applyRollout(
  client: CloudflareClient,
  config: RuntimeConfig,
  store: JournalStore,
  clock: Clock,
  logger: Logger,
  options: ApplyOptions,
): Promise<Evidence> {
  return store.withLock(scope(config), async () => {
    assertClean(options.bundle, config);
    const fetcher = options.fetcher ?? fetch;
    const bundleHash = hash(options.bundle);
    let j = await store.read();
    if (j) {
      assertJournal(j, config);
      ensure(
        j.bundleHash === bundleHash,
        "Bundle differs from recovery journal; finish rollback before starting a separately archived rollout",
      );
      if (j.phase === "complete") {
        try {
          const final = await verifyCompleted(
            client,
            config,
            j,
            clock,
            fetcher,
          );
          return evidence(j, final);
        } catch {
          try {
            await restore(client, config, store, clock, fetcher);
          } catch {
            throw new SafetyError(
              "Completed rollout verification failed and recovery could not be verified; inspect live status and preserved journal for drift",
            );
          }
          throw new SafetyError(
            "Completed rollout verification failed; baseline restored and verified",
          );
        }
      }
      await restore(client, config, store, clock, fetcher);
      j = await store.read();
    }
    const plan = await createPlan(client, config, clock);
    ensure(
      plan.blocked.length === 0 &&
        plan.baseline.productionRoute?.script === "stable",
      "Live preconditions block rollout; run plan",
    );
    await validateEndpoint(
      config.productionHostname,
      plan.baseline.stableSettings.identity,
      clock,
      fetcher,
    );
    const prior = j;
    j = {
      schemaVersion: 2,
      scope: scope(config),
      runId: prior?.runId ?? randomUUID(),
      startedAt: prior?.startedAt ?? clock.now().toISOString(),
      bundleHash,
      baseline: prior?.baseline ?? plan.baseline,
      phase: "prepared",
      candidateVersionId: prior?.candidateVersionId ?? null,
      candidateDeploymentId: null,
      restoredCandidateDeploymentId:
        prior?.restoredCandidateDeploymentId ?? null,
      ownedCanaryId: null,
      transitions: prior?.transitions ?? [],
    };
    j = await save(store, j, clock, "prepared");
    try {
      if (!j.candidateVersionId) {
        j = await save(store, j, clock, "uploading");
        const version = await client.uploadCandidate(
          options.bundle,
          required(j.baseline.candidateDeployment.versions[0]).version_id,
        );
        j = await save(store, j, clock, "uploaded", {
          candidateVersionId: version.id,
        });
      }
      const beforeDeploy = await readLiveState(client);
      stableUnchanged(j, beforeDeploy);
      ensure(
        beforeDeploy.productionRoute?.script === "stable" &&
          same(beforeDeploy.candidateSettings, j.baseline.candidateSettings) &&
          same(
            beforeDeploy.candidateDeployment.versions,
            j.baseline.candidateDeployment.versions,
          ),
        "Live state changed before candidate activation",
      );
      j = await save(store, j, clock, "deploying");
      try {
        await client.deployCandidate([
          { version_id: required(j.candidateVersionId), percentage: 100 },
        ]);
      } catch {
        /* Reconcile partial success by reading the active deployment. */
      }
      const activated = await waitLive(client, clock, (live) =>
        candidateIsOurs(required(j), live),
      );
      ensure(
        same(activated.candidateSettings, j.baseline.candidateSettings),
        "Candidate upload changed bindings or settings",
      );
      j = await save(store, j, clock, "deployed", {
        candidateDeploymentId: activated.candidateDeployment.id,
      });
      j = await save(store, j, clock, "canary-intent");
      if (j.baseline.canaryRoute)
        await setRoute(client, j.baseline.canaryRoute, "candidate", clock);
      else {
        const route = await client.createCanary();
        j = await save(store, j, clock, "canary-ready", {
          ownedCanaryId: route.id,
        });
      }
      await waitLive(
        client,
        clock,
        (live) => live.canaryRoute?.script === "candidate",
      );
      await validateEndpoint(
        config.canaryHostname,
        j.baseline.candidateSettings.identity,
        clock,
        fetcher,
      );
      j = await save(store, j, clock, "validated");
      const ready = await readLiveState(client);
      stableUnchanged(j, ready);
      ensure(
        same(ready.productionRoute, j.baseline.productionRoute) &&
          candidateIsOurs(j, ready) &&
          ready.candidateDeployment.id === j.candidateDeploymentId &&
          same(ready.candidateSettings, j.baseline.candidateSettings) &&
          ready.canaryRoute?.id ===
            (j.baseline.canaryRoute?.id ?? j.ownedCanaryId) &&
          ready.canaryRoute.script === "candidate",
        "Pre-cutover state drifted",
      );
      j = await save(store, j, clock, "cutover-intent");
      await setRoute(
        client,
        required(ready.productionRoute),
        "candidate",
        clock,
      );
      await validateEndpoint(
        config.productionHostname,
        j.baseline.candidateSettings.identity,
        clock,
        fetcher,
      );
      j = await save(store, j, clock, "production-verified");
      j = await save(store, j, clock, "cleanup-intent");
      await cleanup(client, j, clock);
      // Verify first; persist completion only after both data and control planes agree.
      const complete = { ...j, phase: "complete" as const };
      const final = await verifyCompleted(
        client,
        config,
        complete,
        clock,
        fetcher,
      );
      j = await save(store, j, clock, "complete");
      const result = evidence(j, final);
      await mkdir(dirname(options.evidencePath), { recursive: true });
      const serialized = `${JSON.stringify(result, null, 2)}\n`;
      assertClean(serialized, config);
      await writeFile(options.evidencePath, serialized, { mode: 0o600 });
      logger.info("Rollout verified", { runId: j.runId });
      return result;
    } catch (error) {
      logger.error("Rollout failed; restoring captured baseline");
      try {
        await restore(client, config, store, clock, fetcher);
      } catch {
        throw new SafetyError(
          "Rollout failed and full recovery could not be verified. Preserve journal; run status then rollback. Unproven canary ownership requires operator investigation",
        );
      }
      throw new SafetyError(
        `Rollout failed; captured baseline restored and verified. ${error instanceof SafetyError ? error.message : "Inspect local artifact storage and retry"}`,
      );
    }
    function evidence(journal: Journal, final: LiveState): Evidence {
      return {
        schemaVersion: 2,
        journal,
        verifiedAt: clock.now().toISOString(),
        final,
        validation: "passed",
        checks: [
          "healthz",
          "version",
          "api-config",
          "release-identity",
          "json-and-no-store-headers",
          "404",
          "405",
          "authenticated-route-and-deployment-state",
          "stable-preserved",
          "canary-baseline-restored",
        ],
        routeTransitions: journal.transitions
          .filter(
            (t) =>
              t.phase === "production-verified" || t.phase === "rolled-back",
          )
          .map((t) => ({
            at: t.at,
            routeId: required(journal.baseline.productionRoute).id,
            target: t.phase === "rolled-back" ? "stable" : "candidate",
          })),
        cleanup: journal.baseline.canaryRoute
          ? "pre-existing-route-preserved"
          : "owned-route-removed",
      };
    }
  });
}
