import { describe, expect, it } from "vitest";
import { access } from "node:fs/promises";
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
    const b = io("/tmp");
    expect(await main(["frobnicate"], b.x)).toBe(2);
    expect(b.err[0]).toContain('Unknown command "frobnicate"');
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

  it("open starts the server and opens the browser", async () => {
    const { root } = await tmpProject();
    const a = io(root);
    let server: Running | undefined;
    a.x.onServer = (s) => { server = s; };
    expect(await main(["open", ".", "--port", "0"], a.x)).toBe(0);
    expect(a.opened).toEqual([server!.url]);
    const health = await (await fetch(`${a.opened[0]}/api/health`)).json();
    expect(health.root).toBe(root);
    await server!.close();
  });

  it("open and serve reuse a server that is already running instead of starting another", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    let started: Running | undefined;
    a.x.onServer = (x) => { started = x; };
    expect(await main(["open", "."], a.x)).toBe(0);
    expect(a.out).toEqual([`Rushes is already running for ${root}\n${s.url}`]);
    expect(a.opened).toEqual([s.url]);
    const b = io(root);
    b.x.onServer = (x) => { started = x; };
    expect(await main(["serve", root], b.x)).toBe(0);
    expect(b.out).toEqual([`Rushes is already running for ${root}\n${s.url}`]);
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
