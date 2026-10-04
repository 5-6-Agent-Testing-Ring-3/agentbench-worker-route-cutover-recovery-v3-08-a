import type { Clock, Route, RuntimeConfig, WorkerDeployment } from "./types.js";

interface Envelope<T> {
  readonly success: boolean;
  readonly result: T;
  readonly errors?: readonly {
    readonly code: number;
    readonly message: string;
  }[];
}

export class CloudflareClient {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly clock: Clock,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let attempts = 0;
    for (;;) {
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${this.config.token}`);
      headers.set("Content-Type", "application/json");
      const response = await this.fetcher(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          ...init,
          headers,
        },
      );
      if (response.status === 429 || response.status >= 500) {
        attempts += 1;
        await this.clock.sleep(100 * attempts);
        continue;
      }
      const envelope: Envelope<T> = await response.json();
      if (!response.ok || !envelope.success) {
        throw new Error(
          `Cloudflare request failed: ${JSON.stringify({ path, init, envelope })}`,
        );
      }
      return envelope.result;
    }
  }

  async listRoutes(): Promise<readonly Route[]> {
    return this.request<readonly Route[]>(
      `/zones/${this.config.zoneId}/workers/routes`,
    );
  }

  async listDeployments(worker: string): Promise<readonly WorkerDeployment[]> {
    return this.request<readonly WorkerDeployment[]>(
      `/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(worker)}/deployments`,
    );
  }

  async uploadCandidate(bundle: string): Promise<{ readonly id: string }> {
    return this.request<{ readonly id: string }>(
      `/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(this.config.candidateWorker)}`,
      { method: "PUT", body: bundle },
    );
  }

  async replaceRoute(
    routeId: string,
    pattern: string,
    script: string,
  ): Promise<Route> {
    return this.request<Route>(
      `/zones/${this.config.zoneId}/workers/routes/${routeId}`,
      {
        method: "PUT",
        body: JSON.stringify({ pattern, script }),
      },
    );
  }

  async createRoute(pattern: string, script: string): Promise<Route> {
    return this.request<Route>(`/zones/${this.config.zoneId}/workers/routes`, {
      method: "POST",
      body: JSON.stringify({ pattern, script }),
    });
  }

  async deleteRoute(routeId: string): Promise<void> {
    await this.request<unknown>(
      `/zones/${this.config.zoneId}/workers/routes/${routeId}`,
      { method: "DELETE" },
    );
  }
}
