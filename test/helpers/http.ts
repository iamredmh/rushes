/** The part of a Hono app these helpers use. */
type App = { request(input: string, init?: RequestInit): Response | Promise<Response> };

export interface Reply {
  status: number;
  /** The body as JSON; the text itself when it isn't JSON, null when empty. */
  json: any;
  text: string;
  headers: Headers;
  res: Response;
}

/**
 * Calls `app` with a JSON body when there is one, and reads the reply as JSON (as text when it
 * isn't JSON). `headers` are added to the request.
 */
export function jsonCaller(app: App) {
  return async (method: string, path: string, json?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const res = await app.request(path, {
      method,
      headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: the text stands */
    }
    return { status: res.status, json: parsed, text, headers: res.headers, res };
  };
}

/** POSTs a JSON body and hands back the response as it is, for a test that reads it itself. */
export function jsonPoster(app: App) {
  return (path: string, json: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(json) });
}
