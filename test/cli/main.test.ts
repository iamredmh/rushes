import { describe, expect, it } from "vitest";
import { access, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { main, longRunningCommand } from "../../src/cli/main.js";
import { findServer } from "../../src/mcp/ensure.js";
import { startServer, type Running } from "../../src/server/start.js";
import { addVersion } from "../../src/core/project.js";
import { lockPath } from "../../src/server/lock.js";
import { sizedProbe } from "../helpers/probe.js";
import { io } from "../helpers/cli.js";

describe("cli", () => {
  it("prints help with no command, and exits 2 on an unknown one", async () => {
    const a = io("/tmp");
    expect(await main([], a.x)).toBe(0);
    expect(a.out.join("\n")).toContain("rushes open [dir]");
    expect(a.out.join("\n")).toContain("add shots");
    expect(a.out.join("\n")).toContain("rushes lock");
    expect(a.out.join("\n")).toContain("rushes unlock");
    // The description column lines up across every usage line, including "unlock".
    const lines = a.out.join("\n").split("\n");
    const lockLine = lines.find((l) => l.includes("rushes lock "))!;
    const unlockLine = lines.find((l) => l.includes("rushes unlock"))!;
    const descColumn = (line: string) => {
      let last = -1;
      for (const m of line.matchAll(/ {2,}\S/g)) last = m.index + m[0].length - 1;
      return last;
    };
    expect(descColumn(unlockLine)).toBe(descColumn(lockLine));
    const b = io("/tmp");
    expect(await main(["frobnicate"], b.x)).toBe(2);
    expect(b.err[0]).toContain('Unknown command "frobnicate"');
  });

  it("--version still prints the package version when no command is given", async () => {
    const a = io("/tmp");
    expect(await main(["--version"], a.x)).toBe(0);
    expect(a.out).toHaveLength(1);
  });

  it("-v still prints the version, even with a global --dir ahead of it", async () => {
    const a = io("/tmp");
    expect(await main(["-v"], a.x)).toBe(0);
    expect(a.out).toHaveLength(1);
  });

  it("rushes -v add ... keeps -v as the global version flag, not the add command's version", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    await writeFile(join(root, "shots.json"), JSON.stringify([{ name: "Wide", start: 0 }]), "utf8");
    const a = io(root);
    // A leading -v, before the "add" positional, is the global version flag: harmless here,
    // since a command follows (see the comment above the `o.version` check). It must not be
    // read as add shots' own --version/-v, which would otherwise eat "add" itself as its
    // value and scramble the rest of the command into an unknown one.
    expect(await main(["-v", "add", "shots", "shots.json", "--video", "hero"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Shots set on hero v1: 1");
    await s.close();
  });

  it("--dir ahead of add shots doesn't confuse the add command's own --version", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    await writeFile(join(root, "shots.json"), JSON.stringify([{ name: "Wide", start: 0 }]), "utf8");
    const a = io(root);
    expect(await main(["--dir", root, "add", "shots", "shots.json", "--video", "hero", "--version", "v1"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Shots set on hero v1: 1");
    await s.close();
  });

  it("init creates the .rushes folder in a path with spaces", async () => {
    const { root } = await tmpProject();
    const target = join(root, "Second Film");
    const a = io(root);
    expect(await main(["init", "Second Film"], a.x)).toBe(0);
    await access(join(target, ".rushes", "project.json"));
  });

  it("add, notes and reply talk to the running server", async () => {
    const { root } = await tmpProject("spring-launch");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "renders/hero v1.mp4", "--video", "Hero 60s"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Added Hero 60s v1");
    expect(await main(["add", "variant", "music", "audio/a.wav", "--name", "Deep house"], a.x)).toBe(0);

    const note = (await (await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", scope: "range", t: 31.05, tOut: 33.1, text: "Too fast" }),
    })).json()).note;

    const b = io(root);
    expect(await main(["notes", "--stage", "picture"], b.x)).toBe(0);
    expect(b.out[0]).toContain("0:31.05–0:33.10");
    expect(b.out[0]).toContain("Too fast");

    const c = io(root);
    expect(await main(["reply", note.id, "Slowed", "to", "2.4", "s", "--done", "--fix-t", "31.4"], c.x)).toBe(0);
    const d = io(root);
    await main(["notes", "--json"], d.x);
    expect(JSON.parse(d.out[0])[0]).toMatchObject({ reply: "Slowed to 2.4 s", status: "done", fixT: 31.4 });

    const e = io(root);
    await main(["status"], e.x);
    expect(e.out.find((l) => l.startsWith("picture"))).toMatch(/open/);
    await s.close();
  });

  it("add variant --round posts the round name, naming the lane for it (§18.4)", async () => {
    const { root } = await tmpProject("spring-launch");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "variant", "voice", "audio/g.wav", "--name", "Gerald", "--round", "Round 1 · Voices"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Added Round 1 · Voices: Gerald");
    await s.close();
  });

  it("add variant --description stores the one-line description as meta.description", async () => {
    const { root } = await tmpProject("spring-launch");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "variant", "voice", "audio/g.wav", "--name", "Gerald", "--round", "Round 1", "--description", "Warmer, slower intro"], a.x)).toBe(0);
    const project = JSON.parse(await readFile(join(root, ".rushes", "project.json"), "utf8"));
    expect(project.lanes[0].variants[0].meta).toEqual({ description: "Warmer, slower intro" });
    await s.close();
  });

  it("add shots reads a JSON file and sets the cut's shot list", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    await writeFile(join(root, "shots.json"), JSON.stringify([{ name: "Wide", start: 0 }, { name: "Logo", start: 5, tag: "brand" }]), "utf8");
    const a = io(root);
    expect(await main(["add", "shots", "shots.json", "--video", "hero", "--version", "v1"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Shots set on hero v1: 2");
    await s.close();
  });

  it("add shots takes --version <value> before the file name too, not just after", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    await writeFile(join(root, "shots.json"), JSON.stringify([{ name: "Wide", start: 0 }]), "utf8");
    const a = io(root);
    expect(await main(["add", "shots", "--version", "v1", "shots.json", "--video", "hero"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Shots set on hero v1: 1");
    await s.close();
  });

  it("add shots takes --version=<value> too", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    await writeFile(join(root, "shots.json"), JSON.stringify([{ name: "Wide", start: 0 }]), "utf8");
    const a = io(root);
    expect(await main(["add", "shots", "shots.json", "--video", "hero", "--version=v1"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Shots set on hero v1: 1");
    await s.close();
  });

  it("add shots refuses a --version with no value instead of eating the next flag", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    expect(await main(["add", "shots", "shots.json", "--version", "--video", "hero"], a.x)).toBe(2);
    expect(a.err.join("\n")).toContain("--version needs a value");
    expect(await main(["add", "shots", "shots.json", "--video", "hero", "--version"], a.x)).toBe(2);
    expect(await main(["add", "shots", "shots.json", "--video", "hero", "--version="], a.x)).toBe(2);
  });

  it("add shots takes -v <value> as the version too", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    await writeFile(join(root, "shots.json"), JSON.stringify([{ name: "Wide", start: 0 }]), "utf8");
    const a = io(root);
    expect(await main(["add", "shots", "shots.json", "--video", "hero", "-v", "v1"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Shots set on hero v1: 1");
    await s.close();
  });

  it("add shots accepts a shots file wrapped as {\"shots\": [...]}, not just a bare array", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    await writeFile(join(root, "shots.json"), JSON.stringify({ shots: [{ name: "Wide", start: 0 }] }), "utf8");
    const a = io(root);
    expect(await main(["add", "shots", "shots.json", "--video", "hero", "--version", "v1"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Shots set on hero v1: 1");
    await s.close();
  });

  it("add shots exits 2 with a clear message when the file is neither shape", async () => {
    const { root } = await tmpProject();
    await writeFile(join(root, "shots.json"), JSON.stringify({ name: "Wide", start: 0 }), "utf8");
    const a = io(root);
    expect(await main(["add", "shots", "shots.json", "--video", "Hero"], a.x)).toBe(2);
    expect(a.err[0]).toBe('shots file must be a JSON array of {name, start, tag?} (or {"shots": [...]})');
  });

  it("add shots exits 2 with a clear message on a missing file or invalid JSON", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    expect(await main(["add", "shots", "missing.json", "--video", "Hero"], a.x)).toBe(2);
    expect(a.err[0]).toContain("missing.json");

    await writeFile(join(root, "bad.json"), "{ not json", "utf8");
    const b = io(root);
    expect(await main(["add", "shots", "bad.json", "--video", "Hero"], b.x)).toBe(2);
    expect(b.err[0]).toContain("bad.json");
  });

  it("add shots needs --video", async () => {
    const { root } = await tmpProject();
    await writeFile(join(root, "shots.json"), "[]", "utf8");
    const a = io(root);
    expect(await main(["add", "shots", "shots.json"], a.x)).toBe(2);
    expect(a.err[0]).toContain("--video");
  });

  it("lock and unlock the picture", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    const a = io(root);
    expect(await main(["lock", "hero", "v1"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Picture locked at v1");
    const b = io(root);
    expect(await main(["unlock", "hero"], b.x)).toBe(0);
    expect(b.out.pop()).toBe("Picture unlocked");
    await s.close();
  });

  it("lock at a version that doesn't exist is a server 404 and exits 1", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    const a = io(root);
    expect(await main(["lock", "hero", "v9"], a.x)).toBe(1);
    expect(a.err[0]).toContain("v9");
    await s.close();
  });

  it("notes shows shot NN, zero-padded, after the timecode", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    await fetch(`${s.url}/api/videos/hero/shots`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shots: [{ name: "Wide", start: 0 }, { name: "Logo", start: 5 }] }),
    });
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", video: "hero", version: "v1", scope: "point", t: 6, text: "Too long" }),
    });
    const a = io(root);
    expect(await main(["notes", "--stage", "picture"], a.x)).toBe(0);
    expect(a.out[0]).toContain("shot 02");
    expect(a.out[0]).toContain("Too long");
    await s.close();
  });

  it("shows a note's marks (§17.7)", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage: "music",
        scope: "range",
        t: 12,
        tOut: 15,
        text: "Bring it down",
        marks: [{ kind: "fall" }, { kind: "quieter", db: 3 }],
      }),
    });
    const a = io(root);
    expect(await main(["notes", "--stage", "music"], a.x)).toBe(0);
    expect(a.out[0]).toContain("Fall · Quieter 3 dB");
    expect(a.out[0]).toContain("Bring it down");
    await s.close();
  });

  it("shows what an audio note is on: its lane and variant (M4)", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const post = (path: string, body: unknown) =>
      fetch(`${s.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("/api/variants", { stage: "music", name: "Warm keys", file: "audio/warm.wav" });
    await post("/api/notes", { stage: "music", on: "music/warm-keys", scope: "range", t: 12, tOut: 15, text: "Bring it down", marks: [{ kind: "fall" }] });
    const a = io(root);
    expect(await main(["notes", "--stage", "music"], a.x)).toBe(0);
    expect(a.out[0]).toContain("Music · Warm keys  Fall  Bring it down");
    await s.close();
  });

  it("carries 59.999 s into the next minute instead of printing 0:60.00", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stage: "picture", scope: "point", t: 59.999, text: "x" }),
    });
    const a = io(root);
    expect(await main(["notes", "--stage", "picture"], a.x)).toBe(0);
    expect(a.out[0]).toContain("1:00.00");
    await s.close();
  });

  it("explains missing arguments and server errors", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "x.mp4"], a.x)).toBe(2);
    expect(a.err[0]).toContain("--video");
    const b = io(root);
    expect(await main(["reply", "n_missing", "hello"], b.x)).toBe(1);
    expect(b.err[0]).toContain('note "n_missing" not found');
    await s.close();
  });

  it("open starts the server and opens the browser on the project's own dashboard address", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    let server: Running | undefined;
    a.x.onServer = (s) => { server = s; };
    expect(await main(["open", ".", "--port", "0"], a.x)).toBe(0);
    expect(a.opened).toEqual([server!.dashboardUrl]);
    expect(a.opened[0]).toMatch(/\/p\/[a-z2-9]{8}\/$/);
    const health = await (await fetch(`${server!.url}/api/health`)).json();
    expect(health.root).toBe(root);
    await server!.close();
  });

  it("open --no-browser prints the dashboard URL without opening it", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    let server: Running | undefined;
    a.x.onServer = (s) => { server = s; };
    expect(await main(["open", ".", "--port", "0", "--no-browser"], a.x)).toBe(0);
    expect(a.opened).toEqual([]);
    expect(a.out.join("\n")).toMatch(/\/p\/[a-z2-9]{8}\/$/);
    await server!.close();
  });

  it("open and serve reuse a server that is already running instead of starting another", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    let started: Running | undefined;
    a.x.onServer = (x) => { started = x; };
    expect(await main(["open", "."], a.x)).toBe(0);
    expect(a.out).toEqual([`Rushes is already running for ${root}\n${s.dashboardUrl}`]);
    expect(a.opened).toEqual([s.dashboardUrl]);
    const b = io(root);
    b.x.onServer = (x) => { started = x; };
    expect(await main(["serve", root], b.x)).toBe(0);
    expect(b.out).toEqual([`Rushes is already running for ${root}\n${s.dashboardUrl}`]);
    expect(b.opened).toEqual([]);
    expect(started).toBeUndefined();
    await s.close();
  });

  it("reply rejects a --fix-t that isn't a finite, non-negative number", async () => {
    const { root } = await tmpProject();
    for (const bad of ["abc", "-1", "Infinity", "NaN", ""]) {
      const a = io(root);
      expect(await main(["reply", "n_x", "hello", `--fix-t=${bad}`], a.x)).toBe(2);
      expect(a.err.join("\n")).toContain("--fix-t");
    }
  });

  it("finds the command after flags, so rushes --dir x mcp stays alive", () => {
    expect(longRunningCommand(["--dir", "x", "mcp"])).toBe(true);
    expect(longRunningCommand(["--port", "4400", "open", "."])).toBe(true);
    expect(longRunningCommand(["serve"])).toBe(true);
    expect(longRunningCommand(["--dir", "open", "status"])).toBe(false);
    expect(longRunningCommand(["notes", "--json"])).toBe(false);
    expect(longRunningCommand(["--bogus"])).toBe(false);
    expect(longRunningCommand([])).toBe(false);
  });

  it("assets lists one line per asset, and --json prints the raw list", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    });
    const a = io(root);
    expect(await main(["assets"], a.x)).toBe(0);
    expect(a.out[0]).toContain("cut");
    expect(a.out[0]).toContain("a.mp4");
    expect(a.out[0]).toContain("missing"); // a.mp4 was never written to disk
    const b = io(root);
    await main(["assets", "--json"], b.x);
    const parsed = JSON.parse(b.out[0]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ kind: "cut", video: "hero", version: "v1" });
    const c = io(root);
    await main(["assets", "--kind", "music"], c.x);
    expect(c.out[0]).toBe("No assets");
    await s.close();
  });

  it("add file registers a library file, listed by assets under its kind", async () => {
    const { root } = await tmpProject();
    await writeFile(join(root, "brief.md"), "# Brief");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "file", "brief.md", "--kind", "doc", "--name", "Creative brief", "--note", "v2"], a.x)).toBe(0);
    expect(a.out[0]).toBe("Added doc: Creative brief");
    const b = io(root);
    await main(["assets", "--kind", "doc", "--json"], b.x);
    const assets = JSON.parse(b.out[0]);
    // name is the file's own basename; the given display name goes in label (I2).
    expect(assets).toMatchObject([{ path: "brief.md", name: "brief.md", label: "Creative brief", note: "v2" }]);
    await s.close();
  });

  it("strips C0 and C1 control characters and DEL from paths in human-readable `assets` output, but not --json (M5)", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    // A bell and an ANSI escape, the kind of thing a hand-edited project.json could carry --
    // never something a terminal should be asked to act on.
    const evilPath = "notes\u0007\u001b[31m\u009b2J.md"; // a C1 control too: U+009B is one-character CSI (final review I3)
    await fetch(`${s.url}/api/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "doc", file: evilPath }),
    });
    const a = io(root);
    await main(["assets", "--kind", "doc"], a.x);
    // eslint-disable-next-line no-control-regex
    expect(a.out[0]).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(a.out[0]).toContain("notes");
    expect(a.out[0]).toContain(".md");

    const b = io(root);
    await main(["assets", "--kind", "doc", "--json"], b.x);
    const assets = JSON.parse(b.out[0]);
    expect(assets[0].path).toBe(evilPath);
    await s.close();
  });

  it("add file needs --kind", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "file", "brief.md"], a.x)).toBe(2);
    expect(a.err[0]).toContain("rushes add file");
    await s.close();
  });

  it("export notes writes the file and prints its path", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["export", "notes"], a.x)).toBe(0);
    expect(a.out[0]).toMatch(/^Exported notes to exports\/demo-notes-\d{4}-\d{2}-\d{2}\.md$/);
    const path = a.out[0].replace("Exported notes to ", "");
    await access(join(root, path));
    // Final review minor: the Change Log goes out with it, so the command says so.
    expect(a.out[1]).toMatch(/^Exported the Change Log to exports\/change-log-\d{4}-\d{2}-\d{2}\.md$/);
    await access(join(root, a.out[1].replace("Exported the Change Log to ", "")));
    const h = io(root);
    await main([], h.x);
    expect(h.out.join("\n")).toMatch(/rushes export notes +write notes and the Change Log to exports\//);
    await s.close();
  });

  it("status reads the project folder it is given", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    await (await fetch(`${s.url}/api/versions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ video: "Hero", file: "a.mp4" }),
    })).json();
    const { dirname } = await import("node:path");
    const a = io(dirname(root));
    expect(await main(["status", root], a.x)).toBe(0);
    expect(a.out.find((l) => l.startsWith("picture"))).toMatch(/open/);
    await s.close();
  });
});

describe("cli setup", () => {
  it("prints one line per harness and the restart hint", async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const home = await mkdtemp(join(tmpdir(), "rushes cli home "));
    await mkdir(join(home, ".cursor"));
    const skillFile = join(home, "s.md");
    await writeFile(skillFile, "x");
    const a = io(home);
    a.x.setupEnv = { home, platform: "linux", skillFile, which: async () => false, exec: async () => ({ code: 1, out: "" }) };
    expect(await main(["setup"], a.x)).toBe(0);
    expect(a.out.find((l) => l.startsWith("+ Cursor"))).toContain("added");
    expect(a.out.find((l) => l.startsWith("- Codex"))).toContain("not-found");
    expect(a.out.join("\n")).toContain('ask your agent to "open Rushes"');
    await rm(home, { recursive: true, force: true });
  });
});

describe("cli stop and idle", () => {
  it("stop asks the running server to shut down", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    let server: Running | undefined;
    a.x.onServer = (s) => { server = s; };
    expect(await main(["serve", ".", "--port", "0"], a.x)).toBe(0);
    const b = io(root);
    expect(await main(["stop"], b.x)).toBe(0);
    expect(b.out[0]).toContain("Stopped Rushes");
    await server!.closed;
    const c = io(root);
    expect(await main(["stop"], c.x)).toBe(0);
    expect(c.out[0]).toContain("isn't running");
  });

  it("rejects a bad --idle-minutes", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    expect(await main(["serve", ".", "--idle-minutes", "soon"], a.x)).toBe(2);
    expect(a.err[0]).toContain("--idle-minutes");
  });
});

describe("cli: rushes add version and proxies (§19.5)", () => {
  const prores4k = { duration: 2, fps: 25, codec: "prores", width: 3840, height: 2160, pixFmt: "yuv422p10le" };
  const h264 = { duration: 2, fps: 25, codec: "h264", width: 1920, height: 1080, pixFmt: "yuv420p" };
  const fakeFfmpeg = async (args: string[]) => {
    if (args[0] !== "-version") await writeFile(args[args.length - 1], "proxy");
    return { code: 0, stderr: "" };
  };

  it("prints the suggestion for a cut that may play badly, and says when autoProxy is making one", async () => {
    const { root } = await tmpProject();
    await mkdir(join(root, "renders"), { recursive: true });
    await writeFile(join(root, "renders", "hero.mov"), "original");
    await writeFile(join(root, "renders", "small.mp4"), "small");
    const s = await startServer(root, {
      port: 0,
      proxy: { run: fakeFfmpeg, probe: async (abs) => (abs.endsWith(".mov") ? prores4k : h264), available: async () => true },
    });
    try {
      const a = io(root);
      expect(await main(["add", "version", "renders/hero.mov", "--video", "Hero"], a.x)).toBe(0);
      expect(a.out).toEqual(["Added Hero v1", "Proxy suggested: It's a 4K ProRes file, which browsers struggle with. Create one from Picture."]);

      const b = io(root);
      expect(await main(["add", "version", "renders/small.mp4", "--video", "Hero"], b.x)).toBe(0);
      expect(b.out).toEqual(["Added Hero v2"]);

      await fetch(`${s.url}/api/project/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ autoProxy: true }) });
      const c = io(root);
      expect(await main(["add", "version", "renders/hero.mov", "--video", "Hero"], c.x)).toBe(0);
      expect(c.out).toEqual(["Added Hero v3", "Proxy suggested: It's a 4K ProRes file, which browsers struggle with. Making one now (autoProxy is on)."]);
    } finally {
      await s.close();
    }
  });

  it("prints the scan and bring-in commands in its help", async () => {
    const a = io("/tmp");
    expect(await main(["help"], a.x)).toBe(0);
    const text = a.out.join("\n");
    expect(text).toMatch(/rushes scan \[--film NAME\] \[--json\]/);
    expect(text).toMatch(/rushes bring-in <file>\.\.\. \[--kind voice\|music\|sfx\|cut\|doc\] \[--round NAME\] \[--film NAME\]/);
    expect(text).toMatch(/also brings in the current set/);
    expect(text).toMatch(/exits 1 if any file can't come in/);
  });

  describe("finding the project's other files (§20.7)", () => {
    // The cut is "launch film"; the read and the theme share its name words, so the current set picks them.
    const FILES = ["renders/launch film.mp4", "vo/launch film read.wav", "bed/launch film theme.wav", "sfx/whoosh.wav", "stems/other pad.wav", "stems/spare.wav"];

    async function project(files = FILES, opts: { cut?: boolean } = {}) {
      const { root, store } = await tmpProject();
      for (const f of files) {
        await mkdir(dirname(join(root, f)), { recursive: true });
        await writeFile(join(root, f), "bytes");
      }
      if (opts.cut !== false) await addCut(store);
      return { root, store };
    }
    const addCut = (store: Awaited<ReturnType<typeof tmpProject>>["store"]) =>
      store.update("project", (p) => addVersion(p, { video: "launch", file: "renders/launch film.mp4", duration: null, fps: 25 }));

    // A server whose start-up scan has finished with no cut, and then the cut: only the command's own
    // request can bring the current set in, never the start-up adoption.
    async function startedBeforeTheCut() {
      const { root, store } = await project(FILES, { cut: false });
      const s = await startServer(root, { port: 0 });
      await s.found.settled();
      await addCut(store);
      return { root, store, s };
    }

    it("scan prints what was brought in, the counts and the top candidates", async () => {
      const { root, s } = await startedBeforeTheCut();
      const a = io(root);
      expect(await main(["scan", "--film", "launch"], a.x)).toBe(0);
      const text = a.out.join("\n");
      expect(text).toMatch(/^Brought in: .*vo\/launch film read\.wav \(voice\)/m);
      expect(text).toMatch(/^Brought in: .*bed\/launch film theme\.wav \(music\)/m);
      expect(text).toContain("Found, left for you: 3 files (1 sfx, 2 other)");
      // Candidates are the indented lines; the files just brought in are no longer among them.
      const candidates = a.out.filter((l) => l.startsWith("  "));
      expect(candidates.map((l) => l.trim().split(/\s+/)[0])).toEqual(expect.arrayContaining(["sfx", "other"]));
      expect(candidates.join("\n")).toContain("sfx/whoosh.wav");
      expect(candidates.join("\n")).toContain("stems/other pad.wav");
      expect(candidates.join("\n")).not.toContain("launch film");
      await s.close();
    });

    it("scan --json prints the full result, and it parses", async () => {
      const { root, s } = await startedBeforeTheCut();
      const a = io(root);
      expect(await main(["scan", "--json", "--film", "launch"], a.x)).toBe(0);
      expect(a.out).toHaveLength(1);
      const r = JSON.parse(a.out[0]);
      expect(r.files.map((f: any) => f.path).sort()).toEqual(["sfx/whoosh.wav", "stems/other pad.wav", "stems/spare.wav"]);
      expect(r.files[0]).toMatchObject({ kind: expect.any(String), reasons: expect.any(Array), size: 5 });
      expect(r.counts).toEqual({ voice: 0, music: 0, sfx: 1, cut: 0, other: 2 });
      expect(r.broughtIn.map((x: any) => x.path).sort()).toEqual(["bed/launch film theme.wav", "vo/launch film read.wav"]);
      expect(r.failed).toEqual([]);
      expect(r.alreadyIn).toEqual([]);
      await s.close();
    });

    it("scan and open say on stderr that they are looking, so a wait isn't silent (and --json stays clean)", async () => {
      const { root, s } = await startedBeforeTheCut();
      const a = io(root);
      expect(await main(["scan", "--json"], a.x)).toBe(0);
      expect(a.err).toEqual(["Looking through the folder\u2026"]);
      expect(() => JSON.parse(a.out.join("\n"))).not.toThrow();
      const b = io(root);
      expect(await main(["open", "."], b.x)).toBe(0);
      expect(b.err).toEqual(["Looking through the folder\u2026"]);
      expect(b.out.join("\n")).not.toContain("Looking through");
      await s.close();
    });

    it("scan says so when there is nothing to find", async () => {
      const { root } = await tmpProject();
      const s = await startServer(root, { port: 0 });
      const a = io(root);
      expect(await main(["scan"], a.x)).toBe(0);
      expect(a.out).toEqual(["Nothing found in this folder."]);
      await s.close();
    });

    it("bring-in posts each file with --kind and --round, resolved against the folder it runs in", async () => {
      const { root, store } = await project();
      const s = await startServer(root, { port: 0 });
      const a = io(join(root, "stems"));
      expect(await main(["bring-in", "other pad.wav", "spare.wav", "--kind", "voice", "--round", "Round 1", "--dir", root], a.x)).toBe(0);
      expect(a.out).toEqual(["Brought in: stems/other pad.wav (voice)", "Brought in: stems/spare.wav (voice)"]);
      const lane = (await store.read("project")).lanes.find((l) => l.id === "round-1")!;
      expect(lane.name).toBe("Round 1");
      expect(lane.variants.map((v) => v.file)).toEqual(["stems/other pad.wav", "stems/spare.wav"]);
      expect(await store.read("picks")).toMatchObject({ lanes: {} });
      await s.close();
    });

    it("bring-in reports a file that can't come in, in the server's words, and exits 1", async () => {
      const { root } = await project();
      const s = await startServer(root, { port: 0 });
      const a = io(root);
      expect(await main(["bring-in", "stems/spare.wav", "--kind", "music", "../outside.wav", "gone.wav"], a.x)).toBe(1);
      expect(a.out).toContain("Brought in: stems/spare.wav (music)");
      expect(a.err).toEqual([`Not brought in: ${join(root, "..", "outside.wav")}: That file isn't in the project folder`, `Not brought in: ${join(root, "gone.wav")}: That file has gone`]);
      await s.close();
    });

    it("bring-in with more than 60 files says so, in words, without asking the server", async () => {
      const { root } = await tmpProject();
      const a = io(root);
      expect(await main(["bring-in", ...Array.from({ length: 61 }, (_, i) => `vo/take ${i}.wav`)], a.x)).toBe(2);
      expect(a.err.join("\n")).toMatch(/Up to 60 files at a time/);
      expect(a.err.join("\n")).toMatch(/second command/);
    });

    it("scan and bring-in against an older Rushes say to restart it", async () => {
      const { root } = await tmpProject();
      const old = createServer((req, res) => {
        if (req.url === "/api/health") return void res.end(JSON.stringify({ app: "rushes", root, id: "abcdefgh" }));
        res.statusCode = 404;
        res.end("404 Not Found");
      });
      await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
      await writeFile(lockPath(root), JSON.stringify({ port: (old.address() as { port: number }).port, pid: process.pid, startedAt: "x" }), "utf8");
      for (const argv of [["scan"], ["bring-in", "a.wav"]]) {
        const a = io(root);
        expect(await main(argv, a.x), argv[0]).toBe(1);
        expect(a.err.join("\n"), argv[0]).toMatch(/older than/);
      }
      old.close();
    });

    it("bring-in with no file prints its usage and exits 2", async () => {
      const { root } = await tmpProject();
      const a = io(root);
      expect(await main(["bring-in"], a.x)).toBe(2);
      expect(a.err[0]).toMatch(/^Usage: rushes bring-in <file>/);
    });

    it("open scans and adopts, then prints what came in and what it left", async () => {
      const { root, store } = await project();
      const a = io(root);
      let server: Running | undefined;
      a.x.onServer = (x) => { server = x; };
      expect(await main(["open", ".", "--port", "0", "--no-browser"], a.x)).toBe(0);
      expect(a.out[0]).toMatch(/^Rushes is running for /);
      const brought = a.out.find((l) => l.startsWith("Brought in: "))!;
      expect(brought).toContain("vo/launch film read.wav (voice)");
      expect(brought).toContain("bed/launch film theme.wav (music)");
      expect(a.out).toContain("Found, left for you: 3 files \u2014 open Assets \u203a Found.");
      expect(a.out).toHaveLength(3); // the running line (with the address), what came in, what was left
      expect((await store.read("project")).lanes.map((l) => l.stage).sort()).toEqual(["music", "voice"]);
      await server!.close();
    });

    it("open on a server that is already running scans and adopts too (the start-up scan had no cut)", async () => {
      const { root, store, s } = await startedBeforeTheCut();
      const a = io(root);
      expect(await main(["open", "."], a.x)).toBe(0);
      const brought = a.out.find((l) => l.startsWith("Brought in: "))!;
      expect(brought).toContain("vo/launch film read.wav (voice)");
      expect(brought).toContain("bed/launch film theme.wav (music)");
      expect(a.out).toContain("Found, left for you: 3 files \u2014 open Assets \u203a Found.");
      expect((await store.read("project")).lanes.map((l) => l.stage).sort()).toEqual(["music", "voice"]);
      await s.close();
    });

    it("open --film matches the files to that film", async () => {
      const { root, s } = await startedBeforeTheCut();
      const a = io(root);
      expect(await main(["open", ".", "--film", "launch"], a.x)).toBe(0);
      expect(a.out.find((l) => l.startsWith("Brought in: "))).toContain("launch film read.wav");
      await s.close();
    });

    it("open stays silent about files when there are none", async () => {
      const { root } = await tmpProject();
      const a = io(root);
      let server: Running | undefined;
      a.x.onServer = (x) => { server = x; };
      expect(await main(["open", ".", "--port", "0", "--no-browser"], a.x)).toBe(0);
      expect(a.out).toHaveLength(1);
      await server!.close();
    });
  });
});

