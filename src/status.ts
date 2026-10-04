import type { JournalStore } from "./journal.js";
import type { CloudflareClient } from "./cloudflare-client.js";
import { readLiveState } from "./planner.js";
import { scope } from "./safety.js";
import type { RuntimeConfig } from "./types.js";
export async function status(
  client: CloudflareClient,
  config: RuntimeConfig,
  store: JournalStore,
) {
  const live = await readLiveState(client);
  const journal = await store.read();
  return {
    schemaVersion: 2,
    scope: scope(config),
    journalPhase: journal?.phase ?? null,
    journalScopeMatches: journal === null || journal.scope === scope(config),
    live,
  };
}
