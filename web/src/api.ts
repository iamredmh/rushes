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
  del: <T>(path: string, body: unknown = {}) => call<T>("DELETE", path, body),
};

/**
 * §19.5: the exact frame at `t` from a cut's original file, extracted by ffmpeg on the server, as a
 * PNG data URL ready for POST /api/grabs, with the frame number the server actually took.
 */
export async function originalFrame(video: string, version: string, t: number): Promise<{ frame: number | null; png: string }> {
  const id = projectId();
  const res = await fetch(`/api/videos/${encodeURIComponent(video)}/versions/${encodeURIComponent(version)}/frame?t=${t}`, {
    headers: id ? { "x-rushes-project": id } : {},
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new ApiError(res.status, json.error ?? "error", json.message ?? `Request failed (${res.status})`);
  }
  const header = Number(res.headers.get("x-rushes-frame"));
  const blob = await res.blob();
  const png = await new Promise<string>((ok, fail) => {
    const reader = new FileReader();
    reader.onload = () => ok(reader.result as string);
    reader.onerror = () => fail(reader.error ?? new Error("Couldn't read the frame"));
    reader.readAsDataURL(blob);
  });
  return { frame: Number.isInteger(header) && header >= 0 ? header : null, png };
}

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
