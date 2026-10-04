#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { CloudflareClient } from "./cloudflare-client.js";
import { loadConfig } from "./config.js";
import { JournalStore } from "./journal.js";
import { createPlan } from "./planner.js";
import { redact } from "./redact.js";
import { applyRollout, rollback } from "./rollout.js";
import { status } from "./status.js";
import type { Clock, Logger } from "./types.js";

const nodeProcess = (
  globalThis as unknown as {
    process: { argv: string[]; exitCode: number | undefined };
  }
).process;

const clock: Clock = {
  now: () => new Date(),
  sleep: async (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};
const logger: Logger = {
  info: (message, details) =>
    console.log(message, JSON.stringify(redact(details))),
  error: (message, details) => console.error(message, JSON.stringify(details)),
};

async function main(): Promise<void> {
  const [command, ...args] = nodeProcess.argv.slice(2);
  const config = await loadConfig();
  const client = new CloudflareClient(config, clock);
  const journal = new JournalStore(".rollout/journal.json");
  switch (command) {
    case "plan":
      console.log(
        `${JSON.stringify(redact(await createPlan(client, config, clock)), null, 2)}\n`,
      );
      break;
    case "apply": {
      const bundlePath = args[0];
      if (!bundlePath) throw new Error("Usage: apply <bundle-path>");
      await applyRollout(client, config, journal, clock, logger, {
        bundle: await readFile(bundlePath, "utf8"),
        evidencePath: "artifacts/rollout-evidence.json",
      });
      break;
    }
    case "status":
    case "verify":
      console.log(
        `${JSON.stringify(redact(await status(client, config, journal)), null, 2)}\n`,
      );
      break;
    case "rollback":
      console.log(
        `${JSON.stringify(await rollback(client, config, journal), null, 2)}\n`,
      );
      break;
    default:
      throw new Error("Usage: rollout <plan|apply|status|verify|rollback>");
  }
}

main().catch((error: unknown) => {
  logger.error("Rollout command failed", error);
  nodeProcess.exitCode = 2;
});
