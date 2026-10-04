interface Env {
  readonly RELEASE_VERSION: string;
  readonly WORKER_ROLE: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  fetch(request: Request, env: Env): Response {
    const url = new URL(request.url);
    if (request.method !== "GET")
      return json({ error: "method_not_allowed" }, 405);
    if (url.pathname === "/healthz")
      return json({
        status: "ok",
        version: env.RELEASE_VERSION,
        worker: env.WORKER_ROLE,
      });
    if (url.pathname === "/version")
      return json({ version: env.RELEASE_VERSION, worker: env.WORKER_ROLE });
    if (url.pathname === "/api/config") {
      return json({
        schemaVersion: 1,
        features: ["route-cutover", "rollback"],
      });
    }
    return json({ error: "not_found" }, 404);
  },
} satisfies ExportedHandler<Env>;
