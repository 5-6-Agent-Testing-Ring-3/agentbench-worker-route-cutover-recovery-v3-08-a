import type { CloudflareClient } from "./cloudflare-client.js";
import type { Clock, LiveState, RolloutPlan, RuntimeConfig } from "./types.js";

function routeFor(
  routes: Awaited<ReturnType<CloudflareClient["listRoutes"]>>,
  hostname: string,
) {
  const pattern = `${hostname}/*`;
  return routes.find((route) => route.pattern === pattern) ?? null;
}

export async function readLiveState(
  client: CloudflareClient,
  config: RuntimeConfig,
): Promise<LiveState> {
  const [routes, stableDeployments, candidateDeployments] = await Promise.all([
    client.listRoutes(),
    client.listDeployments(config.stableWorker),
    client.listDeployments(config.candidateWorker),
  ]);
  return {
    productionRoute: routeFor(routes, config.productionHostname),
    canaryRoute: routeFor(routes, config.canaryHostname),
    stableDeployments,
    candidateDeployments,
  };
}

export async function createPlan(
  client: CloudflareClient,
  config: RuntimeConfig,
  clock: Clock,
): Promise<RolloutPlan> {
  const baseline = await readLiveState(client, config);
  const actions: RolloutPlan["actions"] = [
    { kind: "deploy-candidate", worker: config.candidateWorker },
    {
      kind: "set-canary",
      pattern: `${config.canaryHostname}/*`,
      worker: config.candidateWorker,
    },
    {
      kind: "set-production",
      pattern: `${config.productionHostname}/*`,
      worker: config.candidateWorker,
    },
    ...(baseline.canaryRoute
      ? [{ kind: "remove-canary" as const, routeId: baseline.canaryRoute.id }]
      : []),
  ];
  return {
    schemaVersion: 1,
    generatedAt: clock.now().toISOString(),
    baseline,
    actions,
  };
}
