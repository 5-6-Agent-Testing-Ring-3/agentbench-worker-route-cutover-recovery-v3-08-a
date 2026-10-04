#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CloudflareClient } from "./cloudflare-client.js";
import { loadConfig } from "./config.js";
import { JournalStore } from "./journal.js";
import { createPlan } from "./planner.js";
import { redact } from "./redact.js";
import { applyRollout, rollback, verifyCompleted } from "./rollout.js";
import { status } from "./status.js";
import { assertClean, ensure, SafetyError, systemClock } from "./safety.js";
import type { RuntimeConfig } from "./types.js";

let config: RuntimeConfig | undefined;
const nodeProcess = (
  globalThis as unknown as {
    process: { argv: string[]; exitCode: number | undefined; pid: number };
  }
).process;

async function scan(directory: string, runtime: RuntimeConfig): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path, runtime);
    else assertClean(await readFile(path, "utf8"), runtime);
  }
}
async function main(): Promise<void> {
  const [command, bundlePath = "dist/worker.js"] = nodeProcess.argv.slice(2);
  config = await loadConfig();
  const client = new CloudflareClient(config, systemClock);
  const journal = new JournalStore(".rollout/journal.json");
  let result: unknown;
  switch (command) {
    case "plan": {
      const plan = await createPlan(
        client,
        config,
        systemClock,
        journal,
        await readFile(bundlePath, "utf8"),
      );
      result = plan;
      if (plan.blocked.length > 0) nodeProcess.exitCode = 2;
      break;
    }
    case "apply":
      await scan("dist", config);
      await scan("artifacts", config);
      result = await applyRollout(
        client,
        config,
        journal,
        systemClock,
        { info: () => undefined, error: () => undefined },
        {
          bundle: await readFile(bundlePath, "utf8"),
          evidencePath: "artifacts/rollout-evidence.json",
        },
      );
      break;
    case "status":
      result = await status(client, config, journal);
      break;
    case "verify": {
      const recovery = await journal.read();
      ensure(recovery, "Verification requires a completed recovery journal");
      result = {
        schemaVersion: 2,
        verified: true,
        live: await verifyCompleted(
          client,
          config,
          recovery,
          systemClock,
          fetch,
        ),
      };
      break;
    }
    case "rollback":
      result = {
        schemaVersion: 2,
        restored: true,
        verifiedAt: systemClock.now().toISOString(),
        live: await rollback(client, config, journal),
      };
      break;
    default:
      throw new SafetyError(
        "Usage: rollout <plan|apply [bundle-path]|status|verify|rollback>",
      );
  }
  console.log(JSON.stringify(redact(result, config), null, 2));
}
main().catch((error: unknown) => {
  const message =
    error instanceof SafetyError
      ? error.message
      : "Command failed; check credential file availability, file permissions and local artifact paths. Raw error suppressed";
  console.error(
    JSON.stringify(redact({ schemaVersion: 2, error: message }, config)),
  );
  nodeProcess.exitCode = 2;
});