describe("formats on the CLI (§21.4)", () => {
  async function server(files: string[]) {
    const { root } = await tmpProject();
    for (const f of files) {
      await mkdir(dirname(join(root, f)), { recursive: true });
      await writeFile(join(root, f), "bytes");
    }
    const s = await startServer(root, { port: 0, formats: { probe: sizedProbe } });
    return { root, s };
  }

  it("add format says what it settled on and any warning; a refusal exits 1 with the reason", async () => {
    const { root, s } = await server(["renders/hero_1920x1080.mp4", "renders/hero_1080x1920@8.4.mp4", "renders/hero_720x1280.mp4"]);
    const a = io(root);
    expect(await main(["add", "version", "renders/hero_1920x1080.mp4", "--video", "Hero"], a.x)).toBe(0);
    expect(await main(["add", "format", "renders/hero_1080x1920@8.4.mp4"], a.x)).toBe(0);
    expect(a.out).toContain("Added 9:16 to Hero v1");
    expect(a.out).toContain("Warning: 9:16 is 8.4 s; the cut is 8.0 s");
    const b = io(root);
    expect(await main(["add", "format", "renders/hero_720x1280.mp4", "--video", "Hero", "--version", "v1"], b.x)).toBe(1);
    expect(b.err.join("\n")).toContain("v1 already has 9:16. Register a re-render as a new version.");
    await s.close();
  });

  it("notes shows a format column for a cut with formats, and none for a one-format cut (R4)", async () => {
    const { root, s } = await server(["renders/hero_1920x1080.mp4", "renders/hero_1080x1920.mp4", "renders/solo_1920x1080.mp4"]);
    const a = io(root);
    await main(["add", "version", "renders/hero_1920x1080.mp4", "--video", "Hero"], a.x);
    await main(["add", "format", "renders/hero_1080x1920.mp4", "--video", "Hero"], a.x);
    await main(["add", "version", "renders/solo_1920x1080.mp4", "--video", "Solo"], a.x);
    const post = (body: object) => fetch(`${s.url}/api/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post({ stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Logo too close to the top.", format: "9x16" });
    await post({ stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "Drop the first sound." });
    await post({ stage: "picture", video: "solo", version: "v1", scope: "point", t: 3, text: "Hold longer." });
    const b = io(root);
    expect(await main(["notes"], b.x)).toBe(0);
    expect(b.out.find((l) => l.includes("Logo too close"))).toMatch(/ 9:16 {2}Logo too close/);
    expect(b.out.find((l) => l.includes("Drop the first"))).toMatch(/ All {2}Drop the first/);
    expect(b.out.find((l) => l.includes("Hold longer"))).not.toMatch(/ All /);
    await s.close();
  });

  it("help lists add format", async () => {
    const a = io("/tmp");
    await main([], a.x);
    expect(a.out.join("\n")).toContain("rushes add format <file> [--video NAME] [--version V] [--label RATIO]");
  });

  it("add format with no file is a usage error, exit 2", async () => {
    const a = io("/tmp");
    expect(await main(["add", "format"], a.x)).toBe(2);
    expect(a.err.join("\n")).toContain("rushes add format <file>");
  });

  it("add format --label passes the hint on, and prints the server's Label line when it has one", async () => {
    const { root, s } = await server(["renders/hero_1920x1080.mp4", "renders/hero_2390x1000.mp4", "renders/hero_1080x1920.mp4"]);
    const a = io(root);
    await main(["add", "version", "renders/hero_1920x1080.mp4", "--video", "Hero"], a.x);
    const b = io(root);
    expect(await main(["add", "format", "renders/hero_2390x1000.mp4", "--label", "2.39:1"], b.x)).toBe(0);
    expect(b.out).toEqual(["Added 2.39:1 to Hero v1"]);
    // A hint on a standard ratio is not needed: the server's note comes through as a Label line.
    const c = io(root);
    expect(await main(["add", "format", "renders/hero_1080x1920.mp4", "--label", "2.39:1"], c.x)).toBe(0);
    expect(c.out).toEqual(["Added 9:16 to Hero v1", 'Label: The file measures 9:16, a standard ratio, so the label "2.39:1" wasn\'t needed.']);
    await s.close();
  });

  // Review I1: a Rushes from before formats sends notes with no `format` and versions with no `formats`
  // or size. `rushes notes` printed these lines then, and prints them now.
  async function oldServer(notes: object[]) {
    const { root } = await tmpProject();
    const asked: string[] = [];
    const old = createServer((req, res) => {
      asked.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") return void res.end(JSON.stringify({ app: "rushes", root, id: "abcdefgh" }));
      if (req.url === "/api/notes") return void res.end(JSON.stringify({ notes }));
      if (req.url === "/api/state") {
        const project = { name: "Demo", fps: 30, lanes: [], files: [], autoProxy: false, videos: [{ id: "hero", name: "Hero", lockedVersion: null, versions: [{ id: "v1", file: "renders/hero.mp4", duration: 8, fps: 30, shots: [] }] }] };
        return void res.end(JSON.stringify({ project, script: { sections: [] }, picks: { lanes: {} } }));
      }
      res.statusCode = 404;
      res.end("404 Not Found");
    });
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    await writeFile(lockPath(root), JSON.stringify({ port: (old.address() as { port: number }).port, pid: process.pid, startedAt: "x" }), "utf8");
    return { root, asked, close: () => void old.close() };
  }
  const oldNote = (over: object) => ({ id: "n_1", stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, tOut: null, text: "Hold longer.", status: "todo", marks: [], shot: null, ...over });

  it("notes against a 0.2.x server, whose notes have no format and whose versions have no formats, prints what it printed before", async () => {
    const f = await oldServer([oldNote({})]);
    const a = io(f.root);
    expect(await main(["notes"], a.x)).toBe(0);
    expect(a.out).toEqual([`n_1  todo  picture ${"0:01.00".padEnd(17)} Hold longer.`]);
    f.close();
  });

  it("a Script-only notes listing asks the server for no state", async () => {
    const f = await oldServer([oldNote({ id: "n_2", stage: "script", video: null, version: null, scope: "whole", t: null })]);
    const a = io(f.root);
    expect(await main(["notes"], a.x)).toBe(0);
    expect(a.out).toEqual([`n_2  todo  script  ${"whole".padEnd(17)} Hold longer.`]);
    expect(f.asked).not.toContain("/api/state");
    f.close();
  });
});


describe("the folder, port and harness a command is given", () => {
  const exists = (p: string) => access(p).then(() => true, () => false);
  // A scratch folder with a "film" folder inside it, so "the current folder" and "film" differ.
  async function scratch() {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "rushes cli ")));
    await mkdir(join(dir, "film"));
    return dir;
  }

  it("--dir names the folder for init, as the folder argument does", async () => {
    const dir = await scratch();
    const a = io(dir);
    expect(await main(["init", "--dir", "film"], a.x)).toBe(0);
    expect(await exists(join(dir, "film", ".rushes"))).toBe(true);
    expect(await exists(join(dir, ".rushes"))).toBe(false);
  });

  it.each(["open", "serve"])("--dir names the folder %s starts the server for, not the current folder", async (cmd) => {
    const dir = await scratch();
    const a = io(dir);
    let server: Running | undefined;
    a.x.onServer = (s) => { server = s; };
    expect(await main([cmd, "--dir", "film", "--port", "0", "--no-browser"], a.x)).toBe(0);
    expect((await (await fetch(`${server!.url}/api/health`)).json()).root).toBe(join(dir, "film"));
    expect(await exists(join(dir, ".rushes"))).toBe(false);
    await server!.close();
  });

  it("--dir names the server stop stops, and the current folder's server is left running", async () => {
    const here = (await tmpProject()).root;
    const there = (await tmpProject()).root;
    const mine = await startServer(here, { port: 0 });
    await startServer(there, { port: 0 });
    expect(await main(["stop", "--dir", there], io(here).x)).toBe(0);
    expect(await findServer(there)).toBeNull();
    expect(await findServer(here)).toBe(mine.url);
    await mine.close();
  });

  it.each(["abc", "-1", "65536", "80.5"])("--port=%s is refused before anything is created", async (bad) => {
    const dir = await scratch();
    for (const cmd of ["open", "serve"]) {
      const a = io(dir);
      expect(await main([cmd, `--port=${bad}`, "--no-browser"], a.x), cmd).toBe(2);
      expect(a.err.join("\n"), cmd).toContain("--port must be a whole number from 0 to 65535");
    }
    expect(await exists(join(dir, ".rushes"))).toBe(false);
  });

  it("--only that names no harness is refused, listing the ones that exist", async () => {
    // Refused before setup looks at this machine, so no harness env is needed.
    for (const only of ["curser", "codex,curser", "claude-code, nope"]) {
      const a = io("/tmp");
      expect(await main(["setup", "--only", only, "--dry-run"], a.x), only).toBe(2);
      expect(a.err.join("\n"), only).toContain("claude-code, codex, cursor, claude-desktop, gemini");
    }
  });
});
