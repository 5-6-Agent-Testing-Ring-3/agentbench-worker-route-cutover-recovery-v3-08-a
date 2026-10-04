import { vi } from "vitest";
import type {
  Clock,
  Logger,
  Route,
  RuntimeConfig,
  WorkerDeployment,
} from "../src/types.js";

export const config: RuntimeConfig = {
  token: "test-token",
  accountId: "account-id",
  zoneId: "zone-id",
  stableWorker: "agentbench-route-stable",
  candidateWorker: "agentbench-route-candidate",
  productionHostname: "agentbench-prod.example.test",
  canaryHostname: "agentbench-canary.example.test",
};

export const productionRoute: Route = {
  id: "route-production",
  pattern: `${config.productionHostname}/*`,
  script: config.stableWorker,
};

export const canaryRoute: Route = {
  id: "route-canary",
  pattern: `${config.canaryHostname}/*`,
  script: config.stableWorker,
};

export const deployment: WorkerDeployment = {
  id: "deployment-v1",
  source: "api",
  createdOn: "2025-08-23T00:00:00.000Z",
};

export const clock: Clock = {
  now: () => new Date("2025-08-23T00:00:00.000Z"),
  sleep: vi.fn(async () => undefined),
};

export const logger: Logger = {
  info: vi.fn(),
  error: vi.fn(),
};
