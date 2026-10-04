import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store, ChangeEvent } from "../core/store.js";
import { RushesError, InvalidError, NotFoundError } from "../core/errors.js";
import { addFile, addVariant, addVersion, ensureProjectIdOnce, lockPicture, resolveVideo, setShots, shotAt } from "../core/project.js";
import { addTake, editSection, setSections } from "../core/script.js";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../core/notes.js";
import { createBatch, latestBatch } from "../core/batches.js";
import { exportFileName, notesMarkdown } from "../core/exportNotes.js";
import { tabStates } from "../core/tabs.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { probe } from "../core/media.js";
import { PROXY_PATH, ProxyJobs, type ProxyEvent } from "./proxy.js";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAB_PATH, SCREENSHOT_PATH, contentDisposition, contentType, inside, isInlineSafeType, mediaSecurityHeaders, registeredMedia, sendFile } from "./files.js";
import { candidatePaths, listAssets, fpsFor, screenshotName } from "./assets.js";
import { osRevealer, osOpener, OPEN_SAFE_EXT, type Revealer, type Opener } from "./reveal.js";
import type { CorruptEvent } from "./watch.js";
import { LaneStageSchema, SectionStatusSchema, StageSchema, BoxSchema, FileKindSchema, MarkSchema, ProjectIdSchema, ShotSchema, LEVEL_MIN, LEVEL_MAX, LEVEL_STEP, type Batch, type Note } from "../core/schema.js";
import { defaultRunner, measureMix, type LoudnessRunner } from "./loudness.js";

export const VERSION = "0.1.0";

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new InvalidError("Request body must be JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new InvalidError("Request body is invalid", parsed.error.issues);
  return parsed.data;
}

const t = z.number().nonnegative();

const NewNoteBody = z.object({
  stage: StageSchema,
  video: z.string().nullish(),
  version: z.string().nullish(),
  on: z.string().nullish(),
  scope: z.enum(["point", "range", "whole"]),
  t: t.nullish(),
  tOut: t.nullish(),
  frame: z.number().int().nonnegative().nullish(),
  text: z.string(),
  box: BoxSchema.nullish(),
  grab: z.string().nullish(),
  marks: z.array(MarkSchema).max(4).optional(),
});

const UserEditBody = z.object({
  text: z.string().optional(),
  box: BoxSchema.nullable().optional(),
  grab: z.string().nullable().optional(),
  scope: z.enum(["point", "range", "whole"]).optional(),
  t: t.nullable().optional(),
  tOut: t.nullable().optional(),
  marks: z.array(MarkSchema).max(4).optional(),
  status: z.enum(["todo", "done"]).optional(),
});

