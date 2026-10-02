import { describe, expect, it } from "vitest";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { main, longRunningCommand, type Io } from "../../src/cli/main.js";
import { startServer, type Running } from "../../src/server/start.js";

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const x: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd,
    openBrowser: (u) => opened.push(u),
    ensure: { spawnServer: () => { throw new Error("tests start the server themselves"); }, timeoutMs: 300 },
  };
  return { x, out, err, opened };
}

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
