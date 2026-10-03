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
const assetKind = z.enum(["screenshot", "cut", "take", "music", "sfx", "voice"]);

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
      description: "Register a new cut of a video. The first cut creates the video. Returns the new version id (v1, v2 ...).",
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
      description: "Add a music bed, SFX pass or VO lane variant for side-by-side review.",
      inputSchema: {
        project,
        stage: z.enum(["voice", "music", "sfx"]),
        name: z.string().describe("Shown on the lane, e.g. \"Deep house\"."),
        file: z.string(),
        lane: z.string().optional().describe("Lane id. Defaults to the stage."),
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
      description: "Attach a recorded or generated VO take to a script section.",
      inputSchema: { project, section: z.string(), file: z.string() },
    },
    safe(async ({ project, section, file }) => (await ctx.client(project)).post(`/api/script/${encodeURIComponent(section)}/takes`, { file })),
  );

  server.registerTool(
    "rushes_list_notes",
    {
      title: "List notes",
      description: "Notes left in Rushes, filtered by tab, status, batch or version.",
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
      description: "The batch the user sent with Send to agent (latest by default), with its notes and script sections.",
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
      description: "Every file in the project: cuts, VO takes, music, SFX and screenshots, with absolute paths. Use it to find a screenshot the user grabbed.",
      inputSchema: { project, kind: assetKind.optional() },
    },
    safe(async ({ project, kind }) => (await ctx.client(project)).get(`/api/assets${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`)),
  );

  server.registerTool(
    "rushes_get_picks",
    {
      title: "Get picks",
      description: "Which variant is in use per audio lane and which take per script section.",
      inputSchema: { project },
    },
    safe(async ({ project }) => (await ctx.client(project)).get("/api/picks")),
  );

  return server;
}
