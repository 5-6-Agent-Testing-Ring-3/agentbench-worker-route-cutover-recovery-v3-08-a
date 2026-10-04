import type { JournalStore } from "./journal.js";
import type { CloudflareClient } from "./cloudflare-client.js";
import type { RuntimeConfig } from "./types.js";

export async function status(
  client: CloudflareClient,
  config: RuntimeConfig,
  journalStore: JournalStore,
) {
  const journal = await journalStore.read();
  const routes = await client.listRoutes();
  return {
    journal,
    productionRoute:
      routes.find(
        (route) => route.pattern === `${config.productionHostname}/*`,
      ) ??
      journal?.previousProduction ??
      null,
    canaryRoute:
      routes.find((route) => route.pattern === `${config.canaryHostname}/*`) ??
      null,
  };
}
