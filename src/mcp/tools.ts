import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, dashboardUrlFor, type RushesClient } from "./client.js";
import { VERSION } from "../server/app.js";
import { BRING_IN_MAX } from "../server/found.js";
import { LABEL_MAX, oneLineOf } from "../core/labels.js";
import { LOG_AREAS } from "../core/logText.js";
import type { Check } from "../cli/doctor.js";

export interface ToolContext {
  /** Resolve a client for a project folder (defaults to the working directory). */
  client(project?: string): Promise<RushesClient>;
  /** Open a URL in the user's browser. */
  openBrowser(url: string): void;
  /** §19.3: the doctor checks for a project folder (defaults to the working directory). Read-only, no server required. */
  doctor(project?: string): Promise<Check[]>;
}

const project = z.string().optional().describe("Project folder. Defaults to the current working directory.");
const stage = z.enum(["script", "picture", "voice", "music", "sfx", "mix"]);
const fileKind = z.enum(["doc", "image", "caption", "export", "delivery", "edit"]);
const assetKind = z.enum(["screenshot", "cut", "proxy", "take", "music", "sfx", "voice", "doc", "image", "caption", "export", "delivery", "edit"]);

// §20.7: a file to bring in. The server checks everything else (inside the project, the kind, the limits).
const film = z.string().min(1).max(200);
const bringInItem = z.object({
  path: z.string().min(1).max(1024).describe("Absolute, or relative to the project folder."),
  kind: z.enum(["voice", "music", "sfx", "cut", "doc"]).optional(),
  round: z.string().trim().min(1).max(64).optional().describe('Voice only: the round the read joins, e.g. "Round 2 · Gerald, tone". Defaults to its folder\'s name.'),
});

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** "include.0.path: Too small", for each issue the server's own validation reported. */
function issuesOf(body: ApiError["body"]): string {
  if (!Array.isArray(body.issues) || body.issues.length === 0) return "";
  const lines = (body.issues as { path?: unknown; message?: unknown }[]).slice(0, 5).map((i) => {
    const where = Array.isArray(i.path) ? i.path.join(".") : "";
    return `${where ? `${where}: ` : ""}${String(i.message ?? "invalid")}`;
  });
  return `: ${lines.join("; ")}`;
}

