import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Store } from "../core/store.js";
import { startServer, DEFAULT_PORT, type Running } from "../server/start.js";
import { ensureServer, findServer, type EnsureOptions } from "../mcp/ensure.js";
import { AlreadyRunningError, canonicalRoot } from "../server/lock.js";
import { ApiError, RushesClient, dashboardUrlFor } from "../mcp/client.js";
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
  rushes open [dir] [--port 4580] [--no-browser]   start the review desk and open it
  rushes serve [dir] [--port 4580] [--idle-minutes N]
                                                    start the server without a browser (stops after N idle minutes)
  rushes stop [dir]                                 stop the project's running server
  rushes init [dir] [--name NAME]                  create the .rushes folder
  rushes setup [--only claude-code,codex,...] [--dry-run]
                                                    add Rushes to every agent harness on this machine
  rushes mcp                                        run the MCP server over stdio
  rushes status [dir]                               tabs and open items
  rushes add version <file> --video NAME [--note TEXT]
  rushes add variant <music|sfx|voice> <file> --name NAME [--lane ID]
  rushes add shots <file.json> --video NAME [--version V]
  rushes lock <video> <version>                     lock the picture at a cut
  rushes unlock <video>                              unlock the picture
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
  "idle-minutes": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const LONG_RUNNING = ["open", "serve", "mcp"];

