import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JournalStore } from "../src/journal.js";
import { hash } from "../src/safety.js";
import { recovery } from "./helpers.js";

describe("JournalStore", () => {
  it("durably round-trips checksummed JSON and rejects truncation and corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "journal-"));
    const path = join(directory, "nested", "journal.json");
    const store = new JournalStore(path);
    expect(await store.read()).toBeNull();
    await store.write(recovery());
    expect(await store.read()).toEqual(recovery());
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    await writeFile(path, text.replace("prepared", "complete"));
    await expect(store.read()).rejects.toThrow("corrupt");
    await writeFile(path, "{broken");
    await expect(store.read()).rejects.toThrow("corrupt");
  });
  it("excludes overlapping processes across stores and releases after errors", async () => {
    const key = hash(`lock-${String(Math.random())}`);
    const a = new JournalStore("unused-a");
    const b = new JournalStore("unused-b");
    await a.withLock(key, async () => {
      await expect(b.withLock(key, async () => undefined)).rejects.toThrow(
        "Concurrent",
      );
    });
    await expect(
      a.withLock(key, async () => {
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    await expect(b.withLock(key, async () => 1)).resolves.toBe(1);
    await expect(a.withLock("bad", async () => 1)).rejects.toThrow("Invalid");
  });
});

it("excludes an independent Node process using the same scope", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const runtime = (globalThis as unknown as { process: { execPath: string } })
    .process;
  const key = hash("independent-process-fixture");
  const store = new JournalStore("unused");
  await store.withLock(key, async () => {
    const { stdout } = await promisify(execFile)(runtime.execPath, [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { JournalStore } from './src/journal.ts'; try { await new JournalStore('unused-child').withLock('${key}', async () => console.log('unexpected')); } catch { console.log('excluded'); }`,
    ]);
    expect(stdout.trim()).toBe("excluded");
  });
});
