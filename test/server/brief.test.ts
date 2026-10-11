import { describe, expect, it } from "vitest";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { BriefService } from "../../src/server/brief.js";
import { createApp } from "../../src/server/app.js";
import { briefTemplate } from "../../src/cli/new.js";
import { hashText } from "../../src/core/brief.js";

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

describe("BriefService: files that are not what it expects", () => {
  it("announces a brief.md that is deleted or replaced by a folder, not only one that is edited", async () => {
    const { brief, store, root } = await setup();
    const heard: string[] = [];
    store.on("change", (e: { file: string }) => heard.push(e.file));
    const stop = brief.start(50);
    try {
      await expect.poll(() => heard.includes("brief"), { timeout: 3000 }).toBe(true);
      heard.length = 0;
      await rm(join(root, "brief.md"));
      await expect.poll(() => heard.includes("brief"), { timeout: 3000 }).toBe(true);
      expect((await brief.view()).exists).toBe(false);
    } finally {
      stop();
    }
  });

  it("refuses to save over a file that is not UTF-8 text, and leaves its bytes alone", async () => {
    const { brief, root } = await setup(null);
    const bytes = Buffer.concat([Buffer.from("# Brief: Lumen\n\n## Purpose\nCaf"), Buffer.from([0xe9, 0xff]), Buffer.from("\n")]);
    await writeFile(join(root, "brief.md"), bytes);
    const v = await brief.view();
    expect(v.exists).toBe(true);
    await expect(brief.setSection(0, "Purpose", "New.", v.hash)).rejects.toThrow(/UTF-8/);
    await expect(brief.setStatus("approved", v.hash)).rejects.toThrow(/UTF-8/);
    expect((await readFile(join(root, "brief.md"))).equals(bytes)).toBe(true);
  });

  it("refuses a save when the file changes between the check and the write", async () => {
    const { store, root } = await setup();
    // The agent writes in the moment after the check: the second look at the file sees something else.
    class Racy extends BriefService {
      looks = 0;
      protected override async readText(): Promise<string | null> {
        const text = await super.readText();
        this.looks++;
        return this.looks >= 2 && text !== null ? text + "\nThe agent added a line.\n" : text;
      }
    }
    const brief = new Racy(store);
    const v = await new BriefService(store).view();
    brief.looks = 0;
    await expect(brief.setSection(1, "Tone", "Mine.", v.hash)).rejects.toMatchObject({ code: "brief_changed" });
    expect(await readFile(join(root, "brief.md"), "utf8")).toBe(AGENT);
  });
});

describe("brief over HTTP", () => {
  async function app(text: string | null = AGENT) {
    const s = await setup(text);
    const server = createApp(s.store, { brief: s.brief });
    const call = async (method: string, path: string, json?: unknown) => {
      const res = await server.request(path, { method, headers: json === undefined ? undefined : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
      return { status: res.status, json: (await res.json()) as any };
    };
    return { ...s, call };
  }

  it("state carries the brief, and tabs carry its summary", async () => {
    const { call } = await app();
    const state = await call("GET", "/api/state");
    expect(state.json.brief).toMatchObject({ exists: true, status: "draft", changed: 0 });
    expect(state.json.brief.sections).toHaveLength(2);
    const tabs = await call("GET", "/api/tabs");
    expect(tabs.json.brief).toEqual({ exists: true, status: "draft", changed: 0 });
  });

  it("state says there is no brief when there is no file", async () => {
    const { call } = await app(null);
    expect((await call("GET", "/api/state")).json.brief).toMatchObject({ exists: false, sections: [] });
    expect((await call("GET", "/api/tabs")).json.brief).toEqual({ exists: false, status: null, changed: 0 });
  });

  it("saves a section and sets the status", async () => {
    const { call, file } = await app();
    const hash = (await call("GET", "/api/state")).json.brief.hash;
    const saved = await call("PUT", "/api/brief/sections/0", { heading: "Purpose", text: "Mine.", hash });
    expect(saved.status).toBe(200);
    expect(saved.json.brief.sections[0].yours).toBe("Mine.");
    expect(await file()).toContain("## Purpose\nMine.\n");
    const approved = await call("PUT", "/api/brief/status", { status: "approved", hash: saved.json.brief.hash });
    expect(approved.json.brief.status).toBe("approved");
  });

  it("answers 409 brief_changed for a stale hash, 400 for a bad index or body, 404 with no file", async () => {
    const { call } = await app();
    expect((await call("PUT", "/api/brief/sections/0", { heading: "Purpose", text: "x", hash: "stale" })).json.error).toBe("brief_changed");
    expect((await call("PUT", "/api/brief/sections/-1", { heading: "Purpose", text: "x", hash: "a" })).status).toBe(400);
    expect((await call("PUT", "/api/brief/sections/0", { heading: "Purpose" })).status).toBe(400);
    const none = await app(null);
    expect((await none.call("PUT", "/api/brief/status", { status: "approved", hash: hashText("x") })).status).toBe(404);
  });
});
