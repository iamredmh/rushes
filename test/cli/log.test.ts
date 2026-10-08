import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { main, type Io } from "../../src/cli/main.js";
import { startServer } from "../../src/server/start.js";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lockPath } from "../../src/server/lock.js";

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const x: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd,
    openBrowser: () => undefined,
    ensure: { spawnServer: () => { throw new Error("tests start the server themselves"); }, timeoutMs: 300 },
  };
  return { x, out, err };
}

describe("rushes add version --label (§22.4)", () => {
  it("sends the label, and help shows it", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "renders/lumen v1.mp4", "--video", "Lumen launch film", "--label", "First pass", "--note", "v1: the detail"], a.x)).toBe(0);
    const state = await (await fetch(`${s.url}/api/state`)).json();
    expect(state.project.videos[0].versions[0]).toMatchObject({ label: "First pass", note: "v1: the detail" });
    const h = io(root);
    await main([], h.x);
    expect(h.out.join("\n")).toContain("rushes add version <file> --video NAME [--label TEXT] [--note TEXT]");
    await s.close();
  });
});

describe("rushes add version --label, refused or dropped (§22.9, R2)", () => {
  it("says the 48-character rule in words for a longer label, counting characters not UTF-16 units, and adds nothing", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "renders/lumen v1.mp4", "--video", "Lumen launch film", "--label", "x".repeat(49)], a.x)).not.toBe(0);
    expect(a.err.join("\n")).toContain("label is 48 characters at most: put the detail in note");
    const state = await (await fetch(`${s.url}/api/state`)).json();
    expect(state.project.videos).toHaveLength(0);
    // 48 emoji are 96 UTF-16 units but 48 characters: accepted. Padding doesn't count.
    const ok = io(root);
    expect(await main(["add", "version", "renders/lumen v1.mp4", "--video", "Lumen launch film", "--label", `  ${"\u{1F3AC}".repeat(48)}  `], ok.x)).toBe(0);
    const over = io(root);
    expect(await main(["add", "version", "renders/lumen v1.mp4", "--video", "Lumen launch film", "--label", "\u{1F3AC}".repeat(49)], over.x)).not.toBe(0);
    await s.close();
  });

  it("warns when an older Rushes drops the label", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const old = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/health") return void res.end(JSON.stringify({ app: "rushes", root, id: "abcdefgh" }));
      res.end(JSON.stringify({ video: { id: "hero", name: "Hero" }, version: { id: "v1", file: "renders/hero.mp4", note: "" } }));
    });
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    await writeFile(lockPath(root), JSON.stringify({ port: (old.address() as { port: number }).port, pid: process.pid, startedAt: "x" }), "utf8");
    const a = io(root);
    expect(await main(["add", "version", "renders/hero.mp4", "--video", "Hero", "--label", "First pass"], a.x)).toBe(0);
    expect(a.out.join("\n")).toContain("Added Hero v1");
    expect(a.err.join("\n")).toMatch(/older Rushes.*label.*rushes stop/);
    const b = io(root);
    expect(await main(["add", "version", "renders/hero.mp4", "--video", "Hero"], b.x)).toBe(0);
    expect(b.err).toEqual([]);
    old.close();
  });
});

