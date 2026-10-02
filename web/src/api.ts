// Talks to the Rushes server this page was served from. Every write sends JSON, as the server requires.
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** This tab's project id, parsed from the URL (`/p/<id>/`). Null on an old tab at `/` (the server redirects those). */
export function projectId(): string | null {
  const m = location.pathname.match(/\/p\/([a-z2-9]{8})\//);
  return m ? m[1] : null;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const id = projectId();
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (id) headers["x-rushes-project"] = id;
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, json.error ?? "error", json.message ?? `Request failed (${res.status})`);
  return json as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => call<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
};

/** URL the browser can load a registered media file (or grab) from. */
export function mediaUrl(path: string): string {
  const id = projectId();
  return `/media?path=${encodeURIComponent(path)}${id ? `&project=${id}` : ""}`;
}

/** URL for this tab's change-event stream, carrying the project id where headers can't be set. */
export function eventsUrl(): string {
  const id = projectId();
  return `/api/events${id ? `?project=${id}` : ""}`;
}
