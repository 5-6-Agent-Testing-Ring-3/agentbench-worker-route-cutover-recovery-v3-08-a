import {
  canonical,
  ensure,
  hash,
  object,
  SafetyError,
  string,
} from "./safety.js";
import type {
  Clock,
  Route,
  RouteRole,
  RuntimeConfig,
  VersionShare,
  WorkerDeployment,
  WorkerRole,
  WorkerSettings,
} from "./types.js";

export function parseDeployment(value: unknown): WorkerDeployment {
  const d = object(value);
  ensure(
    Array.isArray(d.versions) && d.versions.length > 0,
    "Malformed deployment versions",
  );
  const versions = d.versions
    .map((value: unknown) => {
      const v = object(value);
      ensure(
        typeof v.percentage === "number" &&
          v.percentage > 0 &&
          v.percentage <= 100,
        "Malformed deployment percentage",
      );
      return { version_id: string(v.version_id), percentage: v.percentage };
    })
    .sort((a, b) => a.version_id.localeCompare(b.version_id));
  ensure(
    Math.abs(versions.reduce((sum, v) => sum + v.percentage, 0) - 100) < 0.001,
    "Deployment percentages must total 100",
  );
  return {
    id: string(d.id),
    createdOn: string(d.created_on ?? d.createdOn),
    versions,
  };
}

