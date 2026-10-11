import { describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { StoryboardService } from "../../src/server/storyboard.js";
import { contentType } from "../../src/server/files.js";
import { stillPath } from "../../src/core/storyboard.js";
import { BriefService } from "../../src/server/brief.js";
import { createApp } from "../../src/server/app.js";

const AGENT = `# Storyboard: Lumen launch film

## Shot 01 · Cold open
Tag: ESTABLISH
Length: 3
Still: storyboard/shot-01.png
Status: draft
Direction:

The headline sits on a pale card.

## Shot 02 · Drop a folder
Tag: ACTION
Length: 5
Still: ../outside.png
Status: draft
Direction:

A folder of clips lands in the window.
`;

async function setup(text: string | null = AGENT) {
  const { root, store } = await tmpProject("lumen");
  if (text !== null) await writeFile(join(root, "storyboard.md"), text);
  const board = new StoryboardService(store);
  return { root, store, board, file: () => readFile(join(root, "storyboard.md"), "utf8") };
}

describe("StoryboardService", () => {
  it("says there is no storyboard when there is no file, and refuses to save one", async () => {
    const { board } = await setup(null);
    expect((await board.view()).exists).toBe(false);
    await expect(board.setShot(0, "Shot 01 · Cold open", { status: "approved" }, "abc")).rejects.toMatchObject({ status: 404 });
    expect(await board.cutShots()).toEqual([]);
    expect([...(await board.stills())]).toEqual([]);
  });

  it("shows an untouched file as the agent's: counts, planned length, nothing changed", async () => {
    const { board } = await setup();
    const v = await board.view();
    expect(v).toMatchObject({ exists: true, title: "Lumen launch film", changed: 0, approved: 0, total: 2, plannedLength: 8 });
    expect(v.shots.map((s) => [s.n, s.name, s.changed])).toEqual([[1, "Cold open", false], [2, "Drop a folder", false]]);
  });

  it("a saved description or direction keeps the agent's text as Current, and changes only that shot", async () => {
    const { board, file } = await setup();
    const hash = (await board.view()).hash;
    const v = await board.setShot(0, "Shot 01 · Cold open", { description: "Mine.", direction: "Slower." }, hash);
    expect(await file()).toBe(AGENT.replace("Direction:\n\nThe headline sits on a pale card.", "Direction: Slower.\n\nMine."));
    expect(v.shots[0]).toMatchObject({ description: "Mine.", current: "The headline sits on a pale card.", direction: "Slower.", directionCurrent: "", changed: true });
    expect(v.shots[1].changed).toBe(false);
    expect(v.changed).toBe(1);
  });

  it("approving sets the status, and changing an approved shot's words reopens it", async () => {
    const { board, file } = await setup();
    const a = await board.setShot(0, "Shot 01 · Cold open", { status: "approved" }, (await board.view()).hash);
    expect(a.approved).toBe(1);
    expect(await file()).toContain("Status: approved");
    const same = await board.setShot(0, "Shot 01 · Cold open", { description: "The headline sits on a pale card." }, a.hash);
    expect(same.shots[0].status).toBe("approved");
    const e = await board.setShot(0, "Shot 01 · Cold open", { description: "Different." }, same.hash);
    expect(e.shots[0].status).toBe("draft");
    const both = await board.setShot(0, "Shot 01 · Cold open", { description: "Again.", status: "approved" }, e.hash);
    expect(both.shots[0].status).toBe("approved");
  });

  it("an edit by someone else becomes the agent's new version", async () => {
    const { board, root } = await setup();
    await board.setShot(0, "Shot 01 · Cold open", { description: "Mine." }, (await board.view()).hash);
    await writeFile(join(root, "storyboard.md"), AGENT.replace("A folder of clips lands in the window.", "Elsewhere."));
    await board.sync();
    const v = await board.view();
    expect(v.shots[1]).toMatchObject({ current: "Elsewhere.", description: "Elsewhere.", changed: false });
    expect(v.changed).toBe(0);
  });

  it("refuses a save made against an older file, and a heading that is not at that position, and leaves the file alone", async () => {
    const { board, root, file } = await setup();
    const v = await board.view();
    await expect(board.setShot(1, "Shot 01 · Cold open", { status: "approved" }, v.hash)).rejects.toMatchObject({ status: 400 });
    expect(await file()).toBe(AGENT);
    const theirs = AGENT.replace("Calm", "x") + "\n## Shot 03 · New\nLength: 2\n\nWords\n";
    await writeFile(join(root, "storyboard.md"), theirs);
    await expect(board.setShot(0, "Shot 01 · Cold open", { status: "approved" }, v.hash)).rejects.toMatchObject({ status: 409, code: "storyboard_changed" });
    expect(await file()).toBe(theirs);
  });

  it("serves only safe stills, and builds a cut's shots from the lengths", async () => {
    const { board } = await setup();
    expect([...(await board.stills())]).toEqual(["storyboard/shot-01.png"]);
    expect(await board.cutShots()).toEqual([{ name: "Cold open", start: 0, tag: "ESTABLISH" }, { name: "Drop a folder", start: 3, tag: "ACTION" }]);
  });

  it("only accepts picture types the server serves as pictures: avif is not one", () => {
    for (const [ext, type] of [["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["webp", "image/webp"], ["gif", "image/gif"]]) {
      expect(stillPath(`storyboard/a.${ext}`), ext).toBe(`storyboard/a.${ext}`);
      expect(contentType(`storyboard/a.${ext}`), ext).toBe(type);
    }
    expect(stillPath("storyboard/a.avif")).toBeNull();
  });

  it("does not name a still that is a link, or one inside a linked folder", async () => {
    const text = AGENT.replace("storyboard/shot-01.png", "storyboard/linked.png").replace("../outside.png", "folder/shot-02.png");
    const { root, board } = await setup(text);
    const outside = join(root, "..", `${Date.now()}-outside`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.png"), "secret");
    await mkdir(join(root, "storyboard"), { recursive: true });
    await symlink(join(outside, "secret.png"), join(root, "storyboard", "linked.png"));
    await symlink(outside, join(root, "folder"));
    await writeFile(join(outside, "shot-02.png"), "also secret");
    expect([...(await board.stills())]).toEqual([]);
    const view = await board.view();
    expect(view.shots.map((x) => x.still)).toEqual([null, null]);
  });

  it("does not follow a link, treat a folder as a storyboard, or read a file that is too big", async () => {
    const a = await setup(null);
    await writeFile(join(a.root, "elsewhere.md"), AGENT);
    await symlink(join(a.root, "elsewhere.md"), join(a.root, "storyboard.md"));
    expect((await a.board.view()).exists).toBe(false);
    const b = await setup(null);
    await mkdir(join(b.root, "storyboard.md"));
    expect((await b.board.view()).exists).toBe(false);
    const c = await setup("# S\n\n## Shot 1 · A\n" + "x".repeat(1_000_001));
    expect((await c.board.view()).exists).toBe(false);
  });

  it("start() notices a change made outside the dashboard and announces it", async () => {
    const { board, store, root } = await setup();
    const heard: string[] = [];
    store.on("change", (e: { file: string }) => heard.push(e.file));
    const stop = board.start(50);
    try {
      await expect.poll(() => heard.includes("storyboard"), { timeout: 3000 }).toBe(true);
      heard.length = 0;
      await writeFile(join(root, "storyboard.md"), AGENT.replace("A folder of clips lands in the window.", "Elsewhere."));
      await expect.poll(() => heard.includes("storyboard"), { timeout: 3000 }).toBe(true);
      expect((await board.view()).shots[1]).toMatchObject({ current: "Elsewhere.", changed: false });
    } finally {
      stop();
    }
  });
});

const BRIEF = "# Brief: Lumen\n\nStatus: approved\n\n## Purpose\nA.\n";
const APPROVED = AGENT.replaceAll("Status: draft", "Status: approved");

describe("storyboard over HTTP", () => {
  async function app(opts: { board?: string | null; brief?: string | null; script?: boolean } = {}) {
    const s = await setup(opts.board === undefined ? AGENT : opts.board);
    if (opts.brief) await writeFile(join(s.root, "brief.md"), opts.brief);
    if (opts.script) await s.store.update("script", (d) => { d.sections = [{ id: "s1", start: 0, end: 3, current: "x", proposed: null, direction: "", status: "approved", takes: [] }]; });
    const server = createApp(s.store, { storyboard: s.board, brief: new BriefService(s.store) });
    const call = async (method: string, path: string, json?: unknown) => {
      const res = await server.request(path, { method, headers: json === undefined ? undefined : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
      const type = res.headers.get("content-type") ?? "";
      return { status: res.status, json: type.includes("json") ? ((await res.json()) as any) : null, res };
    };
    return { ...s, call };
  }

  it("state carries the storyboard and the build, and tabs carry their summaries", async () => {
    const { call } = await app({ brief: BRIEF });
    const state = await call("GET", "/api/state");
    expect(state.json.storyboard).toMatchObject({ exists: true, total: 2, approved: 0, changed: 0 });
    expect(state.json.build).toEqual({ started: true, ready: false, waitingOn: ["storyboard"] });
    const tabs = await call("GET", "/api/tabs");
    expect(tabs.json.storyboard).toEqual({ exists: true, shots: 2, approved: 0, changed: 0 });
    expect(tabs.json.build.waitingOn).toEqual(["storyboard"]);
  });

  it("with no storyboard and no brief the build is not started, and nothing breaks", async () => {
    const { call } = await app({ board: null });
    expect((await call("GET", "/api/state")).json.storyboard).toMatchObject({ exists: false, shots: [] });
    expect((await call("GET", "/api/tabs")).json.build).toMatchObject({ started: false, ready: false });
  });

  it("saves a shot's words, direction and status, and answers the errors", async () => {
    const { call, file } = await app();
    const hash = (await call("GET", "/api/state")).json.storyboard.hash;
    const saved = await call("PUT", "/api/storyboard/shots/0", { heading: "Shot 01 · Cold open", description: "Mine.", direction: "Slower.", status: "approved", hash });
    expect(saved.status).toBe(200);
    expect(saved.json.storyboard.shots[0]).toMatchObject({ description: "Mine.", direction: "Slower.", status: "approved", changed: true });
    expect(await file()).toContain("Direction: Slower.\n\nMine.");
    expect((await call("PUT", "/api/storyboard/shots/0", { heading: "Shot 01 · Cold open", status: "draft", hash: "stale" })).json.error).toBe("storyboard_changed");
    expect((await call("PUT", "/api/storyboard/shots/-1", { heading: "x", status: "draft", hash: "a" })).status).toBe(400);
    expect((await call("PUT", "/api/storyboard/shots/0", { heading: "Shot 01 · Cold open", hash: "a" })).status).toBe(400);
    expect((await call("PUT", "/api/storyboard/shots/0", { heading: "Shot 02 · Drop a folder", status: "draft", hash: saved.json.storyboard.hash })).status).toBe(400);
  });

  it("serves a still the storyboard names without it being registered, and nothing else", async () => {
    const { call, root } = await app();
    await mkdir(join(root, "storyboard"), { recursive: true });
    await writeFile(join(root, "storyboard", "shot-01.png"), "png-bytes");
    await writeFile(join(root, "storyboard", "other.png"), "other");
    const ok = await call("GET", "/media?path=storyboard/shot-01.png");
    expect(ok.status).toBe(200);
    expect(await ok.res.text()).toBe("png-bytes");
    expect((await call("GET", "/media?path=storyboard/other.png")).status).toBe(404);
    // A still outside the project is never named by the page, and is never served.
    expect((await call("GET", "/media?path=../outside.png")).status).toBe(404);
  });

  it("does not serve a still that is a link out of the project", async () => {
    const text = AGENT.replace("../outside.png", "storyboard/linked.png");
    const { call, root } = await app({ board: text });
    const outside = join(root, "..", `${Date.now()}-outside-http`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.png"), "SECRET");
    await mkdir(join(root, "storyboard"), { recursive: true });
    await symlink(join(outside, "secret.png"), join(root, "storyboard", "linked.png"));
    expect((await call("GET", "/media?path=storyboard/linked.png")).status).toBe(404);
    expect((await call("GET", "/api/state")).json.storyboard.shots[1].still).toBe(null);
  });

  describe("a film's first cut", () => {
    const post = (call: (m: string, p: string, j?: unknown) => Promise<any>, video = "Hero") => call("POST", "/api/versions", { video, file: "renders/hero.mp4" });

    it("starts with the storyboard's shots, and says what the plan is waiting on, without refusing", async () => {
      const { call } = await app({ brief: BRIEF });
      const r = await post(call);
      expect(r.status).toBe(201);
      expect(r.json.version.shots).toEqual([{ n: 1, name: "Cold open", start: 0, tag: "ESTABLISH" }, { n: 2, name: "Drop a folder", start: 3, tag: "ACTION" }]);
      expect(r.json.planWarning).toBe("The plan isn't approved yet: still waiting on the storyboard.");
    });

    it("carries no warning once the brief, the script and every shot are approved", async () => {
      const { call } = await app({ board: APPROVED, brief: BRIEF, script: true });
      const r = await post(call);
      expect(r.json.planWarning).toBeUndefined();
      expect(r.json.version.shots).toHaveLength(2);
    });

    it("leaves a project that never used the planning flow alone", async () => {
      const { call } = await app({ board: null });
      const r = await post(call);
      expect(r.status).toBe(201);
      expect(r.json.planWarning).toBeUndefined();
      expect(r.json.version.shots).toEqual([]);
    });

    it("copies the shots once: a second cut inherits the first's list, and another film's first cut takes the plan as it is then", async () => {
      const { call, root, board } = await app({ board: APPROVED });
      await post(call);
      await writeFile(join(root, "storyboard.md"), APPROVED.replace("Length: 3", "Length: 9"));
      await board.sync();
      const second = await post(call);
      expect(second.json.version.shots.map((s: { start: number }) => s.start)).toEqual([0, 3]);
      const otherFilm = await post(call, "Teaser");
      expect(otherFilm.json.version.shots.map((s: { start: number }) => s.start)).toEqual([0, 9]);
    });
  });
});
