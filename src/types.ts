export interface RuntimeConfig {
  readonly token: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly stableWorker: string;
  readonly candidateWorker: string;
  readonly productionHostname: string;
  readonly canaryHostname: string;
}

export interface Route {
  readonly id: string;
  readonly pattern: string;
  readonly script: string | null;
}

export interface WorkerDeployment {
  readonly id: string;
  readonly source: string;
  readonly createdOn: string;
}

export interface LiveState {
  readonly productionRoute: Route | null;
  readonly canaryRoute: Route | null;
  readonly stableDeployments: readonly WorkerDeployment[];
  readonly candidateDeployments: readonly WorkerDeployment[];
}

export type PlanAction =
  | { readonly kind: "deploy-candidate"; readonly worker: string }
  | {
      readonly kind: "set-canary";
      readonly pattern: string;
      readonly worker: string;
    }
  | {
      readonly kind: "set-production";
      readonly pattern: string;
      readonly worker: string;
    }
  | { readonly kind: "remove-canary"; readonly routeId: string };

export interface RolloutPlan {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly baseline: LiveState;
  readonly actions: readonly PlanAction[];
}

export interface Journal {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly previousProduction: Route | null;
  readonly candidateDeploymentId: string | null;
  readonly productionChanged: boolean;
  readonly completed: boolean;
}

export interface Evidence {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly candidateDeploymentId: string;
  readonly healthPassed: boolean;
  readonly productionRoute: Route;
  readonly canaryRemoved: boolean;
}

export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}

export interface Logger {
  info(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}
