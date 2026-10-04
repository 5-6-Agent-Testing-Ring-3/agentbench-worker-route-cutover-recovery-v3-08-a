import type { RuntimeConfig } from "./types.js";
const sensitiveKey = /authorization|token|secret|password/i;

export function redact(value: unknown, config?: RuntimeConfig): unknown {
  if (value instanceof Error)
    return {
      error: "Operation failed; inspect the sanitized command diagnostic",
    };
  if (Array.isArray(value))
    return value.map((item: unknown) => redact(item, config));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redact(item, config),
      ]),
    );
  }
  if (typeof value === "string" && config) {
    for (const secret of Object.values({ ...config }).sort(
      (a, b) => b.length - a.length,
    ))
      value = (value as string).split(secret).join("[REDACTED]");
  }
  return value;
}
