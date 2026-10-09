import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Store } from "../core/store.js";
import { ffmpegRunner, makeDemo, sayAvailable, sayRunner } from "./demo.js";
import { startServer, DEFAULT_PORT, type Running } from "../server/start.js";
import { ensureServer, findServer, type EnsureOptions } from "../mcp/ensure.js";
import { AlreadyRunningError, canonicalRoot } from "../server/lock.js";
import { ApiError, RushesClient, dashboardUrlFor } from "../mcp/client.js";
import { openBrowser, runStdio } from "../mcp/stdio.js";
import { VERSION } from "../server/app.js";
import { BRING_IN_MAX } from "../server/found.js";
import { LABEL_MAX, oneLineOf } from "../core/labels.js";
import { LOG_AREAS, LOG_MAX, areaWord, byWord, localStamp, logMarkdown, type LogArea, type LogLine, type UndatedLine } from "../core/logText.js";
import { markLabel, type Mark, type Note, type Project } from "../core/schema.js";
import { formatTag } from "../core/formats.js";
import { onLabel, type OnContext } from "../core/notes.js";
import { setup, type SetupEnv } from "../setup/setup.js";
import { realSetupEnv } from "../setup/env.js";
import { HARNESS_IDS, type HarnessId } from "../setup/harnesses.js";
import { runDoctor, realDoctorEnv, type DoctorEnv } from "./doctor.js";

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
  /** Environment for `rushes doctor`. Tests pass a fake Node version, PATH and home. */
  doctorEnv?: DoctorEnv;
}

export const HELP = `rushes ${VERSION}: a local review desk for video made with AI agents

Usage
  rushes open [dir] [--film NAME] [--port 4580] [--no-browser]
                                                    start the review desk, bring in the files that go with the cut, and open it
  rushes serve [dir] [--port 4580] [--idle-minutes N]
                                                    start the server without a browser (stops after N idle minutes)
  rushes stop [dir]                                 stop the project's running server
  rushes init [dir] [--name NAME]                  create the .rushes folder
  rushes demo [dir] [--no-browser]                  create an example project with generated media (default ./rushes-demo), then open it
  rushes setup [--only claude-code,codex,...] [--dry-run]
                                                    add Rushes to every agent harness on this machine
  rushes mcp                                        run the MCP server over stdio
  rushes status [dir]                               tabs and open items
  rushes doctor [dir] [--json]                      check Node, ffmpeg, agent harnesses and this project
  rushes add version <file> --video NAME [--label TEXT] [--note TEXT]
                                                    --label: the cut's short label in the version list (48 characters)
  rushes add format <file> [--video NAME] [--version V] [--label RATIO]
                                                    register another shape (aspect ratio) of a cut;
                                                    --label here is only a ratio hint such as 2.39:1, not the cut's label
  rushes add variant <music|sfx|voice> <file> --name NAME [--lane ID] [--round NAME] [--description TEXT]
  rushes add shots <file.json> --video NAME [--version V]
  rushes add file <path> --kind K [--name NAME] [--note TEXT] [--video V]
                                                    register a doc, image, caption, export, delivery or edit file
  rushes lock <video> <version>                     lock the picture at a cut
  rushes unlock <video>                             unlock the picture
  rushes notes [--stage S] [--status todo|done] [--batch ID] [--json]
  rushes reply <note-id> <text> [--done] [--fix-t SECONDS] [--fix-version V]
  rushes assets [--kind K] [--json]                 cuts, takes, variants, screenshots and library files
  rushes scan [--film NAME] [--json]                look through the folder for the files that go with the cut; also brings in the current set
  rushes bring-in <file>... [--kind voice|music|sfx|cut|doc] [--round NAME] [--film NAME]
                                                    register files from inside the project folder (nothing is picked);
                                                    exits 1 if any file can't come in
  rushes export notes                               write notes and the Change Log to exports/<slug>-notes-<date>.md
                                                    and exports/change-log-<date>.md
  rushes log [--limit N] [--area A] [--md]          the Change Log, newest first (--md: as Markdown)
  rushes log add <text> [--area A]                  add a line to the Change Log
                                                    flags first; text that starts with "-" goes after --:
                                                    rushes log add --area mix -- "-3 dB on the bed"

Options
  --dir DIR   project folder (default: current folder); where a command takes [dir], that wins
`;

