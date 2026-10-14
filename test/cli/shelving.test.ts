import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { main, type Io } from "../../src/cli/main.js";
import { startServer } from "../../src/server/start.js";

// §26.5: what an agent at the command line sees of a shelved film.
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

async function twoFilms() {
  const { root } = await tmpProject("Lumen");
  const s = await startServer(root, { port: 0 });
  for (const film of ["Hero", "Teaser"]) expect(await main(["add", "version", `renders/${film}.mp4`, "--video", film], io(root).x)).toBe(0);
  const shelve = (id: string, shelved: boolean) => fetch(`${s.url}/api/videos/${id}/shelve`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ shelved }) });
  return { root, s, shelve };
}

describe("rushes status with a shelved film", () => {
  it("names the shelved films, and says nothing when none are shelved", async () => {
    const { root, s, shelve } = await twoFilms();
    const none = io(root);
    expect(await main(["status"], none.x)).toBe(0);
    expect(none.out.join("\n")).not.toContain("shelved");
    await shelve("teaser", true);
    const some = io(root);
    expect(await main(["status"], some.x)).toBe(0);
    expect(some.out).toContain("shelved  Teaser");
    await s.close();
  });
});

describe("rushes notes with a shelved film", () => {
  it("leaves the shelved film's notes out, and lists them again with --include-shelved", async () => {
    const { root, s, shelve } = await twoFilms();
    const note = (video: string, text: string) =>
      fetch(`${s.url}/api/notes`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: "picture", video, version: "v1", scope: "point", t: 1, text }) });
    await note("hero", "Hero fix.");
    await note("teaser", "Teaser fix.");
    await shelve("teaser", true);
    const plain = io(root);
    expect(await main(["notes"], plain.x)).toBe(0);
    expect(plain.out.join("\n")).toContain("Hero fix.");
    expect(plain.out.join("\n")).not.toContain("Teaser fix.");
    const all = io(root);
    expect(await main(["notes", "--include-shelved"], all.x)).toBe(0);
    expect(all.out.join("\n")).toContain("Teaser fix.");
    await s.close();
  });
});

describe("rushes add version on a shelved film", () => {
  it("says the film was brought back", async () => {
    const { root, s, shelve } = await twoFilms();
    await shelve("teaser", true);
    const a = io(root);
    expect(await main(["add", "version", "renders/Teaser-2.mp4", "--video", "Teaser"], a.x)).toBe(0);
    expect(a.out[0]).toBe("Added Teaser v2 (it was shelved: restored)");
    const plain = io(root);
    expect(await main(["add", "version", "renders/Hero-2.mp4", "--video", "Hero"], plain.x)).toBe(0);
    expect(plain.out[0]).toBe("Added Hero v2");
    await s.close();
  });
});