const RepliesBody = z.object({
  replies: z
    .array(
      z.object({
        id: z.string(),
        reply: z.string().optional(),
        status: z.enum(["todo", "done"]).optional(),
        fixT: t.nullable().optional(),
        fixVersion: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const VersionBody = z.object({ video: z.string().min(1), file: z.string().min(1), note: z.string().optional() });
const VariantBody = z.object({
  stage: LaneStageSchema,
  lane: z.string().optional(),
  round: z.string().min(1).max(64).optional(),
  name: z.string().min(1),
  file: z.string().min(1),
  meta: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  cues: z.array(z.object({ name: z.string().min(1), t })).optional(),
});
const ScriptBody = z.object({
  wordsPerSecond: z.number().positive().optional(),
  replace: z.boolean().optional(),
  sections: z.array(z.object({ id: z.string().min(1).optional(), start: t, end: t, current: z.string() })),
});
const SectionEditBody = z.object({
  proposed: z.string().nullable().optional(),
  direction: z.string().optional(),
  status: SectionStatusSchema.optional(),
});
const TakeBody = z.object({ file: z.string().min(1) });
// A pick is a variant or take id; null clears it. picks.json itself only ever holds strings.
const PickMap = z.record(z.string(), z.string().nullable());
// §19.6: a level is −24..6 dB in 0.5 dB steps; null resets it to 0 (removes the key).
const LevelValue = z.number().min(LEVEL_MIN).max(LEVEL_MAX).multipleOf(LEVEL_STEP);
const LevelsBody = z.object({ voice: LevelValue.nullable(), music: LevelValue.nullable(), sfx: LevelValue.nullable() }).partial();
const PicksBody = z.object({ lanes: PickMap.optional(), sections: PickMap.optional(), levels: LevelsBody.optional() });
const BatchBody = z.object({ stage: StageSchema });

const NoteQuery = z.object({
  stage: StageSchema.optional(),
  status: z.enum(["todo", "done"]).optional(),
  batch: z.string().optional(),
  version: z.string().optional(),
});

// ShotSchema's own limits (name trimmed 1-80 chars, tag at most 24) apply at the boundary; `n` is server-assigned.
const ShotsBody = z.object({
  version: z.string().optional(),
  shots: z.array(ShotSchema.omit({ n: true })).max(200),
});

const LockBody = z.object({ version: z.string().nullable() });

const MixLoudnessBody = z.object({ lanes: z.array(LaneStageSchema).min(1) });

const SettingsBody = z.object({ autoProxy: z.boolean() }).strict();
// A time in seconds, 0 to 24 h: an empty value, NaN, Infinity or anything huge is a 400.
const FrameQuery = z.object({ t: z.string().min(1).pipe(z.coerce.number<string>().finite().min(0).max(86400)) });

const GrabBody = z.object({
  video: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^v\d+$/),
  // Capped well short of where it would print in exponent form in the grab's filename.
  frame: z.number().int().nonnegative().max(10_000_000),
  /** PNG bytes, base64, with or without a data: prefix. */
  png: z.string().min(1),
});

const RevealBody = z.union([z.object({ path: z.string().min(1) }), z.object({ project: z.literal(true) })]);
const OpenBody = z.object({ path: z.string().min(1) });
const AddFileBody = z.object({
  kind: FileKindSchema,
  file: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  note: z.string().max(500).optional(),
  video: z.string().optional(),
});

// Big enough for a full-quality frame of a 4K original from the frame endpoint (§19.5), which
// Picture posts here as the grab: 3840×2160 RGB is 24.9 MB before PNG compression.
const MAX_GRAB_BYTES = 64 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Where the built dashboard lives: <package>/web-dist, next to dist/ and src/. */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web-dist/", import.meta.url));

export interface AppOptions {
  /** Folder with the built dashboard (index.html + assets/). */
  webDir?: string;
  /** Called after POST /api/shutdown has replied. */
  onShutdown?: () => void;
  /**
   * The project's id, already ensured. `startServer` sets this on the same options object it
   * passed in, as soon as it has won the project's lock and ensured the id, so every request
   * from then on reads it straight off. Left unset only by in-process app tests that construct
   * `createApp(store)` directly without it, which fall back to `ensureProjectIdOnce` below — the
   * same store-keyed, de-duplicated path `startServer` itself uses, so even a direct test
   * calling this concurrently from several requests never ensures (and so never writes) the id
   * twice.
   */
  projectId?: string;
  /** Reveals a file in the system file manager for POST /api/reveal. Defaults to osRevealer. */
  reveal?: Revealer;
  /** Opens a file in its default application for POST /api/open. Defaults to osOpener. */
  open?: Opener;
  /** Runs ffmpeg for POST /api/mix/loudness. Defaults to a real ffmpeg spawn. Tests inject a fake. */
  loudnessRunner?: LoudnessRunner;
  /** Kills a loudness ffmpeg run after this many ms, returning 504. Defaults to 60s; tests set it low. */
  loudnessTimeoutMs?: number;
  /** §19.5's proxy jobs (and the ffmpeg/ffprobe they use). startServer passes its own so it can cancel them on close; tests inject fakes. */
  proxyJobs?: ProxyJobs;
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

/** Hostname of "host[:port]" or a full origin URL, lowercased, or null when it doesn't parse. */
function hostnameOf(value: string, isUrl: boolean): string | null {
  try {
    return new URL(isUrl ? value : `http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function createApp(store: Store, opts: AppOptions = {}): Hono {
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const reveal = opts.reveal ?? osRevealer;
  const open = opts.open ?? osOpener;
  const jobs = opts.proxyJobs ?? new ProxyJobs(store);
  const app = new Hono();
  // Every SSE client adds a change listener, so lift Node's default limit of ten.
  store.setMaxListeners(0);

  // The project's id never changes once set. When startServer has already ensured and passed
  // it in, this is immediate; otherwise it shares project.ts's one in-flight ensure (see M3).
  async function getProjectId(): Promise<string> {
    return opts.projectId ?? ensureProjectIdOnce(store);
  }

  async function dashboardHtml(): Promise<string> {
    const index = join(webDir, "index.html");
    if (existsSync(index)) return readFile(index, "utf8");
    return `<!doctype html><title>Rushes</title><p>Rushes is running for <code>${escapeHtml(store.root)}</code>. The dashboard isn't built: run <code>npm run build</code>.</p>`;
  }

  /** The "this address belongs to a project not running here" page: always 404, id always escaped. */
  function wrongProjectPage(c: Context, id: string) {
    return c.html(
      `<!doctype html><title>Rushes</title><p>The Rushes project this address belongs to isn't running on this port. Ask your agent to open it again.</p><p><code>${escapeHtml(id)}</code></p>`,
      404,
    );
  }

  app.onError((err, c) => {
    if (err instanceof RushesError) return c.json({ error: err.code, message: err.message, ...err.detail }, err.status as 400);
    console.error(err);
    return c.json({ error: "internal", message: (err as Error).message }, 500);
  });

  // The server is for this machine only. Checking Host stops DNS rebinding;
  // requiring JSON and a local Origin on writes stops other websites posting
  // to it from the user's browser (a JSON content type forces a CORS preflight,
  // which this server never answers).
  app.use("*", async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    const hostname = hostnameOf(host, false);
    if (!hostname || !LOCAL_HOSTS.has(hostname)) {
      return c.json({ error: "forbidden_host", message: `Rushes only answers requests to 127.0.0.1 or localhost, not "${host}"` }, 403);
    }
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const type = (c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (type !== "application/json") {
        return c.json({ error: "unsupported_media_type", message: "Requests that change data must send Content-Type: application/json" }, 415);
      }
      const origin = c.req.header("origin");
      if (origin !== undefined) {
        const from = hostnameOf(origin, true);
        if (!from || !LOCAL_HOSTS.has(from)) {
          return c.json({ error: "forbidden_origin", message: `Rushes doesn't accept changes from pages on "${origin}"` }, 403);
        }
      }
    }
    await next();
  });

  // Each dashboard tab carries this project's id (header on fetches, query param
  // where headers can't be set, e.g. SSE and <img>/<video> src). A request naming
  // a different project is refused; one with no id (MCP, CLI, curl) is unaffected.
  app.use("*", async (c, next) => {
    const given = c.req.header("x-rushes-project") ?? c.req.query("project");
    if (given !== undefined && given !== (await getProjectId())) {
      return c.json({ error: "wrong_project", message: "This page is for a different Rushes project" }, 409);
    }
    await next();
  });

  // ---- dashboard ----
  app.get("/", async (c) => c.redirect(`/p/${await getProjectId()}/`, 302));

  // No trailing slash: just add it, once the id's shape is valid. The id is never
  // substituted for this server's own (a stale tab from a different project must
  // still land on /p/:id/ and see the "isn't running here" page there, never be
  // silently carried over to this project), and an invalid id is never reflected
  // into a Location header — it gets the same 404 page the slash route would give it.
  app.get("/p/:id", (c) => {
    const id = c.req.param("id");
    const parsed = ProjectIdSchema.safeParse(id);
    if (!parsed.success) return wrongProjectPage(c, id);
    return c.redirect(`/p/${parsed.data}/`, 302);
  });

  app.get("/p/:id/", async (c) => {
    const id = c.req.param("id");
    if (id !== (await getProjectId())) return wrongProjectPage(c, id);
    return c.html(await dashboardHtml());
  });

  app.get("/assets/*", async (c) => {
    const raw = new URL(c.req.url).pathname.slice(1);
    let rel: string;
    try {
      rel = decodeURIComponent(raw);
    } catch {
      throw new NotFoundError("asset", raw);
    }
    const file = inside(webDir, rel);
    if (!file) throw new NotFoundError("asset", rel);
    const res = await sendFile(file, undefined, contentType(file));
    if (res.status === 404) throw new NotFoundError("asset", rel);
    res.headers.set("cache-control", "public, max-age=31536000, immutable");
    return res;
  });

  // ---- media: only files the project registered, plus its own screenshots and grabs ----
  app.get("/media", async (c) => {
    const path = c.req.query("path") ?? "";
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    // Fast path (no filesystem reads beyond the file itself): registeredMedia is a project.json
    // lookup, and GRAB_PATH/SCREENSHOT_PATH are plain regexes. This covers every cut, take,
    // variant and registered library file, and every screenshot/grab -- by far the common case,
    // and the one a byte-range video seek hits over and over. Only a path that misses all three
    // falls through to candidatePaths, which does the readdir-backed discovery (§16.2's
    // auto-discovered docs/captions/exports) that a registered path never needs.
    const known = registeredMedia(project, script).has(path) || GRAB_PATH.test(path) || SCREENSHOT_PATH.test(path);
    if (!known) {
      const candidates = await candidatePaths(store, project, script);
      if (!candidates.has(path)) throw new NotFoundError("media", path);
    }
    // C1: a type a browser could render as a document (HTML, XML, SVG -- an SVG can carry
    // script -- or anything this server doesn't otherwise recognise) is never served inline,
    // whatever asked for it: exports/ in particular takes any file with no extension filter, so
    // without this an exports/x.html would be served as text/html on the dashboard's own origin,
    // free to call its API. Forced to a generic download instead, regardless of ?download=1.
    // §19.5: a proxy is a file this server wrote into proxies/. A symlink planted at that name
    // (or anything that isn't a plain file) is never followed.
    if (PROXY_PATH.test(path)) {
      const info = await lstat(fromManifestPath(store.root, path)).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink()) throw new NotFoundError("media", path);
    }
    const type = contentType(path);
    const inlineSafe = isInlineSafeType(type);
    const res = await sendFile(fromManifestPath(store.root, path), c.req.header("range"), inlineSafe ? type : "application/octet-stream");
    res.headers.set("cross-origin-resource-policy", "same-origin");
    for (const [name, value] of Object.entries(mediaSecurityHeaders())) res.headers.set(name, value);
    if (res.status !== 404 && (!inlineSafe || c.req.query("download") === "1")) {
      res.headers.set("content-disposition", contentDisposition(basename(path)));
    }
    return res;
  });

  app.post("/api/grabs", async (c) => {
    const b = await body(c, GrabBody);
    const bytes = Buffer.from(b.png.replace(/^data:image\/png;base64,/, ""), "base64");
    if (bytes.length > MAX_GRAB_BYTES) throw new InvalidError(`Frame grab is over ${MAX_GRAB_BYTES / 1024 / 1024} MB`);
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new InvalidError("Frame grab must be a PNG");
    const project = await store.read("project");
    const fps = fpsFor(project, b.video, b.version);
    const name = screenshotName(b.video, b.version, b.frame, fps);
    const grab = `screenshots/${name}`;
    await mkdir(join(store.root, "screenshots"), { recursive: true });
    // Written to a temp name in the same directory, then renamed into place. Writing the
    // final name directly would follow a symlink planted there (by a hand edit, say) and land
    // the bytes wherever it points; rename() replaces the directory entry itself rather than
    // the symlink's target, so the write can never escape screenshots/ that way. It also means
    // nothing ever lists a half-written PNG. The temp name starts with "." and ends in ".tmp",
    // which SCREENSHOT_PATH (the safe-name filter) already excludes from both /media and the
    // Assets listing.
    const tmp = join(store.root, "screenshots", `.${name}.${process.pid}.tmp`);
    await writeFile(tmp, bytes);
    await rename(tmp, fromManifestPath(store.root, grab));
    return c.json({ grab }, 201);
  });

  // ---- assets: the Assets tab and rushes_list_assets ----
  app.get("/api/assets", async (c) => {
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    let assets = await listAssets(store, project, script);
    const kind = c.req.query("kind");
    if (kind) assets = assets.filter((a) => a.kind === kind);
    return c.json({ assets });
  });

  app.post("/api/reveal", async (c) => {
    const b = await body(c, RevealBody);
    // §16.5: { project: true } reveals the project root itself, with no asset-list check --
    // it's always the folder this server is running for, never user-supplied.
    if ("project" in b) {
      await reveal(store.root);
      return c.json({ ok: true });
    }
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    // Exact string equality against a path /api/assets would list: no path logic beyond this is
    // needed to reject traversal, absolute paths and anything unregistered. candidatePaths is
    // cheap (no stat calls), so a request for an unlisted path never touches the filesystem at
    // all; only the one path that matches gets stat'ed, instead of rebuilding the whole index.
    const candidates = await candidatePaths(store, project, script);
    if (!candidates.has(b.path)) throw new NotFoundError("asset", b.path);
    const abs = fromManifestPath(store.root, b.path);
    const exists = await stat(abs).then(() => true, () => false);
    if (!exists) throw new NotFoundError("asset", b.path);
    await reveal(abs);
    return c.json({ ok: true });
  });

  // §16.3: open a listed asset in its default app. The listed-path check and the safe-extension
  // check both happen before any stat or spawn, so an unsafe or unlisted path never touches disk.
  app.post("/api/open", async (c) => {
    const b = await body(c, OpenBody);
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    const candidates = await candidatePaths(store, project, script);
    if (!candidates.has(b.path)) throw new NotFoundError("asset", b.path);
    const ext = extname(b.path).toLowerCase().replace(/^\./, "");
    if (!OPEN_SAFE_EXT.has(ext)) throw new RushesError(`Rushes won't open "${b.path}": unsafe file type`, 415, "unsafe_type", { path: b.path });
    const abs = fromManifestPath(store.root, b.path);
    // lstat, not stat: a symlink must never be followed here, whatever its own extension says --
    // a "brief.md" that's really a link to an .app (or to any directory or executable) must be
    // refused, not opened through to its target. Refused the same way an unsafe extension is
    // (415 unsafe_type), so a bad target can't be told apart from a merely unsafe type; a file
    // that simply isn't there any more stays 404.
    let info;
    try {
      info = await lstat(abs);
    } catch {
      throw new NotFoundError("asset", b.path);
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new RushesError(`Rushes won't open "${b.path}": unsafe file type`, 415, "unsafe_type", { path: b.path });
    }
    // Refuse anything with an execute bit set (M6): a safe extension can still be a script
    // someone chmod +x'd by hand, and Windows has no execute bit to check (file associations
    // there run off the extension alone, already covered above), so this only applies elsewhere.
    if (process.platform !== "win32" && (info.mode & 0o111) !== 0) {
      throw new RushesError(`Rushes won't open "${b.path}": unsafe file type`, 415, "unsafe_type", { path: b.path });
    }
    await open(abs);
    return c.json({ ok: true });
  });

  // ---- library: §16.2 registered files, and §16.4 notes export ----
  app.post("/api/files", async (c) => {
    const b = await body(c, AddFileBody);
    const file = toManifestPath(store.root, b.file);
    const { result } = await store.update("project", (p) => addFile(p, { ...b, file }));
    return c.json(result, 201);
  });

  app.post("/api/exports/notes", async (c) => {
    const [project, notesFile, script, picks] = await Promise.all([
      store.read("project"), store.read("notes"), store.read("script"), store.read("picks"),
    ]);
    const now = new Date();
    const md = notesMarkdown(project, notesFile.notes, now, script, picks);
    const name = exportFileName(project.name, now);
    const dir = join(store.root, "exports");
    await mkdir(dir, { recursive: true });
    // Written to a temp name in the same directory, then renamed into place -- same atomic
    // write the grabs route uses, so exporting again the same day cleanly replaces the file. A
    // process id alone isn't unique enough here (M1): two concurrent exports in the same process
    // -- two agents calling rushes_export_notes back to back, say -- would share one temp name
    // and race each other's write. randomUUID() makes every export's temp name its own.
    const tmp = join(dir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    await writeFile(tmp, md, "utf8");
    await rename(tmp, join(dir, name));
    return c.json({ path: `exports/${name}` }, 201);
  });

  app.post("/api/shutdown", (c) => {
    if (opts.onShutdown) setImmediate(opts.onShutdown);
    return c.json({ ok: true, stopping: !!opts.onShutdown });
  });

  app.get("/api/health", async (c) => {
    const [project, id] = await Promise.all([store.read("project"), getProjectId()]);
    return c.json({ ok: true, app: "rushes", version: VERSION, root: store.root, id, name: project.name });
  });

  app.get("/api/state", async (c) => {
    const [project, script, notes, picks, batches, ffmpeg] = await Promise.all([
      store.read("project"), store.read("script"), store.read("notes"), store.read("picks"), store.read("batches"), jobs.available(),
    ]);
    const tabs = tabStates(project, script, notes);
    // §19.5: why each cut may play badly (or null). Never waits on a probe: an unprobed cut is
    // null until its background probe lands, which then announces a change (ruling B).
    const videos = await Promise.all(
      project.videos.map(async (v) => ({
        ...v,
        versions: await Promise.all(v.versions.map(async (ver) => ({ ...ver, proxyNeed: await jobs.needNow(fromManifestPath(store.root, ver.file)) }))),
      })),
    );
    return c.json({ project: { ...project, videos }, script, notes, picks, batches, tabs, proxies: { ffmpeg, jobs: jobs.list() } });
  });

  app.get("/api/tabs", async (c) => {
    const [project, script, notes] = await Promise.all([store.read("project"), store.read("script"), store.read("notes")]);
    return c.json({ tabs: tabStates(project, script, notes) });
  });

  // ---- notes ----
  app.get("/api/notes", async (c) => {
    const q = NoteQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid", q.error.issues);
    const { notes } = await store.read("notes");
    return c.json({ notes: filterNotes(notes, q.data) });
  });

  app.post("/api/notes", async (c) => {
    const b = await body(c, NewNoteBody);
    // The client never sends shot; the server stamps it from the version's shots.
    let shot: Note["shot"] = null;
    if (b.stage === "picture" && b.video && b.version && b.t != null) {
      const project = await store.read("project");
      const version = project.videos.find((v) => v.id === b.video)?.versions.find((v) => v.id === b.version);
      if (version) shot = shotAt(version.shots, b.t);
    }
    const { result } = await store.update("notes", (f) => addNote(f, { ...b, shot, by: "user" }));
    return c.json({ note: result }, 201);
  });

  app.patch("/api/notes/:id", async (c) => {
    const b = await body(c, UserEditBody);
    const { result } = await store.update("notes", (f) => applyUserEdit(f, { id: c.req.param("id"), ...b }));
    return c.json({ note: result });
  });

  app.post("/api/replies", async (c) => {
    const b = await body(c, RepliesBody);
    const { result } = await store.update("notes", (f) => b.replies.map((r) => applyReply(f, r)));
    return c.json({ notes: result });
  });

  // ---- media ----
  app.post("/api/versions", async (c) => {
    const b = await body(c, VersionBody);
    const file = toManifestPath(store.root, b.file);
    const abs = fromManifestPath(store.root, file);
    // The proxy jobs' probe is ffprobe (tests inject a fake), so the cut's need is read from the same answer.
    const info = await jobs.probe(abs);
    let lockedVersion: string | null = null;
    let autoProxy = false;
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, { video: b.video, file, note: b.note, duration: info.duration, fps: info.fps });
      lockedVersion = out.video.lockedVersion;
      autoProxy = p.autoProxy;
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
    // §19.5: say when the cut is likely to play badly, and start its proxy straight away when the
    // project asks for that. Without ffmpeg, nothing is offered (needFor is null).
    const reason = await jobs.needFrom(abs, info);
    const proxy: { proxySuggested?: true; proxyReason?: string; proxyJob?: ReturnType<ProxyJobs["start"]> } = {};
    if (reason) {
      proxy.proxySuggested = true;
      proxy.proxyReason = reason;
      if (autoProxy && !jobs.isClosing) proxy.proxyJob = jobs.start(result.video.id, result.version.id);
    }
    if (lockedVersion) return c.json({ ...result, ...proxy, warning: `Picture is locked at ${lockedVersion}` }, 201);
    return c.json({ ...result, ...proxy }, 201);
  });

  // ---- proxies (§19.5) ----
  /** The cut a proxy or frame route names, or a 404. The video may be given by id, slug or name. */
  async function cutOf(videoRef: string, versionId: string) {
    const project = await store.read("project");
    const video = resolveVideo(project, videoRef);
    const version = video.versions.find((v) => v.id === versionId);
    if (!version) throw new NotFoundError("version", versionId);
    return { project, video, version };
  }

  app.post("/api/videos/:video/versions/:version/proxy", async (c) => {
    await jobs.requireFfmpeg();
    const { video, version } = await cutOf(c.req.param("video"), c.req.param("version"));
    // One job per cut (Review Focus 2): a second press, from this tab or another, joins the first.
    const joined = jobs.find(video.id, version.id) !== undefined;
    const job = jobs.start(video.id, version.id);
    return c.json({ job }, joined ? 200 : 202);
  });

  app.delete("/api/proxy-jobs/:job", async (c) => {
    const job = await jobs.cancel(c.req.param("job"));
    return c.json({ job });
  });

  app.delete("/api/videos/:video/versions/:version/proxy", async (c) => {
    const { video, version } = await cutOf(c.req.param("video"), c.req.param("version"));
    const running = jobs.find(video.id, version.id);
    if (running) await jobs.cancel(running.id);
    // Checked before writing, so a delete of nothing never bumps project.json's rev. (A job that
    // finished just as it was cancelled has recorded its proxy by now, and is deleted below.)
    const fresh = await cutOf(video.id, version.id);
    if (!fresh.version.proxy) {
      if (running) return c.json({ version: fresh.version });
      throw new NotFoundError("proxy", `${video.id} ${version.id}`);
    }
    let removed: string | null = null;
    const { result } = await store.update("project", (p) => {
      const v = p.videos.find((x) => x.id === video.id)?.versions.find((x) => x.id === version.id);
      if (!v?.proxy) return undefined;
      removed = v.proxy.file;
      v.proxy = null;
      return v;
    });
    if (!result) throw new NotFoundError("proxy", `${video.id} ${version.id}`);
    // Only ever a file this server wrote into proxies/: the original is never touched, even if
    // project.json was hand-edited to point the record somewhere else.
    if (removed && PROXY_PATH.test(removed)) await rm(fromManifestPath(store.root, removed), { force: true });
    return c.json({ version: result });
  });

  app.put("/api/project/settings", async (c) => {
    const b = await body(c, SettingsBody);
    const { data } = await store.update("project", (p) => {
      p.autoProxy = b.autoProxy;
    });
    return c.json({ autoProxy: data.autoProxy });
  });

  // Grab Frame's still, always from the original at full quality: the exact frame round(t*fps),
  // whichever file is playing. Returns the PNG only; Picture posts it to /api/grabs to save it.
  app.get("/api/videos/:video/versions/:version/frame", async (c) => {
    const q = FrameQuery.safeParse(c.req.query());
    if (!q.success) throw new InvalidError("Query is invalid: t must be a time in seconds", q.error.issues);
    await jobs.requireFfmpeg();
    const { project, version } = await cutOf(c.req.param("video"), c.req.param("version"));
    const orig = fromManifestPath(store.root, version.file);
    const exists = await stat(orig).then((s) => s.isFile(), () => false);
    if (!exists) throw new RushesError("The original file is missing", 404, "missing_file", { path: version.file });
    const fps = version.fps ?? project.fps;
    let frame = Math.round(q.data.t * fps);
    // A time at or past the end lands on the last frame rather than on nothing.
    if (version.duration !== null) frame = Math.min(frame, Math.max(0, Math.ceil(version.duration * fps - 1e-6) - 1));
    const png = await jobs.frame(orig, frame / fps);
    if (!png) throw new RushesError(`ffmpeg couldn't read frame ${frame}`, 422, "no_frame", { frame });
    return new Response(new Uint8Array(png), {
      status: 200,
      headers: { "content-type": "image/png", "cache-control": "no-store", "x-rushes-frame": String(frame), "content-length": String(png.length) },
    });
  });

  app.put("/api/videos/:video/shots", async (c) => {
    const b = await body(c, ShotsBody);
    const { result } = await store.update("project", (p) => setShots(p, c.req.param("video"), b.version, b.shots));
    return c.json({ version: result });
  });

  app.put("/api/videos/:video/lock", async (c) => {
    const b = await body(c, LockBody);
    const { result } = await store.update("project", (p) => lockPicture(p, c.req.param("video"), b.version));
    return c.json({ video: result });
  });

  app.post("/api/variants", async (c) => {
    const b = await body(c, VariantBody);
    const { result } = await store.update("project", (p) => addVariant(p, { ...b, file: toManifestPath(store.root, b.file) }));
    return c.json(result, 201);
  });

  // ---- script ----
  app.get("/api/script", async (c) => c.json({ script: await store.read("script") }));

  app.put("/api/script", async (c) => {
    const b = await body(c, ScriptBody);
    const { result } = await store.update("script", (s) => {
      if (b.wordsPerSecond) s.wordsPerSecond = b.wordsPerSecond;
      return setSections(s, b.sections, { replace: b.replace });
    });
    return c.json({ sections: result });
  });

  app.patch("/api/script/:id", async (c) => {
    const b = await body(c, SectionEditBody);
    const { result } = await store.update("script", (s) => editSection(s, c.req.param("id"), b));
    return c.json({ section: result });
  });

  app.post("/api/script/:id/takes", async (c) => {
    const b = await body(c, TakeBody);
    const file = toManifestPath(store.root, b.file);
    const info = await probe(fromManifestPath(store.root, file));
    const { result } = await store.update("script", (s) => addTake(s, c.req.param("id"), { file, duration: info.duration }));
    return c.json({ take: result }, 201);
  });

  // ---- picks ----
  app.get("/api/picks", async (c) => c.json(await store.read("picks")));

  app.put("/api/picks", async (c) => {
    const b = await body(c, PicksBody);
    // Merged key by key: a string sets that pick, null removes it, anything not named is kept.
    const merge = (into: Record<string, string>, from: Record<string, string | null> = {}) => {
      for (const [k, v] of Object.entries(from)) {
        if (v === null) delete into[k];
        else into[k] = v;
      }
    };
    const { data } = await store.update("picks", (p) => {
      merge(p.lanes, b.lanes);
      merge(p.sections, b.sections);
      // §19.6: same merge rule as lanes/sections -- a number sets the level, null resets it to 0
      // (deletes the key), anything not named is kept.
      for (const stage of ["voice", "music", "sfx"] as const) {
        const v = b.levels?.[stage];
        if (v === undefined) continue;
        if (v === null) delete p.levels[stage];
        else p.levels[stage] = v;
      }
    });
    return c.json(data);
  });

  // ---- mix loudness (§17.6) ----
  app.post("/api/mix/loudness", async (c) => {
    const b = await body(c, MixLoudnessBody);
    const [project, picks] = await Promise.all([store.read("project"), store.read("picks")]);
    const run = opts.loudnessRunner ?? defaultRunner;
    const result = await measureMix(project, picks, b.lanes, store.root, run, opts.loudnessTimeoutMs);
    return c.json(result);
  });

  // ---- batches ----
  // A batch touches two files (notes and batches), so batch creation runs one at a time.
  let batchQueue: Promise<unknown> = Promise.resolve();
  app.post("/api/batches", async (c) => {
    const { stage } = await body(c, BatchBody);
    const run = batchQueue.catch(() => undefined).then(async (): Promise<Batch> => {
      const [project, script, batches] = await Promise.all([store.read("project"), store.read("script"), store.read("batches")]);
      const { result } = await store.update("notes", (notes) => createBatch({ project, script, notes, batches }, stage));
      await store.update("batches", (f) => { f.batches.push(result); });
      return result;
    });
    batchQueue = run;
    return c.json({ batch: await run }, 201);
  });

  app.get("/api/batches/:id", async (c) => {
    const [batches, notes, script] = await Promise.all([store.read("batches"), store.read("notes"), store.read("script")]);
    const id = c.req.param("id");
    const batch = id === "latest" ? latestBatch(batches) : batches.batches.find((b) => b.id === id);
    if (!batch) throw new NotFoundError("batch", id);
    return c.json({
      batch,
      notes: notes.notes.filter((n) => batch.noteIds.includes(n.id)),
      sections: script.sections.filter((s) => batch.sectionIds.includes(s.id)),
    });
  });

  // ---- live updates ----
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (e: ChangeEvent) => void stream.writeSSE({ event: "change", data: JSON.stringify(e) });
      const corrupt = (e: CorruptEvent) => void stream.writeSSE({ event: "corrupt", data: JSON.stringify(e) });
      const proxy = (e: ProxyEvent) => void stream.writeSSE({ event: "proxy", data: JSON.stringify(e) });
      store.on("change", send);
      store.on("corrupt", corrupt);
      store.on("proxy", proxy);
      stream.onAbort(() => {
        store.off("change", send);
        store.off("corrupt", corrupt);
        store.off("proxy", proxy);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ root: store.root }) });
      while (!stream.aborted) await stream.sleep(15000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  return app;
}
