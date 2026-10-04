import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const valid = `CLOUDFLARE_API_TOKEN=token
CLOUDFLARE_ACCOUNT_ID=account
CLOUDFLARE_ZONE_ID=zone
CLOUDFLARE_STABLE_WORKER_NAME=stable
CLOUDFLARE_CANDIDATE_WORKER_NAME=candidate
CLOUDFLARE_PRODUCTION_HOSTNAME=prod.example.test
CLOUDFLARE_CANARY_HOSTNAME=canary.example.test
`;

describe("loadConfig", () => {
  it("loads all required values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-config-"));
    const path = join(directory, "config.env");
    await writeFile(path, valid);
    await expect(loadConfig(path)).resolves.toMatchObject({
      accountId: "account",
      stableWorker: "stable",
    });
  });

  it("rejects a missing value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-config-"));
    const path = join(directory, "config.env");
    await writeFile(
      path,
      valid.replace("CLOUDFLARE_ZONE_ID=zone", "CLOUDFLARE_ZONE_ID="),
    );
    await expect(loadConfig(path)).rejects.toThrow("CLOUDFLARE_ZONE_ID");
  });

  it("accepts comments and blank lines", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-config-"));
    const path = join(directory, "config.env");
    await writeFile(path, `# local credentials\n\n${valid}`);
    await expect(loadConfig(path)).resolves.toMatchObject({ zoneId: "zone" });
  });

  it("rejects malformed and duplicate entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rollout-config-"));
    const malformedPath = join(directory, "malformed.env");
    await writeFile(malformedPath, "not-an-assignment\n");
    await expect(loadConfig(malformedPath)).rejects.toThrow("Malformed");
    const duplicatePath = join(directory, "duplicate.env");
    await writeFile(duplicatePath, `${valid}CLOUDFLARE_ZONE_ID=again\n`);
    await expect(loadConfig(duplicatePath)).rejects.toThrow("Duplicate");
  });
});
