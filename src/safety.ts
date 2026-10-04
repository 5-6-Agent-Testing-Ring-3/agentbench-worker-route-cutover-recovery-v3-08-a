import { createHash } from "node:crypto";
import type { RuntimeConfig } from "./types.js";

export class SafetyError extends Error {}
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SafetyError(message);
}
export function object(value: unknown): Record<string, unknown> {
  ensure(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Malformed remote or recovery object",
  );
  return value as Record<string, unknown>;
}
export function string(value: unknown): string {
  ensure(
    typeof value === "string" && value.length > 0,
    "Missing remote or recovery string",
  );
  return value;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export function same(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}
export function scope(config: RuntimeConfig): string {
  const {
    accountId,
    zoneId,
    stableWorker,
    candidateWorker,
    productionHostname,
    canaryHostname,
  } = config;
  const resources = {
    accountId,
    zoneId,
    stableWorker,
    candidateWorker,
    productionHostname,
    canaryHostname,
  };
  return hash(canonical(resources));
}
export function assertClean(text: string, config: RuntimeConfig): void {
  ensure(
    !Object.values({ ...config }).some((value) => text.includes(value)),
    "Credential material found in artifact; rebuild without credentials",
  );
  ensure(
    !/Bearer\s+[A-Za-z0-9_-]{12,}/u.test(text),
    "Authorization material found in artifact",
  );
}
export const systemClock = {
  now: () => new Date(),
  sleep: (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
};

export function required<T>(value: T | null | undefined): T {
  ensure(
    value !== null && value !== undefined,
    "Required recovery value is absent",
  );
  return value;
}
