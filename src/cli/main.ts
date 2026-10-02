import { parseArgs } from "node:util";
import { basename, resolve } from "node:path";
import { Store } from "../core/store.js";
import { startServer, DEFAULT_PORT, type Running } from "../server/start.js";
import { ensureServer, type EnsureOptions } from "../mcp/ensure.js";
import { ApiError } from "../mcp/client.js";
import { openBrowser, runStdio } from "../mcp/stdio.js";
import { VERSION } from "../server/app.js";
import { setup, type SetupEnv } from "../setup/setup.js";
import { realSetupEnv } from "../setup/env.js";
import type { HarnessId } from "../setup/harnesses.js";

export interface Io {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  ensure?: EnsureOptions;
  openBrowser?: (url: string) => void;
  /** Receives the server started by open/serve. When set, main does not install signal handlers (tests close it). */
  onServer?: (s: Running) => void;
  /** Environment for `rushes setup`. Tests pass a fake home. */
  setupEnv?: SetupEnv;
}

export const HELP = `rushes ${VERSION}: a local review desk for video made with AI agents

Usage
  rushes open [dir] [--port 4317] [--no-browser]   start the review desk and open it
  rushes serve [dir] [--port 4317]                 start the server without a browser
  rushes init [dir] [--name NAME]                  create the .rushes folder
  rushes setup [--only claude-code,codex,...] [--dry-run]
                                                    add Rushes to every agent harness on this machine
  rushes mcp                                        run the MCP server over stdio
  rushes status [dir]                               tabs and open items
  rushes add version <file> --video NAME [--note TEXT]
  rushes add variant <music|sfx|voice> <file> --name NAME [--lane ID]
  rushes notes [--stage S] [--status todo|done] [--batch ID] [--json]
  rushes reply <note-id> <text> [--done] [--fix-t SECONDS] [--fix-version V]

Options
  --dir DIR   project folder for commands that talk to the server (default: current folder)
`;

