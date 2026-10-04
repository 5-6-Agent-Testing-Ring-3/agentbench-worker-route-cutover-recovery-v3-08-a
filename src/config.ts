import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { RuntimeConfig } from "./types.js";

const requiredKeys = [
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_ZONE_ID",
  "CLOUDFLARE_STABLE_WORKER_NAME",
  "CLOUDFLARE_CANDIDATE_WORKER_NAME",
  "CLOUDFLARE_PRODUCTION_HOSTNAME",
  "CLOUDFLARE_CANARY_HOSTNAME",
] as const;

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("Malformed environment file");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key in result) throw new Error(`Duplicate environment key: ${key}`);
    result[key] = value;
  }
  return result;
}

export async function loadConfig(path?: string): Promise<RuntimeConfig> {
  const configPath =
    path ?? resolve(homedir(), ".config/agent-eval/cloudflare-worker.env");
  const values = parseEnv(await readFile(configPath, "utf8"));
  for (const key of requiredKeys) {
    if (!values[key])
      throw new Error(`Missing required environment key: ${key}`);
  }
  const get = (key: (typeof requiredKeys)[number]): string => {
    const value = values[key];
    if (!value) throw new Error(`Missing required environment key: ${key}`);
    return value;
  };
  return {
    token: get("CLOUDFLARE_API_TOKEN"),
    accountId: get("CLOUDFLARE_ACCOUNT_ID"),
    zoneId: get("CLOUDFLARE_ZONE_ID"),
    stableWorker: get("CLOUDFLARE_STABLE_WORKER_NAME"),
    candidateWorker: get("CLOUDFLARE_CANDIDATE_WORKER_NAME"),
    productionHostname: get("CLOUDFLARE_PRODUCTION_HOSTNAME"),
    canaryHostname: get("CLOUDFLARE_CANARY_HOSTNAME"),
  };
}
