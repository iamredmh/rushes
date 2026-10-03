import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store, ChangeEvent } from "../core/store.js";
import { RushesError, InvalidError, NotFoundError } from "../core/errors.js";
import { addVariant, addVersion, ensureProjectIdOnce, lockPicture, setShots, shotAt } from "../core/project.js";
import { addTake, editSection, setSections } from "../core/script.js";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../core/notes.js";
import { createBatch, latestBatch } from "../core/batches.js";
import { tabStates } from "../core/tabs.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { probe } from "../core/media.js";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAB_PATH, SCREENSHOT_PATH, contentDisposition, contentType, inside, registeredMedia, sendFile } from "./files.js";
import { candidatePaths, listAssets, fpsFor, screenshotName } from "./assets.js";
import { osRevealer, type Revealer } from "./reveal.js";
import type { CorruptEvent } from "./watch.js";
import { LaneStageSchema, SectionStatusSchema, StageSchema, BoxSchema, ProjectIdSchema, ShotSchema, type Batch, type Note } from "../core/schema.js";

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
});

const UserEditBody = z.object({
  text: z.string().optional(),
  box: BoxSchema.nullable().optional(),
  grab: z.string().nullable().optional(),
  scope: z.enum(["point", "range", "whole"]).optional(),
  t: t.nullable().optional(),
  tOut: t.nullable().optional(),
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
const PicksBody = z.object({ lanes: z.record(z.string(), z.string()).optional(), sections: z.record(z.string(), z.string()).optional() });
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

const GrabBody = z.object({
  video: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^v\d+$/),
  // Capped well short of where it would print in exponent form in the grab's filename.
  frame: z.number().int().nonnegative().max(10_000_000),
  /** PNG bytes, base64, with or without a data: prefix. */
  png: z.string().min(1),
});

const RevealBody = z.object({ path: z.string().min(1) });

const MAX_GRAB_BYTES = 25 * 1024 * 1024;
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
    if (!registeredMedia(project, script).has(path) && !GRAB_PATH.test(path) && !SCREENSHOT_PATH.test(path)) {
      throw new NotFoundError("media", path);
    }
    const res = await sendFile(fromManifestPath(store.root, path), c.req.header("range"));
    res.headers.set("cross-origin-resource-policy", "same-origin");
    if (res.status !== 404 && c.req.query("download") === "1") {
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
    const grab = `screenshots/${screenshotName(b.video, b.version, b.frame, fps)}`;
    await mkdir(join(store.root, "screenshots"), { recursive: true });
    await writeFile(fromManifestPath(store.root, grab), bytes);
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

  app.post("/api/shutdown", (c) => {
    if (opts.onShutdown) setImmediate(opts.onShutdown);
    return c.json({ ok: true, stopping: !!opts.onShutdown });
  });

  app.get("/api/health", async (c) => {
    const [project, id] = await Promise.all([store.read("project"), getProjectId()]);
    return c.json({ ok: true, app: "rushes", version: VERSION, root: store.root, id, name: project.name });
  });

  app.get("/api/state", async (c) => {
    const [project, script, notes, picks, batches] = await Promise.all([
      store.read("project"), store.read("script"), store.read("notes"), store.read("picks"), store.read("batches"),
    ]);
    return c.json({ project, script, notes, picks, batches, tabs: tabStates(project, script, notes) });
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
    const info = await probe(fromManifestPath(store.root, file));
    let lockedVersion: string | null = null;
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, { video: b.video, file, note: b.note, duration: info.duration, fps: info.fps });
      lockedVersion = out.video.lockedVersion;
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
    if (lockedVersion) return c.json({ ...result, warning: `Picture is locked at ${lockedVersion}` }, 201);
    return c.json(result, 201);
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
    const { data } = await store.update("picks", (p) => {
      Object.assign(p.lanes, b.lanes ?? {});
      Object.assign(p.sections, b.sections ?? {});
    });
    return c.json(data);
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
      store.on("change", send);
      store.on("corrupt", corrupt);
      stream.onAbort(() => {
        store.off("change", send);
        store.off("corrupt", corrupt);
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ root: store.root }) });
      while (!stream.aborted) await stream.sleep(15000).then(() => stream.writeSSE({ event: "ping", data: "" }));
    }),
  );

  return app;
}