const OPTIONS = {
  port: { type: "string" },
  "no-browser": { type: "boolean" },
  name: { type: "string" },
  video: { type: "string" },
  note: { type: "string" },
  // Two meanings by command: `add version --label` is the cut's short label (§22.4);
  // `add format --label` is a name for the ratio, such as 9:16 (§21.4). One option, read per command.
  label: { type: "string" },
  lane: { type: "string" },
  round: { type: "string" },
  description: { type: "string" },
  stage: { type: "string" },
  status: { type: "string" },
  batch: { type: "string" },
  kind: { type: "string" },
  film: { type: "string" },
  limit: { type: "string" },
  area: { type: "string" },
  md: { type: "boolean" },
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

// "demo" is here too: without --no-browser it ends by running "open" (a server that keeps
// running), so index.ts must not process.exit() the moment main() first resolves. With
// --no-browser nothing is left open, so the process still exits on its own once main() resolves.
const LONG_RUNNING = ["open", "serve", "mcp", "demo"];

/** Does this command line start something that keeps running (open, serve, mcp, demo)? Flags before the command are skipped. */
export function longRunningCommand(argv: string[]): boolean {
  try {
    const [cmd] = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }).positionals;
    return LONG_RUNNING.includes(cmd ?? "");
  } catch {
    return false;
  }
}

const STRING_OPTIONS = new Set(Object.entries(OPTIONS).filter(([, def]) => def.type === "string").map(([name]) => name));

/**
 * The index of the first positional, tolerant of leading global flags. A hand-rolled scan
 * rather than a `parseArgs` probe, because `--version=<value>` must be recognised here even
 * though `version` is declared boolean (parseArgs would throw on that combination, and we need
 * this to succeed precisely so we can strip that flag out before the real parse).
 */
function firstPositionalIndex(argv: string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") return i + 1 < argv.length ? i + 1 : -1;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq >= 0 ? tok.slice(2, eq) : tok.slice(2);
      if (eq < 0 && STRING_OPTIONS.has(name)) i++; // takes the next token as its value
      continue;
    }
    if (tok.startsWith("-") && tok.length > 1) continue; // a short flag; none of ours take a value
    return i;
  }
  return -1;
}

/** The command name (first positional), tolerant of leading global flags. */
function firstPositional(argv: string[]): string | undefined {
  const i = firstPositionalIndex(argv);
  return i >= 0 ? argv[i] : undefined;
}

/**
 * `rushes add shots` has its own `--version <value>` / `--version=<value>`, which takes a value
 * and can appear in any position. That collides with the global `--version`/`-v` flag, which
 * `node:util parseArgs` only knows how to treat as boolean (no subcommand, "print the package
 * version"): with one flat option table, `--version v2` ahead of the file name would otherwise
 * parse as `{version: true}` plus a stray positional, scrambling positional order. So for
 * `add ...`, pull the flag and its value out of argv textually before parseArgs ever sees it.
 */
function extractAddVersionFlag(argv: string[]): { value: string | undefined; rest: string[]; missing?: true } {
  const rest = [...argv];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--version" || tok === "-v") {
      const value = rest[i + 1];
      // A bare --version (last, or followed by another flag) has no value: say so rather than eat the next flag.
      if (value === undefined || value.startsWith("-")) return { value: undefined, rest, missing: true };
      rest.splice(i, 2);
      return { value, rest };
    }
    if (tok.startsWith("--version=")) {
      const value = tok.slice("--version=".length);
      if (!value) return { value: undefined, rest, missing: true };
      rest.splice(i, 1);
      return { value, rest };
    }
  }
  return { value: undefined, rest };
}

