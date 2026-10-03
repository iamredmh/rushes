import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import type { Project, Script } from "../core/schema.js";

export const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

export function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Grab files the server itself writes: .rushes/grabs/<safe name>.png */
export const GRAB_PATH = /^\.rushes\/grabs\/[a-z0-9][a-z0-9_-]*\.png$/;

/** Screenshots: screenshots/<safe name>.png. Dots are allowed, for names like "00m12.05s". */
export const SCREENSHOT_PATH = /^screenshots\/[a-z0-9][a-z0-9._-]*\.png$/;

/** Every media path the project has registered. Only these (and grabs) may be served. */
export function registeredMedia(project: Project, script: Script): Set<string> {
  const files = new Set<string>();
  for (const v of project.videos) for (const ver of v.versions) files.add(ver.file);
  for (const l of project.lanes) for (const variant of l.variants) files.add(variant.file);
  for (const s of script.sections) for (const t of s.takes) files.add(t.file);
  return files;
}

/** Parse a single "bytes=a-b" range against a file size. Returns null for a missing or unusable range. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

/**
 * Stream a file, honouring a byte Range so video can seek. Returns 404 JSON
 * when the file is missing, and 416 when the range can't be satisfied.
 */
export async function sendFile(absPath: string, rangeHeader: string | undefined, type = contentType(absPath)): Promise<Response> {
  let size: number;
  try {
    const info = await stat(absPath);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    return Response.json({ error: "missing_file", message: "That file isn't on disk any more" }, { status: 404 });
  }
  const headers: Record<string, string> = { "content-type": type, "accept-ranges": "bytes", "cache-control": "no-cache" };
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (!range) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(absPath, { start: range.start, end: range.end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) },
    });
  }
  const stream = Readable.toWeb(createReadStream(absPath)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, "content-length": String(size) } });
}

/** Resolve `rel` inside `dir`, or null if it would escape it. */
export function inside(dir: string, rel: string): string | null {
  const full = normalize(join(dir, rel));
  return full === dir || full.startsWith(dir.endsWith(sep) ? dir : dir + sep) ? full : null;
}

/**
 * `Content-Disposition: attachment` for a download, per RFC 6266 and RFC 5987: an ASCII-safe
 * `filename` fallback plus a UTF-8, percent-encoded `filename*` for browsers that use it. The
 * fallback replaces every non-ASCII character, every C0 control character and DEL, `"` and `\`
 * with `_`, so the quoted string stays valid (and never injects a header-breaking newline) no
 * matter what the real name contains. `filename*` is already percent-encoded, so it's safe as is.
 */
// String.prototype.toWellFormed() is ES2024; this project's configured lib is ES2022, even
// though Node 20.19+ and 22.12+ (its floor) both have the method at runtime. Called through
// this narrow cast rather than bumping the whole project's lib target (which would also drop
// the DOM globals -- fetch, Response, … -- bundled implicitly into the default ES2022 lib).
function toWellFormed(s: string): string {
  return (s as unknown as { toWellFormed(): string }).toWellFormed();
}

export function contentDisposition(filename: string): string {
  // toWellFormed() swaps any unpaired UTF-16 surrogate for U+FFFD. A lone surrogate is legal
  // in a JS string (and so in a filename read off disk) but isn't valid UTF-8, so
  // encodeURIComponent() throws on one outright -- before this ever gets as far as deciding
  // whether the name is safe to serve.
  const safe = toWellFormed(filename);
  let ascii = "";
  for (const ch of safe) {
    const code = ch.codePointAt(0)!;
    ascii += code <= 0x1f || code >= 0x7f || ch === '"' || ch === "\\" ? "_" : ch;
  }
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