/** Does this command line start something that keeps running (open, serve, mcp)? Flags before the command are skipped. */
export function longRunningCommand(argv: string[]): boolean {
  try {
    const [cmd] = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }).positionals;
    return LONG_RUNNING.includes(cmd ?? "");
  } catch {
    return false;
  }
}

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
  const [cmd, ...rest] = p;
  // A bare `--version`/`-v` prints the package version; on a subcommand (e.g. "add shots
  // ... --version v2") the same boolean flag is set, but there's a command to run instead.
  if (!cmd && o.version) return io.out(VERSION), 0;
  if (!cmd || o.help || cmd === "help") return io.out(HELP), 0;

  const dir = resolve(io.cwd, o.dir ?? ".");
  const client = () => ensureServer(dir, io.ensure);

  try {
    switch (cmd) {
      case "open":
      case "serve": {
        const root = await canonicalRoot(resolve(io.cwd, rest[0] ?? "."));
        const show = (url: string) => {
          if (cmd === "open" && !o["no-browser"]) (io.openBrowser ?? openBrowser)(url);
        };
        const already = async (url: string) => {
          const dashboardUrl = await dashboardUrlFor(url);
          io.out(`Rushes is already running for ${root}\n${dashboardUrl}`);
          show(dashboardUrl);
          return 0;
        };
        const running = await findServer(root);
        if (running) return already(running);
        const idle = o["idle-minutes"] === undefined ? undefined : Number(o["idle-minutes"]);
        if (idle !== undefined && !(Number.isFinite(idle) && idle > 0)) return usage(io, "--idle-minutes must be a number of minutes above 0");
        let s: Running;
        try {
          s = await startServer(root, { port: o.port ? Number(o.port) : DEFAULT_PORT, idleMs: idle ? idle * 60_000 : undefined });
        } catch (e) {
          // Another server won the race between the check above and our start.
          if (e instanceof AlreadyRunningError) return already(e.url);
          throw e;
        }
        io.out(`Rushes is running for ${root}\n${s.dashboardUrl}`);
        show(s.dashboardUrl);
        if (io.onServer) return io.onServer(s), 0;
        // Exit once the server closes for any reason: a signal, `rushes stop`, or the idle timer.
        void s.closed.then(() => process.exit(0));
        const stopSig = () => void s.close();
        process.once("SIGINT", stopSig);
        process.once("SIGTERM", stopSig);
        return 0;
      }
      case "stop": {
        const root = await canonicalRoot(resolve(io.cwd, rest[0] ?? "."));
        const url = await findServer(root);
        if (!url) return io.out(`Rushes isn't running for ${root}`), 0;
        await new RushesClient(url).post("/api/shutdown", {});
        io.out(`Stopped Rushes for ${root}`);
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
        const root = rest[0] ? resolve(io.cwd, rest[0]) : dir;
        const { tabs } = await (await ensureServer(root, io.ensure)).get("/api/tabs");
        for (const t of tabs as { stage: string; unlocked: boolean; todo: number }[]) {
          io.out(`${t.stage.padEnd(8)} ${t.unlocked ? "open  " : "locked"} ${t.todo ? `${t.todo} to do` : ""}`.trimEnd());
        }
        return 0;
      }
      case "add": {
        const [what, a, b] = rest;
        if (what === "version") {
          if (!a || !o.video) return usage(io, "rushes add version <file> --video NAME");
          const r = await (await client()).post("/api/versions", { video: o.video, file: resolve(io.cwd, a), note: o.note });
          io.out(`Added ${r.video.name} ${r.version.id}`);
          return 0;
        }
        if (what === "variant") {
          if (!a || !b || !o.name) return usage(io, "rushes add variant <music|sfx|voice> <file> --name NAME");
          const r = await (await client()).post("/api/variants", { stage: a, file: resolve(io.cwd, b), name: o.name, lane: o.lane });
          io.out(`Added ${r.lane.name}: ${r.variant.name}`);
          return 0;
        }
        if (what === "shots") {
          if (!a || !o.video) return usage(io, "rushes add shots <file.json> --video NAME [--version V]");
          // Read and parse the file before touching the server, so a bad file is always exit 2,
          // never masked by a server-reachability error.
          let shots: unknown;
          try {
            shots = JSON.parse(await readFile(resolve(io.cwd, a), "utf8"));
          } catch (e) {
            io.err(`Couldn't read shots from "${a}": ${(e as Error).message}`);
            return 2;
          }
          const r = await (await client()).put(`/api/videos/${encodeURIComponent(o.video)}/shots`, { version: b, shots });
          io.out(`Shots set on ${o.video} ${r.version.id}: ${r.version.shots.length}`);
          return 0;
        }
        return usage(io, "rushes add version|variant|shots ...");
      }
      case "lock": {
        const [video, lockVersion] = rest;
        if (!video || !lockVersion) return usage(io, "rushes lock <video> <version>");
        await (await client()).put(`/api/videos/${encodeURIComponent(video)}/lock`, { version: lockVersion });
        io.out(`Picture locked at ${lockVersion}`);
        return 0;
      }
      case "unlock": {
        const [video] = rest;
        if (!video) return usage(io, "rushes unlock <video>");
        await (await client()).put(`/api/videos/${encodeURIComponent(video)}/lock`, { version: null });
        io.out("Picture unlocked");
        return 0;
      }
      case "notes": {
        const q = new URLSearchParams();
        for (const k of ["stage", "status", "batch"] as const) if (o[k]) q.set(k, o[k]!);
        const { notes } = await (await client()).get(`/api/notes${q.size ? `?${q}` : ""}`);
        if (o.json) return io.out(JSON.stringify(notes, null, 2)), 0;
        for (const n of notes) {
          const shot = n.shot ? `shot ${String(n.shot.n).padStart(2, "0")} ` : "";
          io.out(`${n.id}  ${n.status === "done" ? "done" : "todo"}  ${n.stage.padEnd(7)} ${when(n).padEnd(17)} ${shot}${n.text}`);
        }
        if (!notes.length) io.out("No notes");
        return 0;
      }
      case "reply": {
        const [id, ...words] = rest;
        const replyUsage = "rushes reply <note-id> <text> [--done] [--fix-t SECONDS] [--fix-version V]";
        if (!id || !words.length) return usage(io, replyUsage);
        const fixT = o["fix-t"] === undefined ? undefined : o["fix-t"].trim() === "" ? NaN : Number(o["fix-t"]);
        if (fixT !== undefined && !(Number.isFinite(fixT) && fixT >= 0)) {
          io.err(`--fix-t must be a number of seconds, 0 or more (got "${o["fix-t"]}")`);
          return usage(io, replyUsage);
        }
        const reply = {
          id,
          reply: words.join(" "),
          ...(o.done ? { status: "done" } : {}),
          ...(fixT !== undefined ? { fixT } : {}),
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
  // Round to hundredths first, so 59.999 becomes 1:00.00 rather than 0:60.00.
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = ((cs - m * 6000) / 100).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

function when(n: { scope: string; t: number | null; tOut: number | null }): string {
  if (n.scope === "whole" || n.t === null) return "whole";
  return n.scope === "range" && n.tOut !== null ? `${fmt(n.t)}–${fmt(n.tOut)}` : fmt(n.t);
}
