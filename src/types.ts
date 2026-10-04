export interface RuntimeConfig {
  readonly token: string;
  readonly accountId: string;
  readonly zoneId: string;
  readonly stableWorker: string;
  readonly candidateWorker: string;
  readonly productionHostname: string;
  readonly canaryHostname: string;
}
export type WorkerRole = "stable" | "candidate";
export type RouteRole = "production" | "canary";
// Resource names and hostnames never leave the runtime client.
export interface Route {
  readonly id: string;
  readonly pattern: RouteRole;
  readonly script: WorkerRole | null;
}
export interface VersionShare {
  readonly version_id: string;
  readonly percentage: number;
}
export interface WorkerDeployment {
  readonly id: string;
  readonly createdOn: string;
  readonly versions: readonly VersionShare[];
}
export interface Identity {
  readonly versionHash: string;
  readonly workerHash: string;
}
export interface WorkerSettings {
  readonly fingerprint: string;
  readonly identity: Identity;
  readonly bindingTypes: readonly string[];
  readonly compatibilityDate: string;
}
export interface LiveState {
  readonly productionRoute: Route | null;
  readonly canaryRoute: Route | null;
  readonly stableDeployment: WorkerDeployment;
  readonly candidateDeployment: WorkerDeployment;
  readonly stableSettings: WorkerSettings;
  readonly candidateSettings: WorkerSettings;
}
export interface RolloutPlan {
  readonly schemaVersion: 2;
  readonly scope: string;
  readonly baseline: LiveState;
  readonly journalPhase: Phase | null;
  readonly bundleHash: string | null;
  readonly blocked: readonly string[];
  readonly actions: readonly string[];
  readonly intended: {
    readonly productionRoute: Route | null;
    readonly canaryRoute: Route | null;
    readonly deploymentTarget: "candidate";
    readonly stableDeployment: "preserve";
    readonly bindings: "inherit-from-captured-candidate-version";
  };
}
export type Phase =
  | "prepared"
  | "uploading"
  | "uploaded"
  | "deploying"
  | "deployed"
  | "canary-intent"
  | "canary-ready"
  | "validated"
  | "cutover-intent"
  | "production-verified"
  | "cleanup-intent"
  | "complete"
  | "rollback-intent"
  | "rolled-back";
export interface Transition {
  readonly at: string;
  readonly phase: Phase;
}
export interface Journal {
  readonly schemaVersion: 2;
  readonly scope: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly bundleHash: string;
  readonly baseline: LiveState;
  readonly phase: Phase;
  readonly candidateVersionId: string | null;
  readonly candidateDeploymentId: string | null;
  readonly restoredCandidateDeploymentId: string | null;
  readonly ownedCanaryId: string | null;
  readonly transitions: readonly Transition[];
}
export interface Evidence {
  readonly schemaVersion: 2;
  readonly journal: Journal;
  readonly verifiedAt: string;
  readonly final: LiveState;
  readonly validation: "passed";
  readonly checks: readonly string[];
  readonly routeTransitions: readonly {
    readonly at: string;
    readonly routeId: string;
    readonly target: WorkerRole;
  }[];
  readonly cleanup: "owned-route-removed" | "pre-existing-route-preserved";
}
export interface Clock {
  now(): Date;
  sleep(milliseconds: number): Promise<void>;
}
export interface Logger {
  info(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}
