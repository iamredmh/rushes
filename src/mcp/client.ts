import { ProjectIdSchema } from "../core/schema.js";

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
    let body: any = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON: an older Rushes answering a route it doesn't have, or something else on the port.
      throw new ApiError(res.status, {
        error: "not_json",
        message:
          res.status === 404
            ? "The Rushes server running for this project is older than this command and doesn't have that feature. Run `rushes stop`, then try again."
            : `Rushes server returned ${res.status} with a body that isn't JSON`,
      });
    }
    if (!res.ok) throw new ApiError(res.status, body);
    return body as T;
  }

  get<T = any>(path: string) { return this.call<T>("GET", path); }
  post<T = any>(path: string, json: unknown) { return this.call<T>("POST", path, json); }
  put<T = any>(path: string, json: unknown) { return this.call<T>("PUT", path, json); }
  patch<T = any>(path: string, json: unknown) { return this.call<T>("PATCH", path, json); }
}

/**
 * The dashboard address for a running server, read from its own health check: `${base}/p/${id}/`
 * for a current server, or `${base}/` for an older one (before project ids) that serves its
 * own dashboard there instead of at a `/p/<id>/` address.
 */
export async function dashboardUrlFor(base: string): Promise<string> {
  let health: { id?: string };
  try {
    health = await new RushesClient(base).get<{ id?: string }>("/api/health");
  } catch {
    throw new Error(`Rushes at ${base} didn't answer its health check`);
  }
  if (!health.id || !ProjectIdSchema.safeParse(health.id).success) return `${base}/`;
  return `${base}/p/${health.id}/`;
}
