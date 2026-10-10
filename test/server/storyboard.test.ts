import { describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { StoryboardService } from "../../src/server/storyboard.js";

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