const OPTIONS = {
  port: { type: "string" },
  "no-browser": { type: "boolean" },
  name: { type: "string" },
  video: { type: "string" },
  note: { type: "string" },
  lane: { type: "string" },
  stage: { type: "string" },
  status: { type: "string" },
  batch: { type: "string" },
  json: { type: "boolean" },
  done: { type: "boolean" },
  "fix-t": { type: "string" },
  "fix-version": { type: "string" },
  dir: { type: "string" },
  only: { type: "string" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/** Run the CLI. Returns an exit code. Long-running commands (open, serve, mcp) resolve once started. */
export async function main(argv: string[], io: Io): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    io.err((e as Error).message);
    io.err(HELP);
    return 2;
  }
  const { values: o, positionals: p } = parsed;
  if (o.version) return io.out(VERSION), 0;
  const [cmd, ...rest] = p;
  if (!cmd || o.help || cmd === "help") return io.out(HELP), 0;

  const dir = resolve(io.cwd, o.dir ?? ".");
  const client = () => ensureServer(dir, io.ensure);

  try {
    switch (cmd) {
      case "open":
      case "serve": {
        const root = resolve(io.cwd, rest[0] ?? ".");
        const s = await startServer(root, { port: o.port ? Number(o.port) : DEFAULT_PORT });
        io.out(`Rushes is running for ${root}\n${s.url}`);
        if (cmd === "open" && !o["no-browser"]) (io.openBrowser ?? openBrowser)(s.url);
        if (io.onServer) return io.onServer(s), 0;
        const stop = () => void s.close().then(() => process.exit(0));
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        return 0;
      }
      case "init": {
        const root = resolve(io.cwd, rest[0] ?? ".");
        await new Store(root).init(o.name ?? basename(root));
        io.out(`Created ${root}/.rushes`);
        return 0;
      }
      case "setup": {
        const only = o.only ? (o.only.split(",").map((x) => x.trim()) as HarnessId[]) : undefined;
        const results = await setup(io.setupEnv ?? realSetupEnv(), { only, dryRun: o["dry-run"] });
        const mark = { added: "+", "would-add": "~", already: "=", "not-found": "-", failed: "!" } as const;
        for (const r of results) {
          const skill = r.skill ? `, skill ${r.skill}` : "";
          io.out(`${mark[r.status]} ${r.name.padEnd(15)} ${r.status}${skill}${r.status === "not-found" ? "" : `  ${r.detail}`}`);
        }
        const added = results.filter((r) => r.status === "added").length;
        if (added) io.out(`\nRestart ${added === 1 ? "that app" : "those apps"} so ${added === 1 ? "it picks" : "they pick"} up the rushes tools. Then ask your agent to "open Rushes".`);
        if (!results.some((r) => r.status !== "not-found")) io.out("No supported agent harness found. See https://github.com/iamredmh/rushes#other-harnesses");
        return results.some((r) => r.status === "failed") ? 1 : 0;
      }
      case "mcp":
        await runStdio(io.cwd);
        return 0;
      case "status": {
        const { tabs } = await (await client()).get("/api/tabs");
        for (const t of tabs as { stage: string; unlocked: boolean; todo: number }[]) {
          io.out(`${t.stage.padEnd(8)} ${t.unlocked ? "open  " : "locked"} ${t.todo ? `${t.todo} to do` : ""}`.trimEnd());
        }
        return 0;
      }
      case "add": {
        const [what, a, b] = rest;
        const c = await client();
        if (what === "version") {
          if (!a || !o.video) return usage(io, "rushes add version <file> --video NAME");
          const r = await c.post("/api/versions", { video: o.video, file: resolve(io.cwd, a), note: o.note });
          io.out(`Added ${r.video.name} ${r.version.id}`);
          return 0;
        }
        if (what === "variant") {
          if (!a || !b || !o.name) return usage(io, "rushes add variant <music|sfx|voice> <file> --name NAME");
          const r = await c.post("/api/variants", { stage: a, file: resolve(io.cwd, b), name: o.name, lane: o.lane });
          io.out(`Added ${r.lane.name}: ${r.variant.name}`);
          return 0;
        }
        return usage(io, "rushes add version|variant ...");
      }
      case "notes": {
        const q = new URLSearchParams();
        for (const k of ["stage", "status", "batch"] as const) if (o[k]) q.set(k, o[k]!);
        const { notes } = await (await client()).get(`/api/notes${q.size ? `?${q}` : ""}`);
        if (o.json) return io.out(JSON.stringify(notes, null, 2)), 0;
        for (const n of notes) io.out(`${n.id}  ${n.status === "done" ? "done" : "todo"}  ${n.stage.padEnd(7)} ${when(n).padEnd(17)} ${n.text}`);
        if (!notes.length) io.out("No notes");
        return 0;
      }
      case "reply": {
        const [id, ...words] = rest;
        if (!id || !words.length) return usage(io, "rushes reply <note-id> <text> [--done] [--fix-t SECONDS]");
        const reply = {
          id,
          reply: words.join(" "),
          ...(o.done ? { status: "done" } : {}),
          ...(o["fix-t"] ? { fixT: Number(o["fix-t"]) } : {}),
          ...(o["fix-version"] ? { fixVersion: o["fix-version"] } : {}),
        };
        await (await client()).post("/api/replies", { replies: [reply] });
        io.out(`Replied to ${id}`);
        return 0;
      }
      default:
        io.err(`Unknown command "${cmd}"`);
        io.err(HELP);
        return 2;
    }
  } catch (e) {
    io.err(e instanceof ApiError ? `${e.message}` : (e as Error).message);
    return 1;
  }
}

function usage(io: Io, line: string): number {
  io.err(`Usage: ${line}`);
  return 2;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function when(n: { scope: string; t: number | null; tOut: number | null }): string {
  if (n.scope === "whole" || n.t === null) return "whole";
  return n.scope === "range" && n.tOut !== null ? `${fmt(n.t)}–${fmt(n.tOut)}` : fmt(n.t);
}
