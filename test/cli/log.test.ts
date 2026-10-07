import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { main, type Io } from "../../src/cli/main.js";
import { startServer } from "../../src/server/start.js";

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