/** Run the CLI. Returns an exit code. Long-running commands (open, serve, mcp) resolve once started. */
export async function main(argv: string[], io: Io): Promise<number> {
  // The "add" command gets its own --version <value> pulled out before the real parse (see
  // extractAddVersionFlag); every other command's --version/-v stays the global boolean flag.
  // Only the tokens after "add" itself are scanned for it: `rushes -v add ...` has its own
  // leading -v ahead of the positional, which must keep meaning the global version flag, not
  // be eaten as the add command's --version value (and "add" itself mistaken for that value).
  let addVersion: string | undefined;
  const addAt = firstPositionalIndex(argv);
  if (addAt >= 0 && argv[addAt] === "add") {
    const extracted = extractAddVersionFlag(argv.slice(addAt + 1));
    if (extracted.missing) return usage(io, "--version needs a value, e.g. --version v2");
    addVersion = extracted.value;
    argv = [...argv.slice(0, addAt + 1), ...extracted.rest];
  }
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
        // The folder is the argument, or --dir, or the current folder: `status` and `doctor` already read it so.
        const root = await canonicalRoot(rest[0] ? resolve(io.cwd, rest[0]) : dir);
        const show = (url: string) => {
          if (cmd === "open" && !o["no-browser"]) (io.openBrowser ?? openBrowser)(url);
        };
        // §20.1: opening looks through the folder and brings in the current set, then says what it did.
        // The desk is open either way, so a scan that fails says nothing.
        const lookThrough = async (url: string) => {
          if (cmd !== "open") return;
          io.err(LOOKING);
          try {
            const r = await new RushesClient(url).post("/api/found/scan", { wait: true, ...(o.film ? { film: o.film } : {}) });
            if (r.added?.length) io.out(broughtLine(r.added));
            const left = foundTotal(r.found);
            if (left) io.out(`Found, left for you: ${count(left, "file")} \u2014 open Assets \u203a Found.`);
          } catch {
            // Nothing to add to the line above.
          }
        };
        const already = async (url: string) => {
          const dashboardUrl = await dashboardUrlFor(url);
          io.out(`Rushes is already running for ${root}\n${dashboardUrl}`);
          show(dashboardUrl);
          await lookThrough(url);
          return 0;
        };
        const running = await findServer(root);
        if (running) return already(running);
        const idle = o["idle-minutes"] === undefined ? undefined : Number(o["idle-minutes"]);
        if (idle !== undefined && !(Number.isFinite(idle) && idle > 0)) return usage(io, "--idle-minutes must be a number of minutes above 0");
        const port = o.port ? Number(o.port) : DEFAULT_PORT;
        if (!Number.isInteger(port) || port < 0 || port > 65535) return usage(io, "--port must be a whole number from 0 to 65535");
        let s: Running;
        try {
          s = await startServer(root, { port, idleMs: idle ? idle * 60_000 : undefined });
        } catch (e) {
          // Another server won the race between the check above and our start.
          if (e instanceof AlreadyRunningError) return already(e.url);
          throw e;
        }
        io.out(`Rushes is running for ${root}\n${s.dashboardUrl}`);
        show(s.dashboardUrl);
        if (io.onServer) {
          io.onServer(s);
        } else {
          // Exit once the server closes for any reason: a signal, `rushes stop`, or the idle timer.
          void s.closed.then(() => process.exit(0));
          const stopSig = () => void s.close();
          process.once("SIGINT", stopSig);
          process.once("SIGTERM", stopSig);
        }
        await lookThrough(s.url);
        return 0;
      }
      case "stop": {
        const root = await canonicalRoot(rest[0] ? resolve(io.cwd, rest[0]) : dir);
        const url = await findServer(root);
        if (!url) return io.out(`Rushes isn't running for ${root}`), 0;
        await new RushesClient(url).post("/api/shutdown", {});
        io.out(`Stopped Rushes for ${root}`);
        return 0;
      }
      case "init": {
        const root = rest[0] ? resolve(io.cwd, rest[0]) : dir;
        await new Store(root).init(o.name ?? basename(root));
        io.out(`Created ${root}/.rushes`);
        return 0;
      }
      case "demo": {
        const target = resolve(io.cwd, rest[0] ?? "rushes-demo");
        const say = (await sayAvailable(sayRunner)) ? sayRunner : null;
        const { dir } = await makeDemo(target, { ffmpeg: ffmpegRunner, say, now: new Date() });
        io.out(`Created ${dir}`);
        // §19.2: opens it, same as `rushes open`, unless told not to -- "demo" is in LONG_RUNNING
        // precisely so this nested server (when it starts) keeps the process alive.
        if (o["no-browser"]) return 0;
        return main(["open", dir], io);
      }
      case "setup": {
        const named = o.only ? o.only.split(",").map((x) => x.trim()).filter(Boolean) : undefined;
        const unknown = named?.filter((x) => !(HARNESS_IDS as readonly string[]).includes(x));
        if (unknown?.length) return usage(io, `--only takes ${HARNESS_IDS.join(", ")}; ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not one`);
        const only = named as HarnessId[] | undefined;
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
      case "doctor": {
        const root = rest[0] ? resolve(io.cwd, rest[0]) : dir;
        const checks = await runDoctor(io.doctorEnv ?? realDoctorEnv(root));
        if (o.json) {
          io.out(JSON.stringify(checks, null, 2));
        } else {
          for (const c of checks) {
            const fix = !c.ok && c.fix ? ` Fix: ${c.fix}` : "";
            io.out(`${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}${fix}`);
          }
        }
        return checks.some((c) => c.required && !c.ok) ? 1 : 0;
      }
      case "add": {
        const [what, a, b] = rest;
        if (what === "version") {
          if (!a || !o.video) return usage(io, "rushes add version <file> --video NAME");
          // The server refuses a longer label too, but only in a generic "Request body is invalid".
          if (o.label !== undefined && Array.from(oneLineOf(o.label)).length > LABEL_MAX) {
            io.err(`label is ${LABEL_MAX} characters at most: put the detail in note`);
            return 2;
          }
          const r = await (await client()).post("/api/versions", { video: o.video, file: resolve(io.cwd, a), note: o.note, label: o.label });
          io.out(`Added ${r.video.name} ${r.version.id}`);
          // A Rushes started by an older version ignores `label` and its reply has none.
          if (o.label?.trim() && r.version.label === undefined) io.err("An older Rushes is running and dropped the label: the cut was added without it. Run `rushes stop`, then open again.");
          // §19.5: the server says when this cut is likely to play badly in a browser.
          if (r.proxySuggested) io.out(`Proxy suggested: ${r.proxyReason}.${r.proxyJob ? " Making one now (autoProxy is on)." : " Create one from Picture."}`);
          return 0;
        }
        if (what === "format") {
          if (!a) return usage(io, "rushes add format <file> [--video NAME] [--version V] [--label RATIO]");
          const r = await (await client()).post("/api/formats", { file: resolve(io.cwd, a), video: o.video, version: addVersion, label: o.label });
          io.out(`Added ${r.format.label} to ${r.video.name} ${r.version.id}`);
          if (r.warning) io.out(`Warning: ${r.warning}`);
          if (r.labelNote) io.out(`Label: ${r.labelNote}`);
          return 0;
        }
        if (what === "variant") {
          if (!a || !b || !o.name) return usage(io, "rushes add variant <music|sfx|voice> <file> --name NAME");
          const r = await (await client()).post("/api/variants", { stage: a, file: resolve(io.cwd, b), name: o.name, lane: o.lane, round: o.round, description: o.description });
          io.out(`Added ${r.lane.name}: ${r.variant.name}`);
          return 0;
        }
        if (what === "shots") {
          if (!a || !o.video) return usage(io, "rushes add shots <file.json> --video NAME [--version V]");
          // Read and parse the file before touching the server, so a bad file is always exit 2,
          // never masked by a server-reachability error.
          let parsed: unknown;
          try {
            parsed = JSON.parse(await readFile(resolve(io.cwd, a), "utf8"));
          } catch (e) {
            io.err(`Couldn't read shots from "${a}": ${(e as Error).message}`);
            return 2;
          }
          // Either a bare array, or an object wrapping one under "shots" (the shape rushes_set_shots
          // takes, so a file saved from its reply round-trips straight back in).
          const shots = Array.isArray(parsed)
            ? parsed
            : Array.isArray((parsed as { shots?: unknown } | null)?.shots)
              ? (parsed as { shots: unknown[] }).shots
              : undefined;
          if (shots === undefined) {
            io.err('shots file must be a JSON array of {name, start, tag?} (or {"shots": [...]})');
            return 2;
          }
          const r = await (await client()).put(`/api/videos/${encodeURIComponent(o.video)}/shots`, { version: addVersion, shots });
          io.out(`Shots set on ${o.video} ${r.version.id}: ${r.version.shots.length}`);
          return 0;
        }
        if (what === "file") {
          if (!a || !o.kind) return usage(io, "rushes add file <path> --kind K [--name NAME] [--note TEXT] [--video V]");
          const r = await (await client()).post("/api/files", { kind: o.kind, file: resolve(io.cwd, a), name: o.name, note: o.note, video: o.video });
          io.out(`Added ${r.kind}: ${r.name}`);
          return 0;
        }
        return usage(io, "rushes add version|format|variant|shots|file ...");
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
        const c = await client();
        const { notes } = await c.get(`/api/notes${q.size ? `?${q}` : ""}`);
        if (o.json) return io.out(JSON.stringify(notes, null, 2)), 0;
        // What an audio note is on (M4) and a Picture note's format (§21.4, R4), from the state.
        const state: (OnContext & { project: Project }) | null = (notes as Note[]).some((n) => n.stage !== "script") ? await c.get("/api/state") : null;
        for (const n of notes) {
          const label = state ? onLabel(n, state) : null;
          const on = label ? `${stripControl(label)}  ` : "";
          const tag = state ? formatTag(n, state.project?.videos ?? []) : null;
          const fmtCol = tag ? `${stripControl(tag)}  ` : "";
          const shot = n.shot ? `shot ${String(n.shot.n).padStart(2, "0")} ` : "";
          const marks = (n.marks as Mark[] | undefined)?.length ? `${(n.marks as Mark[]).map(markLabel).join(" · ")}  ` : "";
          io.out(`${n.id}  ${n.status === "done" ? "done" : "todo"}  ${n.stage.padEnd(7)} ${when(n).padEnd(17)} ${fmtCol}${on}${marks}${shot}${n.text}`);
        }
        if (!notes.length) io.out("No notes");
        return 0;
      }
      case "assets": {
        const q = o.kind ? `?kind=${encodeURIComponent(o.kind)}` : "";
        const { assets } = await (await client()).get(`/api/assets${q}`);
        if (o.json) return io.out(JSON.stringify(assets, null, 2)), 0;
        for (const a of assets as { kind: string; path: string; size: number | null; missing: boolean }[]) {
          io.out(`${a.kind.padEnd(10)} ${stripControl(a.path)} ${a.missing ? "missing" : humanSize(a.size ?? 0)}`);
        }
        if (!assets.length) io.out("No assets");
        return 0;
      }
      case "scan": {
        const c = await client();
        io.err(LOOKING);
        const r = await c.post("/api/found/scan", { wait: true, ...(o.film ? { film: o.film } : {}) });
        const { files } = await c.get<{ files: FoundRow[] }>("/api/found");
        if (o.json) return io.out(JSON.stringify({ files, counts: r.found ?? null, broughtIn: r.added ?? [], alreadyIn: r.alreadyIn ?? [], failed: r.failed ?? [], ...(r.scanning ? { scanning: true } : {}) }, null, 2)), 0;
        if (r.added?.length) io.out(broughtLine(r.added));
        const left = foundTotal(r.found);
        if (!left && !r.added?.length) return io.out("Nothing found in this folder."), 0;
        if (left) {
          const kinds = (Object.entries(r.found) as [string, number][]).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k === "cut" && n !== 1 ? "cuts" : k}`);
          io.out(`Found, left for you: ${count(left, "file")} (${kinds.join(", ")})`);
          for (const f of files.slice(0, SCAN_ROWS)) {
            const why = f.reasons.length ? `  ${stripControl(f.reasons.join(" \u00b7 "))}` : "";
            io.out(`  ${f.kind.padEnd(6)} ${f.score === null ? "-" : String(f.score)}  ${stripControl(f.path)}${why}`);
          }
          if (files.length > SCAN_ROWS) io.out(`  and ${files.length - SCAN_ROWS} more (rushes scan --json lists them all)`);
        }
        return 0;
      }
      case "bring-in": {
        const bringInUsage = "rushes bring-in <file>... [--kind voice|music|sfx|cut|doc] [--round NAME]";
        if (!rest.length) return usage(io, bringInUsage);
        if (o.kind !== undefined && !["voice", "music", "sfx", "cut", "doc"].includes(o.kind)) {
          io.err(`--kind must be voice, music, sfx, cut or doc (got "${o.kind}")`);
          return usage(io, bringInUsage);
        }
        if (rest.length > BRING_IN_MAX) {
          io.err(`Up to ${BRING_IN_MAX} files at a time (and 12 of a kind), so the tabs stay quick. You gave ${rest.length}: bring the rest in with a second command.`);
          return usage(io, bringInUsage);
        }
        // Paths are taken from the folder the command runs in; the server checks they're inside the project.
        const files = rest.map((f) => ({ path: resolve(io.cwd, f), ...(o.kind ? { kind: o.kind } : {}), ...(o.round ? { round: o.round } : {}) }));
        const r = await (await client()).post("/api/found/bring-in", { files, ...(o.film ? { film: o.film } : {}) });
        for (const a of r.added as { path: string; kind: string }[]) io.out(`Brought in: ${stripControl(a.path)} (${a.kind})`);
        for (const f of r.failed as { path: string; reason: string }[]) io.err(`Not brought in: ${stripControl(f.path)}: ${f.reason}`);
        return r.failed.length ? 1 : 0;
      }
      case "export": {
        const [what] = rest;
        if (what !== "notes") return usage(io, "rushes export notes");
        const r = await (await client()).post("/api/exports/notes", {});
        io.out(`Exported notes to ${r.path}`);
        if (r.changeLog) io.out(`Exported the Change Log to ${r.changeLog}`);
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
      case "log": {
        const logUsage = "rushes log [--limit N] [--area A] [--md] | rushes log add <text> [--area A]";
        const [what, ...words] = rest;
        const area = o.area;
        if (area !== undefined && !(LOG_AREAS as readonly string[]).includes(area)) {
          io.err(`--area must be one of ${LOG_AREAS.join(", ")} (got "${area}")`);
          return usage(io, logUsage);
        }
        if (what === "add") {
          const text = words.join(" ").trim();
          if (!text) return usage(io, 'rushes log add "text" [--area A]');
          const r = await (await client()).post("/api/log", { text, ...(area ? { area } : {}) });
          io.out(`Added to the Change Log: ${stripControl(r.entry.text)}`);
          return 0;
        }
        if (what !== undefined) return usage(io, logUsage);
        const limit = o.limit === undefined ? (o.md ? LOG_MAX : 30) : /^\d+$/.test(o.limit) ? Number(o.limit) : NaN;
        if (!(Number.isInteger(limit) && limit >= 1 && limit <= LOG_MAX)) {
          io.err(`--limit must be a whole number from 1 to ${LOG_MAX} (got "${o.limit}")`);
          return usage(io, logUsage);
        }
        const c = await client();
        const q = new URLSearchParams({ limit: String(limit) });
        if (area) q.set("area", area);
        const view = await c.get<{ entries: LogLine[]; earlier: number; undated: UndatedLine[]; dropped: number }>(`/api/log?${q}`);
        if (o.md) {
          const { name } = await c.get<{ name: string }>("/api/health");
          io.out(logMarkdown({ project: name, entries: view.entries, undated: view.undated, dropped: view.dropped, earlier: view.earlier, ...(area ? { area: area as LogArea } : {}), now: new Date() }).trimEnd());
          return 0;
        }
        if (!view.entries.length && !view.undated.length) return io.out(area ? `Nothing in ${areaWord(area)} yet.` : "Nothing in the Change Log yet."), 0;
        for (const e of view.entries) io.out(`${localStamp(new Date(e.at))}  ${stripControl(areaWord(e.area)).padEnd(13)} ${stripControl(oneLineOf(e.text))}  (${stripControl(byWord(e.by))})`);
        if (view.earlier) io.out(`${view.earlier} earlier (rushes log --limit ${Math.min(LOG_MAX, limit + view.earlier)}${area ? ` --area ${area}` : ""} shows them)`);
        if (view.undated.length) {
          io.out("Before the log:");
          for (const u of view.undated) io.out(`  ${stripControl(oneLineOf(u.text))}`);
        }
        if (view.dropped) io.out("Earlier entries were removed.");
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

/** Said on stderr while a scan is waited on, which can take several seconds on a big folder. */
const LOOKING = "Looking through the folder\u2026";

/** How many candidate rows `rushes scan` prints; --json has them all. */
const SCAN_ROWS = 10;

interface FoundRow {
  path: string;
  kind: string;
  score: number | null;
  reasons: string[];
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Everything a scan left, by kind, as one number. */
function foundTotal(counts: Record<string, number> | null | undefined): number {
  return Object.values(counts ?? {}).reduce((sum, n) => sum + n, 0);
}

/** "Brought in: a.wav (voice), b.wav (music)", the first few and then how many more. */
function broughtLine(added: { path: string; kind: string }[]): string {
  const shown = added.slice(0, 6).map((a) => `${stripControl(a.path)} (${a.kind})`);
  const more = added.length > 6 ? `, and ${added.length - 6} more` : "";
  return `Brought in: ${shown.join(", ")}${more}`;
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

/** 1536 -> "1.5 KB". Bytes under 1 KB print as a whole number of bytes. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

/** Drops C0 control characters (U+0000-U+001F), DEL (U+007F) and the C1 ones (U+0080-U+009F, among them
 *  the single-character CSI, U+009B) from a name or path before it
 *  reaches a terminal (M5): an odd hand-edit or agent mistake could otherwise move the cursor,
 *  clear the line, or ring the bell when `rushes assets` prints it. --json is untouched -- a
 *  consumer parsing JSON gets the real value, control characters and all. */
function stripControl(s: string): string {
  // eslint-disable-next-line no-control-regex -- the whole point is to match control characters.
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function when(n: { scope: string; t: number | null; tOut: number | null }): string {
  if (n.scope === "whole" || n.t === null) return "whole";
  return n.scope === "range" && n.tOut !== null ? `${fmt(n.t)}–${fmt(n.tOut)}` : fmt(n.t);
}