export class CloudflareClient {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly clock: Clock,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const method = init.method ?? "GET";
    for (let attempt = 0; attempt < 4; attempt++) {
      let response: Response;
      try {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${this.config.token}`);
        if (typeof init.body === "string")
          headers.set("Content-Type", "application/json");
        response = await this.fetcher(
          `https://api.cloudflare.com/client/v4${path}`,
          {
            ...init,
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          },
        );
      } catch {
        if (method === "POST" || attempt === 3)
          throw new SafetyError(
            "Cloudflare transport failure; mutation outcome may be unknown. Rerun status and recover from the journal",
          );
        await this.clock.sleep(250 * 2 ** attempt);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        // Never replay a POST after an ambiguous server failure.
        ensure(
          attempt < 3 && (method !== "POST" || response.status === 429),
          `Cloudflare HTTP ${String(response.status)}; retry budget exhausted or mutation outcome unknown. Read status before recovery`,
        );
        const retry = response.headers.get("retry-after");
        const delay =
          retry === null
            ? 0
            : /^\d+(\.\d+)?$/u.test(retry)
              ? Number(retry) * 1000
              : Date.parse(retry) - this.clock.now().getTime();
        ensure(
          !Number.isFinite(delay) || delay <= 30_000,
          "Cloudflare Retry-After exceeds the retry budget; wait for the limit window before rerunning status or recovery",
        );
        await this.clock.sleep(
          Math.max(250 * 2 ** attempt, Number.isFinite(delay) ? delay : 0),
        );
        continue;
      }
      ensure(
        response.ok,
        `Cloudflare HTTP ${String(response.status)}; check configured scope and permissions`,
      );
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SafetyError(
          "Malformed Cloudflare JSON; mutation outcome may be unknown",
        );
      }
      const envelope = object(body);
      ensure(
        envelope.success === true && "result" in envelope,
        "Cloudflare rejected request or returned an invalid envelope; read status before recovery",
      );
      return envelope.result;
    }
    throw new SafetyError("Cloudflare retry budget exhausted");
  }
  private workerPath(role: WorkerRole): string {
    ensure(
      ["stable", "candidate"].includes(role),
      "Worker outside permitted scope",
    );
    return `/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(role === "stable" ? this.config.stableWorker : this.config.candidateWorker)}`;
  }
  private routePath(id?: string): string {
    if (id !== undefined)
      ensure(/^[\w-]+$/u.test(id), "Invalid route identifier");
    return `/zones/${this.config.zoneId}/workers/routes${id === undefined ? "" : `/${id}`}`;
  }
  private hostname(role: RouteRole): string {
    ensure(
      ["production", "canary"].includes(role),
      "Route outside permitted scope",
    );
    return role === "production"
      ? this.config.productionHostname
      : this.config.canaryHostname;
  }
  async listRoutes(): Promise<readonly Route[]> {
    const result = await this.request(this.routePath());
    ensure(Array.isArray(result), "Malformed routes list");
    const routes: Route[] = [];
    for (const value of result) {
      const r = object(value);
      const pattern = string(r.pattern);
      for (const role of ["production", "canary"] as const) {
        const host = this.hostname(role);
        const [hostPattern] = pattern.replace(/^https?:\/\//u, "").split("/");
        const regex = new RegExp(
          `^${string(hostPattern)
            .split("*")
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
            .join(".*")}$`,
          "u",
        );
        if (!regex.test(host)) continue;
        ensure(
          pattern === `${host}/*`,
          "Overlapping or noncanonical route; resolve routing ambiguity before rollout",
        );
        ensure(
          r.script === this.config.stableWorker ||
            r.script === this.config.candidateWorker ||
            r.script === null,
          "Configured route targets a Worker outside permitted scope",
        );
        routes.push({
          id: string(r.id),
          pattern: role,
          script:
            r.script === null
              ? null
              : r.script === this.config.stableWorker
                ? "stable"
                : "candidate",
        });
      }
      // Candidate code must not already serve any other zone route.
      if (r.script === this.config.candidateWorker)
        ensure(
          routes.some((route) => route.id === r.id),
          "Candidate serves another route; deployment would exceed scope",
        );
    }
    for (const role of ["production", "canary"])
      ensure(
        routes.filter((r) => r.pattern === role).length <= 1,
        "Duplicate configured route",
      );
    return routes;
  }
  async listDeployments(
    role: WorkerRole,
  ): Promise<readonly WorkerDeployment[]> {
    const result = object(
      await this.request(`${this.workerPath(role)}/deployments`),
    );
    ensure(
      Array.isArray(result.deployments) && result.deployments.length > 0,
      "No recoverable deployment exists for configured Worker",
    );
    return result.deployments.map(parseDeployment);
  }
  private async rawSettings(
    role: WorkerRole,
  ): Promise<Record<string, unknown>> {
    const result = object(
      await this.request(`${this.workerPath(role)}/settings`),
    );
    ensure(Array.isArray(result.bindings), "Malformed Worker bindings");
    string(result.compatibility_date);
    return result;
  }
  async settings(role: WorkerRole): Promise<WorkerSettings> {
    const settings = await this.rawSettings(role);
    const bindings = (settings.bindings as unknown[]).map(object);
    const identity = (name: string) => {
      const found = bindings.filter(
        (b) => b.name === name && b.type === "plain_text",
      );
      ensure(
        found.length === 1,
        "Worker lacks required public identity binding",
      );
      return hash(string(found[0]?.text));
    };
    return {
      fingerprint: hash(canonical(settings)),
      identity: {
        versionHash: identity("RELEASE_VERSION"),
        workerHash: identity("WORKER_ROLE"),
      },
      bindingTypes: bindings.map((b) => string(b.type)).sort(),
      compatibilityDate: string(settings.compatibility_date),
    };
  }
  async uploadCandidate(
    bundle: string,
    previousVersion: string,
  ): Promise<{ readonly id: string }> {
    const settings = await this.rawSettings("candidate");
    ensure(
      !settings.assets && !settings.migration_tag && !settings.containers,
      "Unsupported assets, migrations or containers; no upload performed",
    );
    const metadata: Record<string, unknown> = {
      main_module: "worker.js",
      bindings: (settings.bindings as unknown[]).map((v) => ({
        name: string(object(v).name),
        type: "inherit",
        version_id: previousVersion,
      })),
    };
    for (const key of [
      "compatibility_date",
      "compatibility_flags",
      "limits",
      "placement",
    ])
      if (settings[key] !== undefined) metadata[key] = settings[key];
    const body = new FormData();
    body.set("metadata", JSON.stringify(metadata));
    body.set(
      "worker.js",
      new Blob([bundle], { type: "application/javascript+module" }),
      "worker.js",
    );
    const result = object(
      await this.request(
        `${this.workerPath("candidate")}/versions?bindings_inherit=strict`,
        { method: "POST", body },
      ),
    );
    return { id: string(result.id) };
  }
  async deployCandidate(
    versions: readonly VersionShare[],
  ): Promise<WorkerDeployment> {
    return parseDeployment(
      await this.request(`${this.workerPath("candidate")}/deployments`, {
        method: "POST",
        body: JSON.stringify({ strategy: "percentage", versions }),
      }),
    );
  }
  async replaceRoute(
    expected: Route,
    script: WorkerRole | null,
  ): Promise<void> {
    const live = (await this.listRoutes()).find(
      (r) => r.pattern === expected.pattern,
    );
    ensure(
      canonical(live) === canonical(expected),
      "Route drift detected before update; inspect status",
    );
    ensure(
      script === null || ["stable", "candidate"].includes(script),
      "Worker outside permitted scope",
    );
    await this.request(this.routePath(expected.id), {
      method: "PUT",
      body: JSON.stringify({
        pattern: `${this.hostname(expected.pattern)}/*`,
        script:
          script === null
            ? null
            : script === "stable"
              ? this.config.stableWorker
              : this.config.candidateWorker,
      }),
    });
  }
  async createCanary(): Promise<Route> {
    ensure(
      !(await this.listRoutes()).some((r) => r.pattern === "canary"),
      "Canary appeared before creation; ownership cannot be established",
    );
    const result = object(
      await this.request(this.routePath(), {
        method: "POST",
        body: JSON.stringify({
          pattern: `${this.config.canaryHostname}/*`,
          script: this.config.candidateWorker,
        }),
      }),
    );
    ensure(
      result.pattern === `${this.config.canaryHostname}/*` &&
        result.script === this.config.candidateWorker,
      "Malformed canary creation result; ownership unknown",
    );
    return { id: string(result.id), pattern: "canary", script: "candidate" };
  }
  async deleteCanary(expected: Route): Promise<void> {
    ensure(
      expected.pattern === "canary",
      "Only owned canary routes may be deleted",
    );
    const live = (await this.listRoutes()).find((r) => r.pattern === "canary");
    if (!live) return;
    ensure(
      canonical(live) === canonical(expected),
      "Canary ownership changed; refusing deletion",
    );
    await this.request(this.routePath(expected.id), { method: "DELETE" });
  }
}
