import type { CloudflareClient } from "./cloudflare-client.js";
import type { JournalStore } from "./journal.js";
import { ensure, hash, same, scope } from "./safety.js";
import type { Clock, LiveState, RolloutPlan, RuntimeConfig } from "./types.js";

export async function readLiveState(
  client: CloudflareClient,
): Promise<LiveState> {
  const [routes, stable, candidate, stableSettings, candidateSettings] =
    await Promise.all([
      client.listRoutes(),
      client.listDeployments("stable"),
      client.listDeployments("candidate"),
      client.settings("stable"),
      client.settings("candidate"),
    ]);
  const stableDeployment = stable[0];
  const candidateDeployment = candidate[0];
  ensure(
    stableDeployment && candidateDeployment,
    "Both configured Workers need existing recoverable deployments",
  );
  return {
    productionRoute: routes.find((r) => r.pattern === "production") ?? null,
    canaryRoute: routes.find((r) => r.pattern === "canary") ?? null,
    stableDeployment,
    candidateDeployment,
    stableSettings,
    candidateSettings,
  };
}
export async function createPlan(
  client: CloudflareClient,
  config: RuntimeConfig,
  _clock: Clock,
  store?: JournalStore,
  bundle?: string,
): Promise<RolloutPlan> {
  const baseline = await readLiveState(client);
  const journal = (await store?.read()) ?? null;
  const blocked: string[] = [];
  if (baseline.productionRoute?.script == null)
    blocked.push(
      "An existing production route with a recoverable Worker is required",
    );
  if (journal && journal.scope !== scope(config))
    blocked.push("Recovery journal belongs to a different resource scope");
  if (baseline.productionRoute?.script === "candidate" && !journal)
    blocked.push(
      "Candidate already serves production without a recovery journal; no upload is safe",
    );
  if (baseline.candidateDeployment.versions.length !== 1)
    blocked.push(
      "Candidate baseline must use a single version to inherit bindings unambiguously",
    );
  if (
    journal &&
    (!same(journal.baseline.stableDeployment, baseline.stableDeployment) ||
      !same(journal.baseline.stableSettings, baseline.stableSettings) ||
      journal.baseline.productionRoute?.id !== baseline.productionRoute?.id)
  )
    blocked.push("Recovery baseline drifted; do not apply stale recovery data");
  if (journal && bundle !== undefined && journal.bundleHash !== hash(bundle))
    blocked.push("Bundle differs from recovery journal");
  if (
    same(baseline.stableSettings.identity, baseline.candidateSettings.identity)
  )
    blocked.push(
      "Stable and candidate public identities must be distinguishable",
    );
  const cleanupBaseline = journal
    ? journal.baseline.canaryRoute
    : baseline.canaryRoute;
  const actions =
    journal?.phase === "complete"
      ? [
          "verify-live-route-deployments-settings-and-production-contract",
          "no-op-if-bundle-and-live-state-match",
        ]
      : [
          ...(journal
            ? [
                "validate-journal-and-reconcile-live-state",
                "restore-and-verify-baseline-before-resuming",
              ]
            : []),
          "capture-production-route-and-both-active-deployments-and-settings",
          "validate-baseline-production-contract",
          "scan-bundle-for-credential-material",
          "upload-version-to-candidate-only-with-inherited-bindings",
          "activate-candidate-version-and-confirm-deployment",
          cleanupBaseline
            ? "temporarily-point-existing-canary-to-candidate"
            : "create-canary-and-record-returned-ownership-id",
          "validate-canary-health-version-config-404-405-and-identity",
          "recheck-live-preconditions",
          "replace-existing-production-route-in-place-with-candidate",
          "verify-production-contract-and-authenticated-state",
          cleanupBaseline
            ? "restore-pre-existing-canary-route"
            : "delete-only-recorded-owned-canary-route",
          "verify-final-production-and-route-deployment-state",
        ];
  return {
    schemaVersion: 2,
    scope: scope(config),
    baseline,
    journalPhase: journal?.phase ?? null,
    bundleHash: bundle === undefined ? null : hash(bundle),
    blocked,
    actions,
    intended: {
      productionRoute: baseline.productionRoute
        ? { ...baseline.productionRoute, script: "candidate" }
        : null,
      canaryRoute: journal
        ? journal.baseline.canaryRoute
        : baseline.canaryRoute,
      deploymentTarget: "candidate",
      stableDeployment: "preserve",
      bindings: "inherit-from-captured-candidate-version",
    },
  };
}
