import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, dashboardUrlFor, type RushesClient } from "./client.js";
import { VERSION } from "../server/app.js";

export interface ToolContext {
  /** Resolve a client for a project folder (defaults to the working directory). */
  client(project?: string): Promise<RushesClient>;
  /** Open a URL in the user's browser. */
  openBrowser(url: string): void;
}

const project = z.string().optional().describe("Project folder. Defaults to the current working directory.");
const stage = z.enum(["script", "picture", "voice", "music", "sfx", "mix"]);
const fileKind = z.enum(["doc", "image", "caption", "export", "delivery", "edit"]);
const assetKind = z.enum(["screenshot", "cut", "take", "music", "sfx", "voice", "doc", "image", "caption", "export", "delivery", "edit"]);

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown) {
  const message = e instanceof ApiError ? `${e.message} (${e.body.error ?? e.status})` : (e as Error).message;
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
      description: "Start the Rushes review desk for a project (if it isn't running) and open it in the browser. Returns the URL.",
      inputSchema: { project, browser: z.boolean().optional().describe("Open the browser. Default true.") },
    },
    safe(async ({ project, browser }) => {
      const c = await ctx.client(project);
      const url = await dashboardUrlFor(c.baseUrl);
      if (browser !== false) ctx.openBrowser(url);
      return { url };
    }),
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
        "Register a new cut of a video. The first cut creates the video. Returns the new version id (v1, v2 ...). When the cut is likely to play badly in a browser (4K, over 1.5 GB, or a codec such as ProRes), it also returns proxySuggested: true and proxyReason; Picture offers the user a proxy. If the project has autoProxy on, proxyJob is the proxy already being made.",
      inputSchema: {
        project,
        video: z.string().describe("Video id or name, e.g. \"Hero 60s\"."),
        file: z.string().describe("Path to the rendered file, absolute or relative to the project."),
        note: z.string().optional().describe("What changed in this cut."),
      },
    },
    safe(async ({ project, ...b }) => (await ctx.client(project)).post("/api/versions", b)),
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
        "Write every note to exports/<project-slug>-notes-<date>.md, grouped by stage and, for Picture, by film and version. Exporting again the same day overwrites it. Returns the path.",
      inputSchema: { project },
    },
    safe(async ({ project }) => (await ctx.client(project)).post("/api/exports/notes", {})),
  );

  return server;
}
