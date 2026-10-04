import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JournalStore } from "../src/journal.js";
import { status } from "../src/status.js";
import { config, recovery, remote } from "./helpers.js";

describe("status", () => {
  it("never substitutes journal state for absent live production", async () => {
    const dir = await mkdtemp(join(tmpdir(), "status-"));
    const store = new JournalStore(join(dir, "journal.json"));
    const r = remote();
    expect((await status(r.client, config, store)).journalPhase).toBeNull();
    await store.write(recovery());
    r.live = { ...r.live, productionRoute: null };
    expect(
      (await status(r.client, config, store)).live.productionRoute,
    ).toBeNull();
  });
});
