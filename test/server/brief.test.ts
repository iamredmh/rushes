import { describe, expect, it } from "vitest";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { BriefService } from "../../src/server/brief.js";
import { briefTemplate } from "../../src/cli/new.js";

const AGENT = `# Brief: Lumen launch film

Status: draft

## Purpose
Show that Lumen finds the best takes.

## Tone
Calm and dry.
`;

async function setup(text: string | null = AGENT) {
  const { root, store } = await tmpProject("lumen");
  if (text !== null) await writeFile(join(root, "brief.md"), text);
  const brief = new BriefService(store);
  return { root, store, brief, file: () => readFile(join(root, "brief.md"), "utf8") };
}

describe("BriefService", () => {
  it("says there is no brief when there is no file, and refuses to save one", async () => {
    const { brief } = await setup(null);
    expect((await brief.view()).exists).toBe(false);
    await expect(brief.setSection(0, "Purpose", "x", "abc")).rejects.toMatchObject({ status: 404 });
  });

  it("shows an untouched file as the agent's, with nothing changed", async () => {
    const { brief } = await setup();
    const v = await brief.view();
    expect(v.title).toBe("Lumen launch film");
    expect(v.status).toBe("draft");
    expect(v.sections.map((s) => [s.heading, s.yours, s.changed])).toEqual([["Purpose", "Show that Lumen finds the best takes.", false], ["Tone", "Calm and dry.", false]]);
    expect(v.changed).toBe(0);
  });

  it("a save changes only that section in the file, and keeps the agent's text as Current", async () => {
    const { brief, file } = await setup();
    const v0 = await brief.view();
    const v1 = await brief.setSection(0, "Purpose", "Show how fast it is.", v0.hash);
    expect(await file()).toBe(AGENT.replace("Show that Lumen finds the best takes.", "Show how fast it is."));
    expect(v1.sections[0]).toMatchObject({ current: "Show that Lumen finds the best takes.", yours: "Show how fast it is.", changed: true });
    expect(v1.sections[1].changed).toBe(false);
    expect(v1.changed).toBe(1);
    expect((await brief.view()).changed).toBe(1);
  });

  it("reverting a section writes the agent's text back and clears the change", async () => {
    const { brief, file } = await setup();
    const v1 = await brief.setSection(0, "Purpose", "Mine.", (await brief.view()).hash);
    const v2 = await brief.setSection(0, "Purpose", v1.sections[0].current, v1.hash);
    expect(await file()).toBe(AGENT);
    expect(v2.changed).toBe(0);
  });

  it("an edit by someone else becomes the agent's new version", async () => {
    const { brief, root } = await setup();
    await brief.setSection(0, "Purpose", "Mine.", (await brief.view()).hash);
    await writeFile(join(root, "brief.md"), AGENT.replace("Calm and dry.", "Warm and quick."));
    await brief.sync();
    const v = await brief.view();
    expect(v.sections[1]).toMatchObject({ current: "Warm and quick.", yours: "Warm and quick.", changed: false });
    expect(v.changed).toBe(0);
  });

  it("before the file has been looked at, a change made behind its back still counts as the agent's", async () => {
    const { brief, root } = await setup();
    const v = await brief.view();
    expect(v.changed).toBe(0);
    await writeFile(join(root, "brief.md"), AGENT.replace("Calm and dry.", "Loud."));
    expect((await brief.view()).changed).toBe(0);
  });

  it("refuses a save made against an older file, and leaves the file alone", async () => {
    const { brief, root, file } = await setup();
    const v = await brief.view();
    const theirs = AGENT.replace("Calm and dry.", "Theirs.");
    await writeFile(join(root, "brief.md"), theirs);
    await expect(brief.setSection(0, "Purpose", "Mine.", v.hash)).rejects.toMatchObject({ status: 409, code: "brief_changed" });
    expect(await file()).toBe(theirs);
  });

  it("refuses a heading that is not at that position", async () => {
    const { brief, file } = await setup();
    await expect(brief.setSection(0, "Tone", "x", (await brief.view()).hash)).rejects.toMatchObject({ status: 400 });
    expect(await file()).toBe(AGENT);
  });

  it("approving sets the status line, and editing an approved brief reopens it", async () => {
    const { brief, file } = await setup();
    const a = await brief.setStatus("approved", (await brief.view()).hash);
    expect(a.status).toBe("approved");
    expect(await file()).toBe(AGENT.replace("Status: draft", "Status: approved"));
    const e = await brief.setSection(1, "Tone", "Different.", a.hash);
    expect(e.status).toBe("draft");
    expect(await file()).toContain("Status: draft");
  });

  it("does not follow a link, and does not treat a folder as a brief", async () => {
    const a = await setup(null);
    await writeFile(join(a.root, "elsewhere.md"), AGENT);
    await symlink(join(a.root, "elsewhere.md"), join(a.root, "brief.md"));
    expect((await a.brief.view()).exists).toBe(false);
    const b = await setup(null);
    await mkdir(join(b.root, "brief.md"));
    expect((await b.brief.view()).exists).toBe(false);
  });

  it("shows what the file says: a status the agent wrote itself is shown as it is, because the file is the record", async () => {
    const { brief } = await setup(AGENT.replace("Status: draft", "Status: approved"));
    expect((await brief.view()).status).toBe("approved");
  });

  it("does not read a file too big to be a brief", async () => {
    const { brief } = await setup("# Brief\n\n## A\n" + "x".repeat(1_000_001));
    expect((await brief.view()).exists).toBe(false);
  });

  it("the starter template reads and approves like any brief", async () => {
    const { brief } = await setup(briefTemplate("Lumen"));
    const v = await brief.view();
    expect(v.sections).toHaveLength(9);
    expect((await brief.setStatus("approved", v.hash)).status).toBe("approved");
  });

  it("start() notices a change made outside the dashboard and announces it", async () => {
    const { brief, store, root } = await setup();
    const heard: string[] = [];
    store.on("change", (e: { file: string }) => heard.push(e.file));
    const stop = brief.start(50);
    try {
      await expect.poll(() => heard.includes("brief"), { timeout: 3000 }).toBe(true);
      heard.length = 0;
      await writeFile(join(root, "brief.md"), AGENT.replace("Calm and dry.", "Elsewhere."));
      await expect.poll(() => heard.includes("brief"), { timeout: 3000 }).toBe(true);
      expect((await brief.view()).sections[1]).toMatchObject({ current: "Elsewhere.", changed: false });
    } finally {
      stop();
    }
  });
});
