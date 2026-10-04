import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ensure, SafetyError } from "./safety.js";
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
    if (separator <= 0) throw new SafetyError("Malformed environment file");
    const key = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/u, "$2");
    if (key in result) throw new SafetyError("Duplicate environment key");
    result[key] = value;
  }
  return result;
}

export async function loadConfig(path?: string): Promise<RuntimeConfig> {
  const configPath =
    path ?? resolve(homedir(), ".config/agent-eval/cloudflare-worker.env");
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    throw new SafetyError(
      "Credential file unavailable; provision ~/.config/agent-eval/cloudflare-worker.env with restricted file permissions. Do not paste credentials into logs",
    );
  }
  const values = parseEnv(text);
  for (const key of requiredKeys) {
    if (!values[key])
      throw new SafetyError(`Missing required environment key: ${key}`);
  }
  const get = (key: (typeof requiredKeys)[number]): string => {
    const value = values[key];
    if (!value)
      throw new SafetyError(`Missing required environment key: ${key}`);
    return value;
  };
  const config = {
    token: get("CLOUDFLARE_API_TOKEN"),
    accountId: get("CLOUDFLARE_ACCOUNT_ID"),
    zoneId: get("CLOUDFLARE_ZONE_ID"),
    stableWorker: get("CLOUDFLARE_STABLE_WORKER_NAME"),
    candidateWorker: get("CLOUDFLARE_CANDIDATE_WORKER_NAME"),
    productionHostname: get("CLOUDFLARE_PRODUCTION_HOSTNAME"),
    canaryHostname: get("CLOUDFLARE_CANARY_HOSTNAME"),
  };
  ensure(
    config.stableWorker !== config.candidateWorker &&
      config.productionHostname !== config.canaryHostname,
    "Stable/candidate and production/canary must be distinct",
  );
  for (const worker of [config.stableWorker, config.candidateWorker])
    ensure(/^[a-zA-Z0-9_-]+$/u.test(worker), "Invalid Worker name");
  for (const hostname of [config.productionHostname, config.canaryHostname])
    ensure(
      /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+$/u.test(hostname),
      "Invalid configured hostname",
    );
  for (const id of [config.accountId, config.zoneId])
    ensure(
      /^[a-zA-Z0-9_-]+$/u.test(id),
      "Invalid configured resource identifier",
    );
  return config;
}