describe("rushes log (§22.7)", () => {
  it("prints the log newest first, adds a line, and prints the same Markdown the export writes", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["add", "version", "renders/lumen v1.mp4", "--video", "Lumen launch film", "--label", "First pass"], a.x)).toBe(0);
    expect(await main(["log", "add", "Kept", "the", "wide", "shot", "--area", "picture"], a.x)).toBe(0);
    expect(a.out.pop()).toBe("Added to the Change Log: Kept the wide shot");
    expect(await main(["log"], a.x)).toBe(0);
    expect(a.out.slice(-2).map((l) => l.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  /, ""))).toEqual([
      "Picture       Kept the wide shot  (agent)",
      "Picture       v1 added: First pass  (agent)",
    ]);
    expect(await main(["log", "--md"], a.x)).toBe(0);
    const md = a.out.pop()!;
    const { changeLog } = await (await fetch(`${s.url}/api/exports/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
    const file = await readFile(join(root, changeLog), "utf8");
    const exported = (t: string) => t.replace(/^Exported .*$/m, "Exported");
    expect(exported(`${md}\n`)).toBe(exported(file));
    const b = io(root);
    expect(await main(["log", "--area", "elsewhere"], b.x)).toBe(2);
    expect(await main(["log", "--limit", "0"], b.x)).toBe(2);
    expect(await main(["log", "add"], b.x)).toBe(2);
    expect(await main(["log", "frobnicate"], b.x)).toBe(2);
    await s.close();
  });

  it("help lists both commands, in the description column", async () => {
    const a = io("/tmp");
    await main([], a.x);
    const lines = a.out.join("\n").split("\n");
    // Where the description starts: after the line's last run of two or more spaces (as test/cli/main.test.ts measures it).
    const col = (line: string) => {
      let last = -1;
      for (const m of line.matchAll(/ {2,}\S/g)) last = m.index + m[0].length - 1;
      return last;
    };
    const status = lines.find((l) => l.startsWith("  rushes status"))!;
    for (const start of ["  rushes log [--limit N] [--area A] [--md]", "  rushes log add <text> [--area A]"]) {
      const line = lines.find((l) => l.startsWith(start))!;
      expect(line, start).toBeTruthy();
      expect(col(line), start).toBe(col(status));
    }
  });

  it("prints 30 by default and everything with --md, and keeps errors off stdout", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    for (let i = 1; i <= 35; i++) expect(await main(["log", "add", `Line number ${i}`], a.x)).toBe(0);
    const p = io(root);
    expect(await main(["log"], p.x)).toBe(0);
    expect(p.out.filter((l) => l.includes("Line number "))).toHaveLength(30);
    expect(p.out.at(-1)).toBe("5 earlier (rushes log --limit 35 shows them)");
    const m = io(root);
    expect(await main(["log", "--md"], m.x)).toBe(0);
    expect(m.out).toHaveLength(1);
    for (let i = 1; i <= 35; i++) expect(m.out[0]).toContain(`Line number ${i} `);
    const lim = io(root);
    expect(await main(["log", "--limit", "2", "--area", "project"], lim.x)).toBe(0);
    expect(lim.out.filter((l) => l.includes("Line number "))).toHaveLength(2);
    // Bad input: exit 2, a reason and the usage on stderr, nothing on stdout.
    for (const argv of [["log", "--area", "elsewhere"], ["log", "--limit", "5001"], ["log", "--limit", "abc"], ["log", "add"], ["log", "add", "--area", "picture"], ["log", "frobnicate"]]) {
      const b = io(root);
      expect(await main(argv, b.x), argv.join(" ")).toBe(2);
      expect(b.out, argv.join(" ")).toEqual([]);
      expect(b.err.join("\n"), argv.join(" ")).toMatch(/Usage: rushes log/);
    }
    const e = io(root);
    await main(["log", "--area", "elsewhere"], e.x);
    expect(e.err[0]).toBe('--area must be one of script, picture, voice, music, sfx, mix, notes, assets, project (got "elsewhere")');
    await s.close();
  });

  it("an empty log says so; against an older Rushes it says to restart, on stderr, with exit 1", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const a = io(root);
    expect(await main(["log"], a.x)).toBe(0);
    expect(a.out).toEqual(["Nothing in the Change Log yet."]);
    await s.close();

    const { root: oldRoot } = await tmpProject("Hero");
    const old = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ app: "rushes", root: oldRoot, id: "abcdefgh" }));
      }
      res.statusCode = 404;
      res.end("404 Not Found");
    });
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    await writeFile(lockPath(oldRoot), JSON.stringify({ port: (old.address() as { port: number }).port, pid: process.pid, startedAt: "x" }), "utf8");
    for (const argv of [["log"], ["log", "--md"], ["log", "add", "Slowed the zooms"]]) {
      const b = io(oldRoot);
      expect(await main(argv, b.x), argv.join(" ")).toBe(1);
      expect(b.out, argv.join(" ")).toEqual([]);
      expect(b.err.join("\n"), argv.join(" ")).toMatch(/older than this command[\s\S]*rushes stop/);
    }
    old.closeAllConnections();
    old.close();
  });
});