function fail(e: unknown) {
  const message =
    e instanceof ApiError ? (e.body.error === "not_json" ? e.message : `${e.message} (${e.body.error ?? e.status})${issuesOf(e.body)}`) : (e as Error).message;
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Wrap a handler so API errors come back as tool errors the agent can read. */
function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "rushes", version: VERSION });

  server.registerTool(
    "rushes_open",
    {
      title: "Open Rushes",
      description:
        "Starts Rushes if needed, brings in the current set of files that go with the cut, and opens it. Pass `include` for files you know belong. It waits about 20 seconds for the folder to be looked through; on a big folder it returns what it has with `scanning: true` and carries on in the background (rushes_scan, or opening again, shows the rest). Returns `broughtIn` (everything brought in since Rushes started, each with its kind, lane, reasons and `origin`: auto, include or hand), `alreadyIn` (your include files that were already registered), `failed` (files that couldn't come in, with why) and `found` (what was left, counts by kind).",
      inputSchema: {
        project,
        browser: z.boolean().optional().describe("Open the browser. Default true."),
        film: film.optional().describe("The film whose newest cut the files are matched to (id or name). Defaults to the newest cut in the project."),
        include: z
          .array(bringInItem)
          .max(BRING_IN_MAX)
          .optional()
          .describe(
            "Files you made for this cut or know belong to it, inside the project folder. They are brought in whatever they score, and win over the scoring: a kind you include (voice, music or sfx) is not also guessed for this cut, now or on later scans or restarts. Nothing already registered is ever removed. Each: path, and kind (voice, music, sfx, cut, doc) when the name doesn't say, and round for a voice read.",
          ),
      },
    },
    safe(async ({ project, browser, film, include }) => {
      const c = await ctx.client(project);
      const url = await dashboardUrlFor(c.baseUrl);
      // Open first: the dashboard shows the folder being looked through, and fills in as files arrive.
      if (browser !== false) ctx.openBrowser(url);
      let r;
      try {
        r = await c.post("/api/found/scan", { wait: true, ...(film ? { film } : {}), ...(include ? { include } : {}) });
      } catch (e) {
        // A Rushes started by an older version has no such route: it's open, just not scanned.
        if (e instanceof ApiError && e.status === 404) {
          return { url, broughtIn: [], failed: [], found: null, note: "An older Rushes is running and can't look through the folder. Run `rushes stop`, then open again." };
        }
        throw e;
      }
      return {
        url,
        broughtIn: r.added ?? [],
        alreadyIn: r.alreadyIn ?? [],
        failed: r.failed ?? [],
        found: r.found ?? null,
        ...(r.scanning ? { scanning: true } : {}),
      };
    }),
  );

  server.registerTool(
    "rushes_scan",
    {
      title: "Look through the project folder",
      description:
        "Looks through the project folder for files that go with the cut and returns the candidates, best score first, each with its kind, folder, size, length and the reasons in plain words. It also brings in the current set, as opening does (`broughtIn`), and returns what is left, with `counts` by kind (the same as `found` from rushes_open). It waits about 20 seconds; on a big folder `scanning: true` says it is still looking. Bring a chosen file in with rushes_bring_in.",
      inputSchema: {
        project,
        film: film.optional().describe("The film whose newest cut the files are matched to (id or name). Defaults to the newest cut."),
        limit: z.number().int().min(1).max(200).default(100).describe("How many candidates to return, best first. Default 100, at most 200."),
      },
    },
    safe(async ({ project, film, limit }) => {
      const c = await ctx.client(project);
      const r = await c.post("/api/found/scan", { wait: true, ...(film ? { film } : {}) });
      const { files } = await c.get<{ files: unknown[] }>("/api/found");
      return { files: files.slice(0, limit ?? 100), counts: r.found ?? null, broughtIn: r.added ?? [], ...(r.scanning ? { scanning: true } : {}) };
    }),
  );

  server.registerTool(
    "rushes_bring_in",
    {
      title: "Bring files in",
      description:
        "Registers files from inside the project folder: voice reads, music and sfx as unpicked variants, video as cuts, md, txt and pdf as docs. Nothing is picked. Returns what was added and, for each file that couldn't come in, why (a path outside the project folder is refused). Up to 60 files, 12 of a kind.",
      inputSchema: {
        project,
        files: z.array(bringInItem).min(1).max(BRING_IN_MAX).describe("Each: path (absolute or relative to the project), kind when the name doesn't say, round for a voice read."),
        film: film.optional().describe("The film a cut joins (id or name). Defaults to the newest cut's film."),
      },
    },
    safe(async ({ project, files, film }) => (await ctx.client(project)).post("/api/found/bring-in", { files, ...(film ? { film } : {}) })),
  );

  server.registerTool(
    "rushes_set_shots",
    {
      title: "Set shots",
      description:
        "Set the storyboard shot list for a cut. Shots are numbered by start time; a new cut copies the previous cut's shots until you send new ones.",
      inputSchema: {
        project,
        video: z.string().describe("Video id or name, e.g. \"Hero 60s\"."),
        version: z.string().optional().describe("Defaults to the latest cut."),
        shots: z.array(
          z.object({
            name: z.string().describe("Shot name, e.g. \"Logo reveal\"."),
            start: z.number().nonnegative().describe("Start time in seconds."),
            tag: z.string().optional(),
          }),
        ),
      },
    },
    safe(async ({ project, video, ...b }) => (await ctx.client(project)).put(`/api/videos/${encodeURIComponent(video)}/shots`, b)),
  );

  server.registerTool(
    "rushes_lock_picture",
    {
      title: "Lock picture",
      description:
        "Lock a video's picture at a version (the dashboard then opens on it, and audio review plays against it), or unlock with version null.",
      inputSchema: {
        project,
        video: z.string().describe("Video id or name, e.g. \"Hero 60s\"."),
        version: z.string().nullable().describe("Version id to lock at, or null to unlock."),
      },
    },
    safe(async ({ project, video, version }) => (await ctx.client(project)).put(`/api/videos/${encodeURIComponent(video)}/lock`, { version })),
  );

  server.registerTool(
    "rushes_status",
    {
      title: "Rushes status",
      description: "Which tabs are unlocked and how many open items each has.",
      inputSchema: { project },
    },
    safe(async ({ project }) => (await ctx.client(project)).get("/api/tabs")),
  );

  server.registerTool(
    "rushes_add_version",
    {
      title: "Add a cut",
      description:
        "Register a new cut of a video. The first cut creates the video. Returns the new version id (v1, v2 ...). When the cut is likely to play badly in a browser (4K, over 1.5 GB, or a codec such as ProRes), it also returns proxySuggested: true and proxyReason; Picture offers the user a proxy. If the project has autoProxy on, proxyJob is the proxy already being made. Give every cut a short `label` (" + LABEL_MAX + " characters at most) saying what changed, e.g. \"launch 1.45x slower\", and put the detail in `note`: the version list shows the label.",
      inputSchema: {
        project,
        video: z.string().describe("Video id or name, e.g. \"Hero 60s\"."),
        file: z.string().describe("Path to the rendered file, absolute or relative to the project."),
        note: z.string().optional().describe("What changed in this cut."),
        label: z
          .string()
          // Counted as the route counts it: on one clean line (padding and invisible characters don't count), in characters.
          .refine((s) => Array.from(oneLineOf(s)).length <= LABEL_MAX, `label is ${LABEL_MAX} characters at most: put the detail in note`)
          // Still advertised, so an agent sees the limit in the schema.
          .meta({ maxLength: LABEL_MAX })
          .optional()
          .describe(`A short label for the version list, ${LABEL_MAX} characters at most, e.g. "launch 1.45x slower". The detail goes in note.`),
      },
    },
    safe(async ({ project, ...b }) => {
      const r = await (await ctx.client(project)).post("/api/versions", b);
      // A Rushes started by an older version ignores `label`, and its reply has none: say so, so the agent isn't left thinking it was kept.
      if (b.label && r?.version && r.version.label === undefined) {
        return { ...r, note: "An older Rushes is running and dropped the label: the cut was added without it. Run `rushes stop`, then open again." };
      }
      return r;
    }),
  );

  server.registerTool(
    "rushes_add_variant",
    {
      title: "Add an audio variant",
      description:
        "Add a voice read (in a round), music bed or SFX pass for side-by-side review. Returns its lane and variant ids: a note on it is `on` \"<lane id>/<variant id>\".",
      inputSchema: {
        project,
        stage: z.enum(["voice", "music", "sfx"]),
        name: z.string().describe("Shown on the lane, e.g. \"Deep house\"."),
        file: z.string(),
        lane: z.string().optional().describe("Lane id. Defaults to `round` slugged, else the stage. Wins over `round`: give a lane only to add to an existing lane by its id."),
        round: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'Round name for voice reads (up to 64 characters), e.g. "Round 2 · Gerald, tone". Reads in one round are compared side by side; a new direction gets a new round.',
          ),
        meta: z.record(z.string(), z.union([z.string(), z.number()])).optional().describe("e.g. {\"bpm\": 120, \"key\": \"A minor\"}"),
        description: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("One line on what this read, bed or pass is, shown on its lane card. Stored as meta.description, and wins over one given in meta."),
        cues: z.array(z.object({ name: z.string(), t: z.number().nonnegative() })).optional().describe("SFX cues with times in seconds."),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).post("/api/variants", b)),
  );

  server.registerTool(
    "rushes_set_script",
    {
      title: "Set the VO script",
      description:
        "Add or update VO script sections. By default this merges by id: send only the sections you changed, with their ids, and new sections without one. Sections you leave out stay as they are. A section that keeps its id keeps the user's edits, direction and takes. Returns the full list.",
      inputSchema: {
        project,
        sections: z.array(z.object({ id: z.string().min(1).optional(), start: z.number().nonnegative(), end: z.number().nonnegative(), current: z.string() })),
        wordsPerSecond: z.number().positive().optional(),
        replace: z.boolean().optional().describe("replace the whole script; default merges by id"),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).put("/api/script", b)),
  );

  server.registerTool(
    "rushes_get_script",
    {
      title: "Get the VO script",
      description: "The whole script: every section with its current line, the user's proposed line, direction, status and takes, plus wordsPerSecond.",
      inputSchema: { project },
    },
    safe(async ({ project }) => (await ctx.client(project)).get("/api/script")),
  );

  server.registerTool(
    "rushes_add_take",
    {
      title: "Add a VO take",
      description:
        "Compatibility only: attaches a file to a script section as a take, but the Voiceover tab and the mix ignore takes. For voiceover, register each whole read with rushes_add_variant (stage \"voice\", round).",
      inputSchema: { project, section: z.string(), file: z.string() },
    },
    safe(async ({ project, section, file }) => (await ctx.client(project)).post(`/api/script/${encodeURIComponent(section)}/takes`, { file })),
  );

  server.registerTool(
    "rushes_list_notes",
    {
      title: "List notes",
      description:
        "Notes left in Rushes, filtered by tab, status, batch or version. A note's `on` says what it's about: null on Picture or for the whole mix, \"<lane>/<variant>\" for a music bed, SFX pass or voice variant, \"<lane>/<variant>:<cue>\" for an SFX cue, \"vo\" for the VO lane on Mix. Older notes may carry a bare variant id, \"vo\" for the assembled read, \"<section>:<take>\" for a take, or a section id.",
      inputSchema: {
        project,
        stage: stage.optional(),
        status: z.enum(["todo", "done"]).optional(),
        batch: z.string().optional(),
        version: z.string().optional(),
      },
    },
    safe(async ({ project, ...f }) => {
      const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined) as [string, string][]);
      return (await ctx.client(project)).get(`/api/notes${q.size ? `?${q}` : ""}`);
    }),
  );

  server.registerTool(
    "rushes_get_batch",
    {
      title: "Get a batch",
      description:
        "The batch the user sent with Send to agent (latest by default), with its notes and script sections. A note's `on` says what it's about: null on Picture or for the whole mix, \"<lane>/<variant>\" for a music bed, SFX pass or voice variant, \"<lane>/<variant>:<cue>\" for an SFX cue, \"vo\" for the VO lane on Mix. Older notes may carry a bare variant id, \"vo\" for the assembled read, \"<section>:<take>\" for a take, or a section id.",
      inputSchema: { project, id: z.string().optional() },
    },
    safe(async ({ project, id }) => (await ctx.client(project)).get(`/api/batches/${encodeURIComponent(id ?? "latest")}`)),
  );

  server.registerTool(
    "rushes_reply",
    {
      title: "Reply to notes",
      description: "Reply to one or more notes. Set status \"done\" when fixed, fixT to the time the fix is visible in the new cut, and fixVersion to that cut.",
      inputSchema: {
        project,
        replies: z
          .array(
            z.object({
              id: z.string(),
              reply: z.string().optional(),
              status: z.enum(["todo", "done"]).optional(),
              fixT: z.number().nonnegative().optional(),
              fixVersion: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    safe(async ({ project, replies }) => (await ctx.client(project)).post("/api/replies", { replies })),
  );

  server.registerTool(
    "rushes_list_assets",
    {
      title: "List assets",
      description: "Every file in the project: cuts, voice reads, older VO takes, music, SFX and screenshots, with absolute paths. Use it to find a screenshot the user grabbed.",
      inputSchema: { project, kind: assetKind.optional() },
    },
    safe(async ({ project, kind }) => (await ctx.client(project)).get(`/api/assets${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`)),
  );

  server.registerTool(
    "rushes_get_picks",
    {
      title: "Get picks",
      description:
        "Which variant is in use per audio lane (per round on Voiceover), and each Mix lane's level in dB (where the user wants voice, music and sfx to sit). Section take picks are kept for older projects but not used.",
      inputSchema: { project },
    },
    safe(async ({ project }) => (await ctx.client(project)).get("/api/picks")),
  );

  server.registerTool(
    "rushes_add_file",
    {
      title: "Add a file to the library",
      description:
        "Register a project file (a doc, image, caption, export, delivery or edit file) in the Assets library, so it's listed, can be revealed, downloaded and opened. Docs, text and PDFs at the project root, captions at the root, and anything in exports/ are found automatically; other files need this.",
      inputSchema: {
        project,
        kind: fileKind,
        file: z.string().describe("Path to the file, absolute or relative to the project."),
        name: z.string().optional().describe("Shown in the library. Defaults to the file's name."),
        note: z.string().optional(),
        video: z.string().optional().describe("Video id or name this file belongs to, e.g. a delivery or export for a specific film."),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).post("/api/files", b)),
  );

  server.registerTool(
    "rushes_export_notes",
    {
      title: "Export notes",
      description:
        "Write every note to exports/<project-slug>-notes-<date>.md, grouped by stage and, for Picture, by film and version, and the Change Log to exports/change-log-<date>.md, newest first. Exporting again the same day overwrites them. Returns both paths (path, changeLog).",
      inputSchema: { project },
    },
    safe(async ({ project }) => (await ctx.client(project)).post("/api/exports/notes", {})),
  );

  const area = z.enum(LOG_AREAS);

  server.registerTool(
    "rushes_log",
    {
      title: "Add a line to the Change Log",
      description:
        'Adds one line to the project\'s Change Log, as the agent: a decision or a change of direction, e.g. "Slowed the zooms: the first cut felt rushed". One line, 160 characters at most (longer is cut): one line per decision, not a running commentary. The log is exported and shared, so never copy a note\'s or reply\'s text into it. Rushes already logs cuts, voice reads, music, sound effects, takes, the script, picks, picture lock and unlock, notes sent, replies, files added and bring-ins by itself, so don\'t repeat those. `area` defaults to project; `video`, `version` and `ref` ("<lane>/<variant>" or "<section>:<take>") let the line open that place in the dashboard. Returns the line.',
      inputSchema: {
        project,
        text: z.string().min(1).max(2000).describe("What happened, in one line."),
        area: area.optional().describe("script, picture, voice, music, sfx, mix, notes, assets or project (the default)."),
        video: z.string().min(1).max(200).optional().describe("Video id or name, to open its cut from the line."),
        version: z.string().min(1).max(64).optional().describe("With video: the version to open."),
        ref: z.string().min(1).max(300).optional().describe('"<lane>/<variant>" to open a voice read, bed or pass from the line, or "<section>:<take>" for a take.'),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).post("/api/log", b)),
  );

  server.registerTool(
    "rushes_get_log",
    {
      title: "Read the Change Log",
      description:
        "Call this at the start of a session to catch up: what happened in the project, newest first. Cuts, reads, beds, passes and takes as they were added, the script, picks, notes sent, replies and lines people or agents wrote. Returns `entries` (each with `at`, `area`, `text`, `by`: user, agent or rushes), `earlier` (how many matching lines were left out), `undated` (audio from before the log) and `dropped` (lines removed past 5000).",
      inputSchema: {
        project,
        limit: z.number().int().min(1).max(200).default(30).describe("How many lines, newest first. Default 30, at most 200."),
        area: area.optional().describe("Only this area."),
        since: z.string().optional().describe("Only lines after this date and time, e.g. 2026-10-07T09:00:00Z."),
      },
    },
    safe(async ({ project, limit, area: a, since }) => {
      const q = new URLSearchParams({ limit: String(limit ?? 30) });
      if (a) q.set("area", a);
      if (since) q.set("since", since);
      return (await ctx.client(project)).get(`/api/log?${q}`);
    }),
  );

  server.registerTool(
    "rushes_doctor",
    {
      title: "Rushes doctor",
      description:
        "Health check (§19.3): Node version, ffmpeg/ffprobe on PATH, which agent harnesses have the Rushes MCP server registered, and this project's files, server and disk space. Read-only -- doesn't start a server or change anything.",
      inputSchema: { project },
    },
    safe(async ({ project }) => ctx.doctor(project)),
  );

  return server;
}
