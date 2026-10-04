import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JournalStore } from "../src/journal.js";
import type { Journal } from "../src/types.js";

const journal: Journal = {
  schemaVersion: 1,
  runId: "run-1",
  startedAt: "2025-08-23T00:00:00.000Z",
  previousProduction: null,
  candidateDeploymentId: null,
  productionChanged: false,
  completed: false,
};

describe("JournalStore", () => {
  it("returns null when absent and round-trips deterministic JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-journal-"));
    const path = join(directory, "nested", "journal.json");
    const store = new JournalStore(path);
    await expect(store.read()).resolves.toBeNull();
    await store.write(journal);
    await expect(store.read()).resolves.toEqual(journal);
    expect(await readFile(path, "utf8")).toMatch(/\n$/u);
  });

  it("rejects corrupt JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-journal-"));
    const path = join(directory, "journal.json");
    await writeFile(path, "{broken");
    await expect(new JournalStore(path).read()).rejects.toThrow();
  });
});
