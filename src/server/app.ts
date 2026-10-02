import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Store, ChangeEvent } from "../core/store.js";
import { RushesError, InvalidError, NotFoundError } from "../core/errors.js";
import { addVariant, addVersion } from "../core/project.js";
import { addTake, editSection, setSections } from "../core/script.js";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../core/notes.js";
import { createBatch, latestBatch } from "../core/batches.js";
import { tabStates } from "../core/tabs.js";
import { fromManifestPath, toManifestPath } from "../core/paths.js";
import { probe } from "../core/media.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GRAB_PATH, contentType, inside, registeredMedia, sendFile } from "./files.js";
import type { CorruptEvent } from "./watch.js";
import { LaneStageSchema, SectionStatusSchema, StageSchema, BoxSchema, type Batch } from "../core/schema.js";

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

const GrabBody = z.object({
  video: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^v\d+$/),
  // Capped well short of where it would print in exponent form in the grab's filename.
  frame: z.number().int().nonnegative().max(10_000_000),
  /** PNG bytes, base64, with or without a data: prefix. */
  png: z.string().min(1),
});

const MAX_GRAB_BYTES = 25 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Where the built dashboard lives: <package>/web-dist, next to dist/ and src/. */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL("../../web-dist/", import.meta.url));

export interface AppOptions {
  /** Folder with the built dashboard (index.html + assets/). */
  webDir?: string;
  /** Called after POST /api/shutdown has replied. */
  onShutdown?: () => void;
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
  const app = new Hono();
  // Every SSE client adds a change listener, so lift Node's default limit of ten.
  store.setMaxListeners(0);

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

  // ---- dashboard ----
  app.get("/", async (c) => {
    const index = join(webDir, "index.html");
    if (existsSync(index)) return c.html(await readFile(index, "utf8"));
    return c.html(`<!doctype html><title>Rushes</title><p>Rushes is running for <code>${escapeHtml(store.root)}</code>. The dashboard isn't built: run <code>npm run build</code>.</p>`);
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

  // ---- media: only files the project registered, plus its own grabs ----
  app.get("/media", async (c) => {
    const path = c.req.query("path") ?? "";
    const [project, script] = await Promise.all([store.read("project"), store.read("script")]);
    if (!registeredMedia(project, script).has(path) && !GRAB_PATH.test(path)) throw new NotFoundError("media", path);
    const res = await sendFile(fromManifestPath(store.root, path), c.req.header("range"));
    res.headers.set("cross-origin-resource-policy", "same-origin");
    return res;
  });

  app.post("/api/grabs", async (c) => {
    const b = await body(c, GrabBody);
    const bytes = Buffer.from(b.png.replace(/^data:image\/png;base64,/, ""), "base64");
    if (bytes.length > MAX_GRAB_BYTES) throw new InvalidError(`Frame grab is over ${MAX_GRAB_BYTES / 1024 / 1024} MB`);
    if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new InvalidError("Frame grab must be a PNG");
    const grab = `.rushes/grabs/${b.video}_${b.version}_f${b.frame}.png`;
    await mkdir(join(store.dir, "grabs"), { recursive: true });
    await writeFile(fromManifestPath(store.root, grab), bytes);
    return c.json({ grab }, 201);
  });

  app.post("/api/shutdown", (c) => {
    if (opts.onShutdown) setImmediate(opts.onShutdown);
    return c.json({ ok: true, stopping: !!opts.onShutdown });
  });

  app.get("/api/health", (c) => c.json({ ok: true, app: "rushes", version: VERSION, root: store.root }));

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
    const { result } = await store.update("notes", (f) => addNote(f, { ...b, by: "user" }));
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
    const { result } = await store.update("project", (p) => {
      const out = addVersion(p, { video: b.video, file, note: b.note, duration: info.duration, fps: info.fps });
      if (info.fps && p.videos.length === 1 && p.videos[0].versions.length === 1) p.fps = info.fps;
      return out;
    });
    return c.json(result, 201);
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
