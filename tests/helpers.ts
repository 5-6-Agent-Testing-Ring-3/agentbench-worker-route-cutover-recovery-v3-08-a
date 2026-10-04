import { vi } from "vitest";
import type { CloudflareClient } from "../src/cloudflare-client.js";
import { hash, scope } from "../src/safety.js";
import type {
  Clock,
  Journal,
  LiveState,
  Logger,
  Route,
  RuntimeConfig,
  WorkerDeployment,
  WorkerSettings,
} from "../src/types.js";
import worker from "../src/worker.js";

export const config: RuntimeConfig = {
  token: "fictional-test-token",
  accountId: "fictional-account-id",
  zoneId: "fictional-zone-id",
  stableWorker: "fixture-worker-stable",
  candidateWorker: "fixture-worker-candidate",
  productionHostname: "fixture-prod.example.test",
  canaryHostname: "fixture-canary.example.test",
};
export const productionRoute: Route = {
  id: "route-production",
  pattern: "production",
  script: "stable",
};
export const canaryRoute: Route = {
  id: "route-canary",
  pattern: "canary",
  script: "stable",
};
export const deployment: WorkerDeployment = {
  id: "deployment-v1",
  createdOn: "2026-10-04T00:00:00.000Z",
  versions: [{ version_id: "version-stable", percentage: 100 }],
};
export const candidateDeployment: WorkerDeployment = {
  ...deployment,
  id: "candidate-baseline",
  versions: [{ version_id: "version-old-candidate", percentage: 100 }],
};
export const clock: Clock = {
  now: () => new Date("2026-10-04T00:00:00.000Z"),
  sleep: vi.fn(async () => undefined),
};
export const logger: Logger = { info: vi.fn(), error: vi.fn() };
export function settings(role: "stable" | "candidate"): WorkerSettings {
  return {
    fingerprint: hash(role),
    identity: {
      versionHash: hash(role === "stable" ? "v1" : "v2"),
      workerHash: hash(role),
    },
    bindingTypes: ["plain_text", "plain_text"],
    compatibilityDate: "2025-08-23",
  };
}
export function baseline(canary = true): LiveState {
  return {
    productionRoute,
    canaryRoute: canary ? canaryRoute : null,
    stableDeployment: deployment,
    candidateDeployment,
    stableSettings: settings("stable"),
    candidateSettings: settings("candidate"),
  };
}
export function recovery(state = baseline()): Journal {
  return {
    schemaVersion: 2,
    scope: scope(config),
    runId: "run-fixture",
    startedAt: clock.now().toISOString(),
    bundleHash: hash("export default {};"),
    baseline: state,
    phase: "prepared",
    candidateVersionId: null,
    candidateDeploymentId: null,
    restoredCandidateDeploymentId: null,
    ownedCanaryId: null,
    transitions: [{ phase: "prepared", at: clock.now().toISOString() }],
  };
}
export function apiResponse(
  result: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ success: status < 400, result }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
// Stateful remote emulator. Every mutation changes the next authenticated read.
export function remote(canary = true) {
  const state = structuredClone(baseline(canary));
  let live: LiveState = state;
  let serial = 0;
  const events: string[] = [];
  const api = {
    listRoutes: vi.fn(async () =>
      [live.productionRoute, live.canaryRoute].filter(
        (r): r is Route => r !== null,
      ),
    ),
    listDeployments: vi.fn(async (role: "stable" | "candidate") => [
      role === "stable" ? live.stableDeployment : live.candidateDeployment,
    ]),
    settings: vi.fn(async (role: "stable" | "candidate") =>
      role === "stable" ? live.stableSettings : live.candidateSettings,
    ),
    uploadCandidate: vi.fn(async () => {
      events.push("upload");
      return { id: "version-new-candidate" };
    }),
    deployCandidate: vi.fn(async (versions: WorkerDeployment["versions"]) => {
      events.push("deploy");
      const deployed = {
        id: `deployed-${String(++serial)}`,
        createdOn: clock.now().toISOString(),
        versions,
      };
      live = { ...live, candidateDeployment: deployed };
      return deployed;
    }),
    replaceRoute: vi.fn(async (route: Route, script: Route["script"]) => {
      events.push(`route:${route.pattern}:${String(script)}`);
      live = {
        ...live,
        [route.pattern === "production" ? "productionRoute" : "canaryRoute"]: {
          ...route,
          script,
        },
      };
    }),
    createCanary: vi.fn(async () => {
      events.push("create-canary");
      const route: Route = {
        id: "owned-canary",
        pattern: "canary",
        script: "candidate",
      };
      live = { ...live, canaryRoute: route };
      return route;
    }),
    deleteCanary: vi.fn(async () => {
      events.push("delete-canary");
      live = { ...live, canaryRoute: null };
    }),
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const role =
      url.hostname === config.productionHostname
        ? live.productionRoute?.script
        : live.canaryRoute?.script;
    events.push(
      `probe:${url.hostname === config.productionHostname ? "production" : "canary"}:${url.pathname}`,
    );
    return worker.fetch(new Request(url, init), {
      WORKER_ROLE: role ?? "absent",
      RELEASE_VERSION: role === "stable" ? "v1" : "v2",
    });
  });
  return {
    client: api as unknown as CloudflareClient,
    api,
    fetcher,
    events,
    get live() {
      return live;
    },
    set live(value: LiveState) {
      live = value;
    },
  };
}
