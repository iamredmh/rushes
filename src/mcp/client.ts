/** Thin HTTP client for the Rushes server API, used by the MCP server and the CLI. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string; [k: string]: unknown },
  ) {
    super(body.message ?? `Rushes server returned ${status}`);
  }
}

export class RushesClient {
  constructor(readonly baseUrl: string) {}

  private async call<T>(method: string, path: string, json?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: json === undefined ? {} : { "content-type": "application/json" },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  get<T = any>(path: string) { return this.call<T>("GET", path); }
  post<T = any>(path: string, json: unknown) { return this.call<T>("POST", path, json); }
  put<T = any>(path: string, json: unknown) { return this.call<T>("PUT", path, json); }
  patch<T = any>(path: string, json: unknown) { return this.call<T>("PATCH", path, json); }
}

/** The dashboard address for a running server, `${base}/p/${id}/`, read from its own health check. */
export async function dashboardUrlFor(base: string): Promise<string> {
  const { id } = await new RushesClient(base).get<{ id: string }>("/api/health");
  return `${base}/p/${id}/`;
}
