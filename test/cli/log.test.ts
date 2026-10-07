import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { main, type Io } from "../../src/cli/main.js";
import { startServer } from "../../src/server/start.js";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
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
