import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import type { Project, Script } from "../core/schema.js";
import { PROXY_PATH } from "./proxy.js";

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
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".opus": "audio/ogg",
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
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".srt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt; charset=utf-8",
  ".pdf": "application/pdf",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".prproj": "application/octet-stream",
  ".drp": "application/octet-stream",
};

export function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Whether `type` (as `contentType()` returns it, e.g. "image/png" or "text/plain; charset=utf-8")
 * is safe to serve inline from `/media` -- i.e. a browser rendering it directly could never run
 * script or load further subresources from it. Only images other than SVG (an SVG can carry
 * `<script>`), audio, video, plain text, Markdown and PDF qualify; everything else -- HTML, XML,
 * SVG, or any type this server doesn't otherwise recognise -- is not, however it got onto disk
 * (registered, auto-discovered in exports/, or otherwise).
 */
export function isInlineSafeType(type: string): boolean {
  return /^(image\/(?!svg)|audio\/|video\/|text\/plain\b|text\/markdown\b|application\/pdf\b)/.test(type);
}

/** The security headers set on every /media response, safe or not: `sandbox` plus `default-src
 *  'none'` means even a type this function is wrong about can't run script or fetch anything if
 *  a browser is ever tricked into treating the response as a document, and `nosniff` stops the
 *  browser from guessing past a deliberately generic `application/octet-stream`. */
export function mediaSecurityHeaders(): Record<string, string> {
  return { "content-security-policy": "sandbox; default-src 'none'", "x-content-type-options": "nosniff" };
}

/** Grab files the server itself writes: .rushes/grabs/<safe name>.png */
export const GRAB_PATH = /^\.rushes\/grabs\/[a-z0-9][a-z0-9_-]*\.png$/;

/** Screenshots: screenshots/<safe name>.png. Dots are allowed, for names like "00m12.05s". */
export const SCREENSHOT_PATH = /^screenshots\/[a-z0-9][a-z0-9._-]*\.png$/;

/** Every media path the project has registered. Only these (and grabs) may be served. */
export function registeredMedia(project: Project, script: Script): Set<string> {
  const files = new Set<string>();
  for (const v of project.videos) {
    for (const ver of v.versions) {
      files.add(ver.file);
      // §19.5: a cut's proxy plays in Picture just like the cut itself -- but only a name this
      // server would write, so a hand-edited record can't open up any other file.
      if (ver.proxy && PROXY_PATH.test(ver.proxy.file)) files.add(ver.proxy.file);
    }
  }
  for (const l of project.lanes) for (const variant of l.variants) files.add(variant.file);
  for (const s of script.sections) for (const t of s.takes) files.add(t.file);
  for (const f of project.files) files.add(f.file);
  return files;
}

/**
 * §15.5 and §20.5: the file on disk for a found candidate `rel` (a manifest path the scan recorded), or null
 * when it may not be served. It must be a plain relative path (no absolute path, no `.` or `..`
 * segment, no backslash), a plain file and not a symlink, and its real path must be exactly the
 * root's real path plus `rel`: so no folder on the way has been swapped for a symlink since the
 * scan, and nothing outside the project folder is ever reached.
 */
export async function foundMediaFile(root: string, rel: string): Promise<string | null> {
  if (rel === "" || rel.includes("\\") || rel.includes("\0") || isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  try {
    const realRoot = await realpath(root);
    const abs = join(realRoot, ...parts);
    const info = await lstat(abs);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    if ((await realpath(abs)) !== abs) return null;
    return abs;
  } catch {
    return null;
  }
}

/** §15.5: the only kinds of file /media serves when its real path lies outside the project (footage on another drive, say). */
export const OUTSIDE_MEDIA_EXT: ReadonlySet<string> = new Set([
  "wav", "mp3", "m4a", "aac", "aif", "aiff", "flac", "ogg", "opus", "mp4", "mov", "m4v", "webm", "mkv",
  "png", "jpg", "jpeg", "gif", "webp", "pdf", "md", "txt", "srt", "vtt",
]);

/**
 * The file /media sends for a path it has already accepted: its real path, every symlink
 * resolved. A real path inside the project is served whatever it is, as before. Policy (§15.5):
 * one outside the project is served only if the FINAL real file's extension is media
 * (`OUTSIDE_MEDIA_EXT`), so a take swapped for a link to a key file is never served. Null means
 * refuse. A file that isn't there gives back the plain path, so the send reports it missing.
 */
export async function servableFile(root: string, abs: string): Promise<string | null> {
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    return abs;
  }
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return null;
  }
  if (real === realRoot || real.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) return real;
  const ext = extname(real).toLowerCase().replace(/^\./, "");
  return OUTSIDE_MEDIA_EXT.has(ext) ? real : null;
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
