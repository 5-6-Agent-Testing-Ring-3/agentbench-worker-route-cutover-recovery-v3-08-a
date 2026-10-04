import { ensure, hash, object, SafetyError, string } from "./safety.js";
import type { Clock, Identity } from "./types.js";

export async function validateEndpoint(
  hostname: string,
  expected: Identity,
  clock: Clock,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      for (const [path, method, status] of [
        ["/healthz", "GET", 200],
        ["/version", "GET", 200],
        ["/api/config", "GET", 200],
        ["/__rollout_missing__", "GET", 404],
        ["/healthz", "POST", 405],
      ] as const) {
        const response = await fetcher(`https://${hostname}${path}`, {
          method,
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(5_000),
        });
        ensure(
          response.status === status &&
            response.headers
              .get("content-type")
              ?.includes("application/json") &&
            response.headers.get("cache-control")?.includes("no-store"),
          "Public status or headers failed contract validation",
        );
        const body = object(await response.json());
        if (status === 404 || status === 405)
          ensure(
            body.error ===
              (status === 404 ? "not_found" : "method_not_allowed"),
            "Public error contract failed",
          );
        else if (path === "/api/config")
          ensure(
            body.schemaVersion === 1 &&
              Array.isArray(body.features) &&
              body.features.length === 2 &&
              body.features.includes("route-cutover") &&
              body.features.includes("rollback"),
            "Public configuration contract failed",
          );
        else {
          ensure(
            hash(string(body.version)) === expected.versionHash &&
              hash(string(body.worker)) === expected.workerHash,
            "Public release identity mismatch",
          );
          if (path === "/healthz")
            ensure(body.status === "ok", "Public health validation failed");
        }
      }
      return;
    } catch {
      if (attempt === 5)
        throw new SafetyError(
          "Public endpoint did not pass health, identity and contract checks within propagation budget",
        );
      await clock.sleep(Math.min(1000 * 2 ** attempt, 8000));
    }
  }
}
