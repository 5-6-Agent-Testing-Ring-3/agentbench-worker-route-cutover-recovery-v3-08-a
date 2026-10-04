import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CloudflareClient } from "./cloudflare-client.js";
import type { JournalStore } from "./journal.js";
import { createPlan } from "./planner.js";
import type {
  Clock,
  Evidence,
  Journal,
  Logger,
  Route,
  RuntimeConfig,
} from "./types.js";

async function probe(
  hostname: string,
  fetcher: typeof fetch,
): Promise<boolean> {
  const response = await fetcher(`https://${hostname}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return false;
  const body: { status?: string } = await response.json();
  return body.status === "ok";
}

function newJournal(
  runId: string,
  clock: Clock,
  production: Route | null,
): Journal {
  return {
    schemaVersion: 1,
    runId,
    startedAt: clock.now().toISOString(),
    previousProduction: production,
    candidateDeploymentId: null,
    productionChanged: false,
    completed: false,
  };
}

export interface ApplyOptions {
  readonly bundle: string;
  readonly evidencePath: string;
  readonly fetcher?: typeof fetch;
}

export async function applyRollout(
  client: CloudflareClient,
  config: RuntimeConfig,
  journalStore: JournalStore,
  clock: Clock,
  logger: Logger,
  options: ApplyOptions,
): Promise<Evidence> {
  const fetcher = options.fetcher ?? fetch;
  const plan = await createPlan(client, config, clock);
  const runId = `rollout-${String(clock.now().getTime())}`;
  let journal = newJournal(runId, clock, plan.baseline.productionRoute);

  const deployment = await client.uploadCandidate(options.bundle);
  journal = { ...journal, candidateDeploymentId: deployment.id };

  const productionPattern = `${config.productionHostname}/*`;
  const productionRoute = plan.baseline.productionRoute
    ? await client.replaceRoute(
        plan.baseline.productionRoute.id,
        productionPattern,
        config.candidateWorker,
      )
    : await client.createRoute(productionPattern, config.candidateWorker);
  journal = { ...journal, productionChanged: true };

  const canaryPattern = `${config.canaryHostname}/*`;
  if (plan.baseline.canaryRoute) {
    await client.replaceRoute(
      plan.baseline.canaryRoute.id,
      canaryPattern,
      config.candidateWorker,
    );
  } else {
    await client.createRoute(canaryPattern, config.candidateWorker);
  }

  const healthPassed = await probe(config.canaryHostname, fetcher);
  if (!healthPassed)
    logger.error("Candidate validation failed", { runId, config });

  if (plan.baseline.canaryRoute)
    await client.deleteRoute(plan.baseline.canaryRoute.id);

  journal = { ...journal, completed: true };
  await journalStore.write(journal);

  const evidence: Evidence = {
    schemaVersion: 1,
    runId,
    startedAt: journal.startedAt,
    finishedAt: clock.now().toISOString(),
    candidateDeploymentId: deployment.id,
    healthPassed,
    productionRoute,
    canaryRemoved: plan.baseline.canaryRoute !== null,
  };
  await mkdir(dirname(options.evidencePath), { recursive: true });
  await writeFile(
    options.evidencePath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  logger.info("Rollout finished", evidence);
  return evidence;
}

export async function rollback(
  client: CloudflareClient,
  config: RuntimeConfig,
  journalStore: JournalStore,
): Promise<Route> {
  const journal = await journalStore.read();
  if (!journal?.previousProduction)
    throw new Error("No previous production route is available");
  return client.replaceRoute(
    journal.previousProduction.id,
    `${config.productionHostname}/*`,
    journal.previousProduction.script ?? config.stableWorker,
  );
}
