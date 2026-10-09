import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { ApiError, RushesClient } from "../../src/mcp/client.js";
import { ensureServer, findServer } from "../../src/mcp/ensure.js";
import { resolveDoctorRoot, resolveProjectRoot, stdioContext } from "../../src/mcp/stdio.js";
import { lockPath } from "../../src/server/lock.js";
import { SOURCE } from "../../src/setup/harnesses.js";
import { runDoctor, realDoctorEnv } from "../../src/cli/doctor.js";
import { addVariant, addVersion } from "../../src/core/project.js";
import { sizedProbe } from "../helpers/probe.js";
import type { VideoProber } from "../../src/core/media.js";

type Probe = (abs: string) => Promise<number | null>;

async function connect(opts: { files?: string[]; probe?: Probe; formatProbe?: VideoProber } = {}) {
  const { root } = await tmpProject("spring-launch");
  for (const f of opts.files ?? []) {
    await mkdir(dirname(join(root, f)), { recursive: true });
    await writeFile(join(root, f), "bytes");
  }
  const running = await startServer(root, { port: 0, found: opts.probe ? { probe: opts.probe } : undefined, formats: opts.formatProbe ? { probe: opts.formatProbe } : undefined });
  const opened: string[] = [];
  const server = createMcpServer({
    client: async () => new RushesClient(running.url),
    openBrowser: (u) => opened.push(u),
    doctor: async () => runDoctor(realDoctorEnv(root)),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0].text;
    return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { root, running, call, client, opened, close: async () => { await client.close(); await running.close(); } };
}

describe("MCP tools", () => {
  it("lists the twenty-two tools", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      "rushes_add_file", "rushes_add_format", "rushes_add_take", "rushes_add_variant", "rushes_add_version", "rushes_bring_in", "rushes_doctor", "rushes_export_notes",
      "rushes_get_batch", "rushes_get_log", "rushes_get_picks", "rushes_get_script", "rushes_list_assets", "rushes_list_notes",
      "rushes_lock_picture", "rushes_log", "rushes_open", "rushes_reply", "rushes_scan", "rushes_set_script", "rushes_set_shots", "rushes_status",
    ]);
    const set = tools.find((x) => x.name === "rushes_set_script")!;
    expect((set.inputSchema.properties as Record<string, { description?: string }>).replace.description).toMatch(/replace the whole script; default merges by id/);
    await t.close();
  });

  it("steers voiceover to whole reads in rounds, not takes", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const tool = (n: string) => tools.find((x) => x.name === n)!;
    const prop = (n: string, p: string) => (tool(n).inputSchema.properties as Record<string, { description?: string }>)[p].description ?? "";
    const take = tool("rushes_add_take").description ?? "";
    expect(take).toMatch(/^Compatibility only/);
    expect(take).toMatch(/Voiceover tab and the mix ignore takes/);
    expect(take).toMatch(/rushes_add_variant/);
    expect(take).toMatch(/round/);
    expect(tool("rushes_add_variant").description).toMatch(/voice read \(in a round\)/);
    expect(tool("rushes_add_variant").description).not.toMatch(/VO lane variant/);
    expect(prop("rushes_add_variant", "lane")).toMatch(/Defaults to `round` slugged, else the stage/);
    expect(prop("rushes_add_variant", "lane")).toMatch(/wins over `round`/i);
    expect(tool("rushes_get_picks").description).toMatch(/per round on Voiceover/);
    expect(tool("rushes_get_picks").description).not.toMatch(/take per script section/);
    await t.close();
  });

  it("set_script merges by id, replace swaps the whole list, get_script reads it all", async () => {
    const t = await connect();
    await t.call("rushes_set_script", { sections: [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }] });
    await t.call("rushes_set_script", { sections: [{ id: "s1", start: 0, end: 10, current: "A2" }] });
    const got = await t.call("rushes_get_script");
    expect(got.json.script.sections.map((x: any) => [x.id, x.current])).toEqual([["s1", "A2"], ["s2", "B"]]);
    await t.call("rushes_set_script", { replace: true, sections: [{ id: "s2", start: 0, end: 10, current: "B" }] });
    expect((await t.call("rushes_get_script")).json.script.sections.map((x: any) => x.id)).toEqual(["s2"]);
    await t.close();
  });

  it("runs the full review loop: add cut, user notes, batch, agent replies", async () => {
    const t = await connect();
    expect((await t.call("rushes_open")).json.url).toBe(t.running.dashboardUrl);
    expect(t.opened).toEqual([t.running.dashboardUrl]);

    const v = await t.call("rushes_add_version", { video: "Hero 60s", file: "renders/hero_v1.mp4" });
    expect(v.json.version.id).toBe("v1");

    // The user leaves a note and presses Send in the dashboard.
    const api = new RushesClient(t.running.url);
    const note = (await api.post("/api/notes", { stage: "picture", video: "hero-60s", version: "v1", scope: "point", t: 12.4, text: "Logo lands early" })).note;
    await api.post("/api/batches", { stage: "picture" });

    const batch = await t.call("rushes_get_batch");
    expect(batch.json.batch.id).toBe("b_1");
    expect(batch.json.notes.map((n: any) => n.id)).toEqual([note.id]);

    await t.call("rushes_add_version", { video: "hero-60s", file: "renders/hero_v2.mp4", note: "logo hold" });
    const r = await t.call("rushes_reply", { replies: [{ id: note.id, reply: "Held 0.5 s", status: "done", fixT: 12.9, fixVersion: "v2" }] });
    expect(r.json.notes[0]).toMatchObject({ status: "done", fixT: 12.9 });

    expect((await t.call("rushes_list_notes", { stage: "picture", status: "todo" })).json.notes).toEqual([]);
    const status = await t.call("rushes_status");
    expect(status.json.tabs.find((x: any) => x.stage === "picture")).toMatchObject({ unlocked: true, todo: 0 });
    await t.close();
  });

  it("script, takes, variants and picks", async () => {
    const t = await connect();
    await t.call("rushes_set_script", { sections: [{ start: 0, end: 13, current: "Your work lives on one laptop." }] });
    expect((await t.call("rushes_add_take", { section: "s1", file: "audio/s1.wav" })).json.take.id).toBe("t1");
    expect((await t.call("rushes_add_variant", { stage: "music", name: "Deep house", file: "a.wav", meta: { bpm: 120 } })).json.variant.id).toBe("deep-house");
    expect((await t.call("rushes_get_picks")).json).toMatchObject({ lanes: {}, sections: {} });
    await t.close();
  });

  it("rushes_add_variant passes round through, naming and slugging the lane for it (§18.4)", async () => {
    const t = await connect();
    const r = await t.call("rushes_add_variant", { stage: "voice", name: "Gerald", file: "g.wav", round: "Round 1 · Voices" });
    expect(r.json.lane).toMatchObject({ id: "round-1-voices", name: "Round 1 · Voices", stage: "voice" });
    await t.close();
  });

  it("rushes_add_variant takes a description and stores it as meta.description, over any in meta", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const props = tools.find((x) => x.name === "rushes_add_variant")!.inputSchema.properties as Record<string, { description?: string }>;
    expect(props.description?.description ?? "").toMatch(/meta\.description/);
    const r = await t.call("rushes_add_variant", { stage: "voice", name: "Gerald", file: "g.wav", round: "Round 1", description: "Warmer, slower intro" });
    expect(r.json.variant.meta).toEqual({ description: "Warmer, slower intro" });
    const m = await t.call("rushes_add_variant", { stage: "music", name: "Bed", file: "b.wav", meta: { bpm: 120, description: "old" }, description: "New" });
    expect(m.json.variant.meta).toEqual({ bpm: 120, description: "New" });
    await t.close();
  });

  it("rushes_open's url is the project's own dashboard address", async () => {
    const t = await connect();
    const r = await t.call("rushes_open", { browser: false });
    expect(r.json.url).toMatch(/\/p\/[a-z2-9]{8}\/$/);
    expect(r.json.url).toBe(t.running.dashboardUrl);
    expect(t.opened).toEqual([]);
    await t.close();
  });

  it("rushes_set_shots sets a cut's shot list, rushes_lock_picture locks and unlocks it", async () => {
    const t = await connect();
    await t.call("rushes_add_version", { video: "Hero 60s", file: "renders/hero_v1.mp4" });

    const set = await t.call("rushes_set_shots", {
      video: "hero-60s",
      shots: [{ name: "Wide", start: 0 }, { name: "Logo", start: 5, tag: "brand" }],
    });
    expect(set.json.version.shots).toEqual([
      { n: 1, name: "Wide", start: 0, tag: "" },
      { n: 2, name: "Logo", start: 5, tag: "brand" },
    ]);

    const locked = await t.call("rushes_lock_picture", { video: "hero-60s", version: "v1" });
    expect(locked.json.video.lockedVersion).toBe("v1");

    const unlocked = await t.call("rushes_lock_picture", { video: "hero-60s", version: null });
    expect(unlocked.json.video.lockedVersion).toBeNull();
    await t.close();
  });

  it("rushes_set_shots and rushes_lock_picture accept the video's display name, not just its id", async () => {
    const t = await connect();
    await t.call("rushes_add_version", { video: "Hero 60s", file: "renders/hero_v1.mp4" });
    const set = await t.call("rushes_set_shots", { video: "Hero 60s", shots: [{ name: "Wide", start: 0 }] });
    expect(set.json.version.shots).toEqual([{ n: 1, name: "Wide", start: 0, tag: "" }]);
    const locked = await t.call("rushes_lock_picture", { video: "Hero 60s", version: "v1" });
    expect(locked.json.video.lockedVersion).toBe("v1");
    await t.close();
  });

  it("rushes_list_assets round-trips the same list the API gives, and filters by kind", async () => {
    const t = await connect();
    await t.call("rushes_add_version", { video: "Hero 60s", file: "renders/hero_v1.mp4" });
    await t.call("rushes_add_variant", { stage: "music", name: "Deep house", file: "a.wav" });
    const api = new RushesClient(t.running.url);
    const direct = await api.get<{ assets: any[] }>("/api/assets");
    const viaTool = await t.call("rushes_list_assets");
    expect(viaTool.json.assets).toEqual(direct.assets);
    const cuts = await t.call("rushes_list_assets", { kind: "cut" });
    expect(cuts.json.assets).toHaveLength(1);
    expect(cuts.json.assets[0]).toMatchObject({ kind: "cut", video: "hero-60s", version: "v1" });
    await t.close();
  });

  it("rushes_add_file registers a file, listed by rushes_list_assets under its kind", async () => {
    const t = await connect();
    const added = await t.call("rushes_add_file", { kind: "doc", file: "brief.md", name: "Creative brief", note: "v2" });
    expect(added.json).toMatchObject({ kind: "doc", file: "brief.md", name: "Creative brief", note: "v2" });
    const assets = await t.call("rushes_list_assets", { kind: "doc" });
    // name is the file's own basename; the given display name goes in label (I2).
    expect(assets.json.assets).toMatchObject([{ path: "brief.md", name: "brief.md", label: "Creative brief" }]);
    await t.close();
  });

  it("rushes_export_notes writes the file and returns its path", async () => {
    const t = await connect();
    const r = await t.call("rushes_export_notes");
    expect(r.json.path).toMatch(/^exports\/spring-launch-notes-\d{4}-\d{2}-\d{2}\.md$/);
    const exported = await readFile(join(t.root, r.json.path), "utf8");
    expect(exported).toContain("spring-launch — notes");
    await t.close();
  });

  it("rushes_doctor returns the checks array for the connected project", async () => {
    const t = await connect();
    const r = await t.call("rushes_doctor");
    expect(Array.isArray(r.json)).toBe(true);
    const project = r.json.find((c: any) => c.id === "project");
    // tmpProject() already ran store.init(), so the project files all parse.
    expect(project).toBeUndefined();
    expect(r.json.find((c: any) => c.id === "file:project")).toMatchObject({ ok: true, required: true });
    await t.close();
  });

  it("returns readable tool errors instead of throwing", async () => {
    const t = await connect();
    const r = await t.call("rushes_reply", { replies: [{ id: "n_missing", reply: "x" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain('note "n_missing" not found');
    const b = await t.call("rushes_get_batch");
    expect(b.isError).toBe(true);
    await t.close();
  });
});

describe("ensureServer", () => {
  it("finds a running server for the same root", async () => {
    const { root } = await tmpProject();
    const s = await startServer(root, { port: 0 });
    expect(await findServer(root)).toBe(s.url);
    const c = await ensureServer(root, { spawnServer: () => { throw new Error("should not spawn"); } });
    expect(c.baseUrl).toBe(s.url);
    await s.close();
  });

  it("ignores a lock that points at another project's server, and starts its own", async () => {
    const { root: other } = await tmpProject("other");
    const otherServer = await startServer(other, { port: 0 });
    const { root } = await tmpProject("mine");
    // A stale lock whose pid is alive (ours) but whose port belongs to the other project.
    await writeFile(lockPath(root), JSON.stringify({ port: otherServer.port, pid: process.pid, startedAt: "x" }), "utf8");
    expect(await findServer(root)).toBeNull();
    let mine: Awaited<ReturnType<typeof startServer>> | undefined;
    const c = await ensureServer(root, { spawnServer: (r) => { void startServer(r, { port: 0 }).then((s) => { mine = s; }); } });
    expect(c.baseUrl).not.toBe(otherServer.url);
    expect((await c.get("/api/health")).root).toBe(root);
    await mine?.close();
    await otherServer.close();
  });

  it("parallel calls for one root share a single spawn", async () => {
    const { root } = await tmpProject();
    let spawns = 0;
    const started: Awaited<ReturnType<typeof startServer>>[] = [];
    const spawnServer = (r: string) => {
      spawns++;
      void startServer(r, { port: 0 }).then((s) => { started.push(s); }, () => undefined);
    };
    const clients = await Promise.all(Array.from({ length: 5 }, () => ensureServer(root, { spawnServer })));
    expect(spawns).toBe(1);
    expect(new Set(clients.map((c) => c.baseUrl)).size).toBe(1);
    // Once settled, the next call looks again instead of reusing the old promise.
    await ensureServer(root, { spawnServer });
    expect(spawns).toBe(1);
    for (const s of started) await s.close();
  });

  it("gives a clear error when no server comes up", async () => {
    const { root } = await tmpProject();
    const err = ensureServer(root, { spawnServer: () => undefined, timeoutMs: 400 });
    await expect(err).rejects.toThrow(/did not start/);
    // The hint names the current install source (the npm package, §19.7), not the old GitHub form.
    await expect(err).rejects.toThrow(`npx -y ${SOURCE} open`);
  });

  it("a failed default start leaves its output in .rushes/server.log and the error names that file", async () => {
    const { root } = await tmpProject();
    const log = join(root, ".rushes", "server.log");
    // Under vitest the default spawn points at src/cli/index.js, which doesn't exist, so node fails at once.
    await expect(ensureServer(root, { timeoutMs: 400 })).rejects.toThrow(log);
    let text = "";
    for (let i = 0; i < 40 && !text.includes("Cannot find module"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      text = await readFile(log, "utf8").catch(() => "");
    }
    expect(text).toContain("Cannot find module");
  });

  it("doesn't crash if defaultSpawn fails to start (missing cli, no permissions, etc)", async () => {
    const { root } = await tmpProject();
    // When no spawnServer override is provided, defaultSpawn is used, which will fail because
    // src/cli/index.js doesn't exist yet (it's built in a later task). The error listener should
    // prevent an unhandled 'error' event from crashing the process, and ensureServer should
    // time out and throw a readable error instead.
    await expect(ensureServer(root, { timeoutMs: 400 })).rejects.toThrow(/did not start/);
  });
});

describe("project root for stdio", () => {
  const ASK = 'Tell me which project folder to use: pass "project" (e.g. "/Users/you/Videos/launch-film").';

  it("refuses / and the home folder, which is where Claude Desktop starts it", () => {
    expect(() => resolveProjectRoot("/")).toThrow(ASK);
    expect(() => resolveProjectRoot(homedir())).toThrow(ASK);
    expect(() => resolveProjectRoot(join(homedir(), "Videos"), "..")).toThrow(ASK);
    expect(resolveProjectRoot("/", "/Users/you/Videos/launch-film")).toBe("/Users/you/Videos/launch-film");
    expect(resolveProjectRoot("/work/film")).toBe("/work/film");
    expect(resolveProjectRoot("/work", "film")).toBe("/work/film");
  });

  it("reads a leading ~ as the home folder, not as a folder called ~ in the working directory", () => {
    // An agent often writes "~/Videos/launch-film". Without this, the server would be started in
    // <cwd>/~/Videos/launch-film and mkdir -p would create that folder, with a .rushes in it.
    const home = homedir();
    expect(resolveProjectRoot("/work", "~/Videos/launch-film")).toBe(join(home, "Videos", "launch-film"));
    expect(resolveProjectRoot("/", "~/Videos")).toBe(join(home, "Videos"));
    expect(() => resolveProjectRoot("/work", "~")).toThrow(ASK);
    expect(resolveDoctorRoot("/work", "~/Videos/launch-film")).toBe(join(home, "Videos", "launch-film"));
    // Only a leading "~" or "~/" means home. A folder that merely starts with a tilde, and another
    // user's "~name", are ordinary relative names.
    expect(resolveProjectRoot("/work", "~film")).toBe("/work/~film");
    expect(resolveProjectRoot("/work", "film/~/x")).toBe("/work/film/~/x");
  });

  it("a tool started in / returns that error and never spawns a server", async () => {
    let spawns = 0;
    const server = createMcpServer(stdioContext("/", { spawnServer: () => { spawns++; }, timeoutMs: 300 }));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    for (const name of ["rushes_status", "rushes_open"]) {
      const r = (await client.callTool({ name, arguments: { browser: false } })) as { content: { text: string }[]; isError?: boolean };
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(ASK);
    }
    expect(spawns).toBe(0);
    await client.close();
  });
});

// §20.7: the agent surface for finding the project's other files.
describe("MCP tools: finding the project's other files", () => {
  // The cut is "hero v3" (60 s). The theme and the read match its length, time and name.
  const FILES = ["renders/hero v3.mov", "bed/hero v3 theme.wav", "vo_jules/hero v3 read.wav", "stems/other pad.wav", "sfx/whoosh.wav", "notes/brief.md"];
  const LENGTHS: Record<string, number> = { "hero v3.mov": 60, "hero v3 theme.wav": 60, "hero v3 read.wav": 60.4, "other pad.wav": 31 };
  const probe: Probe = async (abs) => LENGTHS[abs.split("/").pop()!] ?? null;

  async function withCut(opts: { files?: string[] } = {}) {
    const t = await connect({ files: opts.files ?? FILES, probe });
    // Let the start-up scan finish before there is a cut, so it can't adopt ahead of the call under test.
    await t.running.found.settled();
    await t.running.store.update("project", (p) => addVersion(p, { video: "hero", file: "renders/hero v3.mov", duration: 60, fps: 25 }));
    return t;
  }

  const props = (tool: { inputSchema: unknown }) => (tool.inputSchema as { properties: Record<string, any>; required?: string[] });

  it("describes rushes_open, rushes_scan and rushes_bring_in, and gives them their schemas", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const tool = (n: string) => tools.find((x) => x.name === n)!;
    expect(tool("rushes_open").description).toMatch(
      /^Starts Rushes if needed, brings in the current set of files that go with the cut, and opens it\. Pass `include` for files you know belong\./,
    );
    const open = props(tool("rushes_open"));
    expect(Object.keys(open.properties).sort()).toEqual(["browser", "film", "include", "project"]);
    expect(open.properties.film.type).toBe("string");
    expect(open.properties.include.type).toBe("array");
    expect(open.properties.include.items.properties.kind.enum).toEqual(["voice", "music", "sfx", "cut", "doc"]);
    expect(Object.keys(open.properties.include.items.properties).sort()).toEqual(["kind", "path", "round"]);
    expect(open.properties.include.items.required).toEqual(["path"]);
    expect(open.properties.include.description).toMatch(/win over the scoring/i);

    expect(tool("rushes_scan").description).toMatch(/best score first/);
    expect(tool("rushes_scan").description).toMatch(/reasons/);
    const scan = props(tool("rushes_scan"));
    expect(Object.keys(scan.properties).sort()).toEqual(["film", "limit", "project"]);
    expect(scan.properties.limit).toMatchObject({ type: "integer", default: 100, maximum: 200, minimum: 1 });

    expect(tool("rushes_bring_in").description).toMatch(/inside the project folder/);
    const bring = props(tool("rushes_bring_in"));
    expect(Object.keys(bring.properties).sort()).toEqual(["files", "film", "project"]);
    expect(bring.required).toEqual(["files"]);
    expect(bring.properties.files.items.required).toEqual(["path"]);
    await t.close();
  });

  it("rushes_open scans, adopts the current set and returns what came in and what was left", async () => {
    const t = await withCut();
    const r = await t.call("rushes_open", { browser: false, film: "hero" });
    expect(r.isError).toBe(false);
    expect(r.json.url).toBe(t.running.dashboardUrl);
    expect(r.json.broughtIn.map((a: any) => [a.path, a.kind]).sort()).toEqual([
      ["bed/hero v3 theme.wav", "music"],
      ["vo_jules/hero v3 read.wav", "voice"],
    ]);
    expect(r.json.broughtIn[0].reasons.join(" ")).toMatch(/same length as the cut/);
    expect(r.json.failed).toEqual([]);
    // Left for the user: the pad (no kind), the effect and the brief is a doc (never a candidate).
    expect(r.json.found).toEqual({ voice: 0, music: 0, sfx: 1, cut: 0, other: 1 });
    // Registered unpicked.
    const project = await t.running.store.read("project");
    expect(project.lanes.find((l) => l.id === "music")!.variants.map((v) => v.file)).toEqual(["bed/hero v3 theme.wav"]);
    expect(await t.running.store.read("picks")).toMatchObject({ lanes: {} });
    // A second call brings nothing new in, and still lists this session's.
    const again = await t.call("rushes_open", { browser: false, film: "hero" });
    expect(again.json.broughtIn).toHaveLength(2);
    expect((await t.running.store.read("project")).rev).toBe(project.rev);
    await t.close();
  });

  it("rushes_open's include wins over the scoring and takes files the scoring would never offer", async () => {
    const t = await withCut();
    const r = await t.call("rushes_open", {
      browser: false,
      film: "hero",
      include: [{ path: "stems/other pad.wav", kind: "music" }, { path: "notes/brief.md" }],
    });
    expect(r.json.failed).toEqual([]);
    expect(r.json.broughtIn.map((a: any) => [a.path, a.kind]).sort()).toEqual([
      ["notes/brief.md", "doc"],
      ["stems/other pad.wav", "music"],
      ["vo_jules/hero v3 read.wav", "voice"],
    ]);
    // The scoring's own music pick is not also added: the agent's file is the music.
    const music = (await t.running.store.read("project")).lanes.find((l) => l.id === "music")!;
    expect(music.variants.map((v) => v.file)).toEqual(["stems/other pad.wav"]);
    expect(r.json.found.music).toBe(1);
    await t.close();
  });

  it("rushes_open reports an included file outside the project and still opens", async () => {
    const t = await withCut();
    const r = await t.call("rushes_open", { film: "hero", include: [{ path: "../elsewhere.wav", kind: "music" }] });
    expect(r.isError).toBe(false);
    expect(r.json.failed).toEqual([{ path: "../elsewhere.wav", reason: "That file isn't in the project folder", code: "outside" }]);
    expect(t.opened).toEqual([t.running.dashboardUrl]);
    await t.close();
  });

  it("rushes_open without a cut brings nothing in and says how many files it found", async () => {
    const t = await connect({ files: FILES, probe });
    const r = await t.call("rushes_open", { browser: false });
    expect(r.json.broughtIn).toEqual([]);
    expect(r.json.found).toMatchObject({ voice: 1, music: 1, sfx: 1 });
    await t.close();
  });

  it("rushes_scan returns the ranked candidates with reasons, and the counts", async () => {
    const t = await withCut();
    const r = await t.call("rushes_scan", { film: "hero" });
    expect(r.isError).toBe(false);
    // The scan adopts, as Look again does: the theme and read are in, so the rest are left.
    expect(r.json.files.map((f: any) => f.path).sort()).toEqual(["sfx/whoosh.wav", "stems/other pad.wav"]);
    const pad = r.json.files.find((f: any) => f.path === "stems/other pad.wav");
    expect(pad).toMatchObject({ kind: "other", folder: "stems" });
    expect(pad.reasons).toEqual(expect.any(Array));
    expect(pad).not.toHaveProperty("abs");
    expect(r.json.counts).toEqual({ voice: 0, music: 0, sfx: 1, cut: 0, other: 1 });
    // Best score first.
    const scores = r.json.files.map((f: any) => f.score ?? -1);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    await t.close();
  });

  it("rushes_scan's limit trims the list but not the counts, and refuses more than 200", async () => {
    const many = Array.from({ length: 5 }, (_, i) => `misc/take ${i}.wav`);
    const t = await connect({ files: many, probe });
    const r = await t.call("rushes_scan", { limit: 2 });
    expect(r.json.files).toHaveLength(2);
    expect(r.json.counts.other).toBe(5);
    expect((await t.call("rushes_scan")).json.files).toHaveLength(5);
    expect((await t.call("rushes_scan", { limit: 201 })).isError).toBe(true);
    expect((await t.call("rushes_scan", { limit: 0 })).isError).toBe(true);
    await t.close();
  });

  it("rushes_scan returns 100 candidates by default, whatever the folder holds", async () => {
    const many = Array.from({ length: 120 }, (_, i) => `misc/take ${i}.wav`);
    const t = await connect({ files: many, probe });
    const r = await t.call("rushes_scan");
    expect(r.json.files).toHaveLength(100);
    expect(r.json.counts.other).toBe(120);
    expect((await t.call("rushes_scan", { limit: 200 })).json.files).toHaveLength(120);
    await t.close();
  });

  it("rushes_open lists an include the agent registered itself as alreadyIn, and keeps it winning on the next open", async () => {
    const t = await withCut();
    await t.running.store.update("project", (p) => addVariant(p, { stage: "music", name: "pad", file: "stems/other pad.wav" }));
    const r = await t.call("rushes_open", { browser: false, film: "hero", include: [{ path: "stems/other pad.wav" }] });
    expect(r.json.alreadyIn).toEqual(["stems/other pad.wav"]);
    expect(r.json.failed).toEqual([]);
    const again = await t.call("rushes_open", { browser: false, film: "hero" });
    const music = (await t.running.store.read("project")).lanes.find((l) => l.id === "music")!;
    expect(music.variants.map((v) => v.file)).toEqual(["stems/other pad.wav"]);
    expect(again.json.broughtIn.map((a: any) => [a.path, a.origin]).sort()).toEqual([["vo_jules/hero v3 read.wav", "auto"]]);
    await t.close();
  });

  it("says in its descriptions that the wait is capped and what rushes_scan brings in", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const d = (n: string) => tools.find((x) => x.name === n)!.description!;
    expect(d("rushes_open")).toMatch(/^Starts Rushes if needed, brings in the current set of files that go with the cut, and opens it\. Pass `include` for files you know belong\./);
    expect(d("rushes_open")).toMatch(/waits about 20 seconds/);
    expect(d("rushes_open")).toMatch(/`scanning: true`/);
    expect(d("rushes_scan")).toMatch(/brings in the current set/);
    expect(d("rushes_scan")).toMatch(/waits about 20 seconds/);
    await t.close();
  });

  it("rushes_bring_in registers the files, reports each refusal in the route's words, and picks nothing", async () => {
    const t = await withCut();
    const r = await t.call("rushes_bring_in", {
      film: "hero",
      files: [
        { path: "stems/other pad.wav", kind: "music" },
        { path: "vo_jules/hero v3 read.wav", round: "Round 1" },
        { path: "../elsewhere.wav" },
        { path: join(t.root, "..", "nope.wav"), kind: "voice" },
        { path: "missing.wav", kind: "sfx" },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.json.added.map((a: any) => [a.path, a.kind, a.lane])).toEqual([
      ["stems/other pad.wav", "music", "music"],
      ["vo_jules/hero v3 read.wav", "voice", "round-1"],
    ]);
    expect(r.json.failed).toEqual([
      { path: "../elsewhere.wav", reason: "That file isn't in the project folder", code: "outside" },
      { path: join(t.root, "..", "nope.wav"), reason: "That file isn't in the project folder", code: "outside" },
      { path: "missing.wav", reason: "That file has gone", code: "gone" },
    ]);
    expect(await t.running.store.read("picks")).toMatchObject({ lanes: {} });
    // Again: already in.
    const again = await t.call("rushes_bring_in", { files: [{ path: "stems/other pad.wav", kind: "music" }] });
    expect(again.json).toEqual({ added: [], failed: [{ path: "stems/other pad.wav", reason: "Already in the project.", code: "already" }] });
    await t.close();
  });

  it("rushes_bring_in passes the server's own limits through as a tool error", async () => {
    const t = await withCut();
    const r = await t.call("rushes_bring_in", { files: Array.from({ length: 61 }, (_, i) => ({ path: `vo/${i}.wav` })) });
    expect(r.isError).toBe(true);
    expect((await t.call("rushes_bring_in", { files: [] })).isError).toBe(true);
    await t.close();
  });
});

// A stand-in for a Rushes server, to see what the tools do when the real one is old, slow or unhappy.
async function fakeServer(handle: (req: IncomingMessage, res: ServerResponse, log: string[]) => void) {
  const log: string[] = [];
  const server: Server = createServer((req, res) => {
    log.push(`${req.method} ${req.url}`);
    if (req.url === "/api/health") {
      res.setHeader("content-type", "application/json");
      return void res.end(JSON.stringify({ ok: true }));
    }
    handle(req, res, log);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const opened: string[] = [];
  const mcp = createMcpServer({
    client: async () => new RushesClient(url),
    openBrowser: (u) => void (log.push("open"), opened.push(u)),
    doctor: async () => [],
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0].text };
  };
  return { url, log, opened, call, close: async () => { await client.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}

describe("MCP tools against a server that isn't the current one", () => {
  it("RushesClient turns a body that isn't JSON into an ApiError", async () => {
    const f = await fakeServer((_req, res) => { res.statusCode = 404; res.end("404 Not Found"); });
    const err = await new RushesClient(f.url).post("/api/found/scan", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    await expect(new RushesClient(f.url).get("/api/anything")).rejects.toBeInstanceOf(ApiError);
    await f.close();
  });

  it("rushes_scan and rushes_bring_in against an older Rushes say to restart it, in words", async () => {
    const f = await fakeServer((_req, res) => { res.statusCode = 404; res.end("404 Not Found"); });
    for (const [name, args] of [["rushes_scan", {}], ["rushes_bring_in", { files: [{ path: "a.wav" }] }]] as const) {
      const r = await f.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/older than/);
      expect(r.text, name).toMatch(/rushes stop/);
      expect(r.text, name).not.toMatch(/not_json|isn't JSON/);
    }
    await f.close();
  });

  it("rushes_open against an older Rushes still opens, and says to restart it", async () => {
    const f = await fakeServer((_req, res) => { res.statusCode = 404; res.end("404 Not Found"); });
    const r = await f.call("rushes_open");
    expect(r.isError).toBe(false);
    const json = JSON.parse(r.text);
    expect(json).toMatchObject({ broughtIn: [], failed: [], found: null });
    expect(json.note).toMatch(/older Rushes.*rushes stop/);
    expect(f.opened).toHaveLength(1);
    await f.close();
  });

  it("rushes_add_version against an older Rushes that drops the label says so, and still adds the cut", async () => {
    const f = await fakeServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ video: { id: "hero", name: "Hero" }, version: { id: "v1", file: "renders/hero.mp4", note: "" } }));
    });
    const r = await f.call("rushes_add_version", { video: "Hero", file: "renders/hero.mp4", label: "First pass" });
    expect(r.isError).toBe(false);
    const json = JSON.parse(r.text);
    expect(json.version.id).toBe("v1");
    expect(json.note).toMatch(/older Rushes.*label.*rushes stop/);
    // With no label asked for, there's nothing to say.
    expect(JSON.parse((await f.call("rushes_add_version", { video: "Hero", file: "renders/hero.mp4" })).text).note).toBeUndefined();
    await f.close();
  });

  it("rushes_add_version counts a label in characters, like the route: 48 emoji are accepted, 49 are refused (final review minor)", async () => {
    const f = await fakeServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ video: { id: "hero", name: "Hero" }, version: { id: "v1", file: "renders/hero.mp4", note: "", label: "x" } }));
    });
    const ok = await f.call("rushes_add_version", { video: "Hero", file: "renders/hero.mp4", label: "\u{1F3AC}".repeat(48) });
    expect(ok.isError).toBe(false);
    // What the route doesn't count (zero-width and bidi characters, line breaks, padding) the tool doesn't either.
    const padded = await f.call("rushes_add_version", { video: "Hero", file: "renders/hero.mp4", label: `\n ${"\u{1F3AC}\u200b".repeat(48)}\u202e ` });
    expect(padded.isError).toBe(false);
    const overPadded = await f.call("rushes_add_version", { video: "Hero", file: "renders/hero.mp4", label: "\u{1F3AC}\u200b".repeat(49) });
    expect(overPadded.isError).toBe(true);
    const over = await f.call("rushes_add_version", { video: "Hero", file: "renders/hero.mp4", label: "\u{1F3AC}".repeat(49) });
    expect(over.isError).toBe(true);
    expect(over.text).toContain("label is 48 characters at most: put the detail in note");
    await f.close();
  });

  it("rushes_open opens the browser before it asks for the scan, so a slow or failing scan can't delay it", async () => {
    const f = await fakeServer((_req, res) => { res.statusCode = 500; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "boom", message: "scan blew up" })); });
    const r = await f.call("rushes_open");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("scan blew up");
    expect(f.log.indexOf("open")).toBeGreaterThan(-1);
    expect(f.log.indexOf("open")).toBeLessThan(f.log.indexOf("POST /api/found/scan"));
    await f.close();
  });

  it("rushes_open has the browser open while the scan hasn't answered", async () => {
    const f = await fakeServer(() => undefined); // the scan never answers
    const pending = f.call("rushes_open");
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => (f.opened.length ? resolve() : Date.now() - t0 > 3000 ? reject(new Error("never opened")) : setTimeout(tick, 10));
      tick();
    });
    // rushes_open opens the browser first and posts the scan after, so the server hears the scan a
    // moment later, and on a slow machine a good while later. The test is that it is in flight.
    await expect.poll(() => f.log, { timeout: 3000 }).toContain("POST /api/found/scan");
    await f.close();
    await pending.catch(() => undefined);
  });

  it("surfaces the server's own validation issues, not just 'Request body is invalid'", async () => {
    const f = await fakeServer((_req, res) => {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "invalid", message: "Request body is invalid", issues: [{ path: ["include", 0, "path"], message: "Too small: expected string to have >=1 characters" }] }));
    });
    const r = await f.call("rushes_open", { film: "hero" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Request body is invalid");
    expect(r.text).toContain("include.0.path: Too small");
    await f.close();
  });

  it("rushes_open passes through alreadyIn, scanning and where each file came from", async () => {
    const answer = { ok: true, added: [{ path: "a.wav", kind: "music", origin: "include", reasons: [] }], alreadyIn: ["b.wav"], failed: [], found: { voice: 0, music: 0, sfx: 0, cut: 0, other: 2 }, scanning: true };
    const f = await fakeServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(answer)); });
    const json = JSON.parse((await f.call("rushes_open", { browser: false })).text);
    expect(json).toMatchObject({ broughtIn: answer.added, alreadyIn: ["b.wav"], failed: [], found: answer.found, scanning: true });
    await f.close();
  });
});

describe("MCP tools: input limits mirror the server's", () => {
  it("rejects what the server would, before it is asked", async () => {
    const t = await connect();
    const bad = async (name: string, args: Record<string, unknown>) => (await t.call(name, args)).isError;
    expect(await bad("rushes_open", { include: Array.from({ length: 61 }, () => ({ path: "a.wav" })) })).toBe(true);
    expect(await bad("rushes_open", { include: [{ path: "" }] })).toBe(true);
    expect(await bad("rushes_open", { include: [{ path: "a.wav", round: "" }] })).toBe(true);
    expect(await bad("rushes_open", { include: [{ path: "a.wav", round: "x".repeat(65) }] })).toBe(true);
    expect(await bad("rushes_open", { film: "" })).toBe(true);
    expect(await bad("rushes_bring_in", { files: [] })).toBe(true);
    expect(await bad("rushes_bring_in", { files: Array.from({ length: 61 }, () => ({ path: "a.wav" })) })).toBe(true);
    const { tools } = await t.client.listTools();
    const items = (tools.find((x) => x.name === "rushes_open")!.inputSchema as any).properties.include;
    expect(items.maxItems).toBe(60);
    expect(items.items.properties.path).toMatchObject({ minLength: 1, maxLength: 1024 });
    expect(items.items.properties.round).toMatchObject({ minLength: 1, maxLength: 64 });
    await t.close();
  });
});

describe("formats for agents (§21.4)", () => {
  const FILES = ["renders/hero_1920x1080.mp4", "renders/hero_1080x1920.mp4", "renders/hero_1080x1080.mp4", "renders/hero_720x1280.mp4", "renders/hero_1080x1350@8.4.mp4"];

  it("rushes_add_format registers a shape; a second of the same ratio is refused with the reason and its code", async () => {
    const t = await connect({ files: FILES, formatProbe: sizedProbe });
    await t.call("rushes_add_version", { video: "Hero", file: "renders/hero_1920x1080.mp4" });
    expect((await t.call("rushes_add_format", { file: "renders/hero_1080x1920.mp4" })).json.format).toMatchObject({ id: "9x16", label: "9:16" });
    const again = await t.call("rushes_add_format", { file: "renders/hero_720x1280.mp4" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("v1 already has 9:16. Register a re-render as a new version.");
    expect(again.text).toContain("same_ratio");
    expect((await t.call("rushes_add_format", { file: "renders/hero_1080x1350@8.4.mp4" })).json.warning).toBe("4:5 is 8.4 s; the cut is 8.0 s");
    await t.close();
  });

  it("describes the tools' new inputs", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const props = (n: string) => Object.keys(tools.find((x) => x.name === n)!.inputSchema.properties as object).sort();
    expect(props("rushes_add_format")).toEqual(["file", "label", "project", "version", "video"]);
    expect(props("rushes_add_version")).toContain("formats");
    expect(props("rushes_list_notes")).toEqual(expect.arrayContaining(["format", "onlyThisFormat"]));
    expect(tools.find((x) => x.name === "rushes_add_format")!.description).toMatch(/Register a re-render as a new version|re-render is a new version/);
    await t.close();
  });

  it("rushes_add_version takes formats and registers every shape in one call", async () => {
    const t = await connect({ files: FILES, formatProbe: sizedProbe });
    const r = await t.call("rushes_add_version", { video: "Hero", file: "renders/hero_1920x1080.mp4", formats: [{ file: "renders/hero_1080x1920.mp4" }, { file: "renders/hero_1080x1080.mp4" }] });
    expect(r.json.version.formats.map((f: any) => f.id)).toEqual(["9x16", "1x1"]);
    expect(r.json.note).toBeUndefined();
    await t.close();
  });

  // §21.8 (6): an agent sees format, can filter, and a reply to a format note leaves the others alone.
  it("rushes_list_notes returns format on every note and filters by it", async () => {
    const t = await connect({ files: FILES, formatProbe: sizedProbe });
    await t.call("rushes_add_version", { video: "Hero", file: "renders/hero_1920x1080.mp4", formats: [{ file: "renders/hero_1080x1920.mp4" }] });
    const api = new RushesClient(t.running.url);
    const add = (text: string, format: string | null, at: number) => api.post("/api/notes", { stage: "picture", video: "hero", version: "v1", scope: "point", t: at, text, format });
    await add("Drop the first sound.", null, 1);
    await add("Logo too close to the top.", "9x16", 2);
    await add("Rows land late on wide.", "16x9", 3);
    expect((await t.call("rushes_list_notes", { stage: "picture" })).json.notes.every((n: any) => "format" in n)).toBe(true);
    const withFormat = (await t.call("rushes_list_notes", { format: "9x16" })).json;
    expect(withFormat.notes.map((n: any) => n.text).sort()).toEqual(["Drop the first sound.", "Logo too close to the top."]);
    expect(withFormat.note).toBeUndefined();
    // A ratio label such as "9:16" is the same format.
    expect((await t.call("rushes_list_notes", { format: "9:16" })).json.notes).toEqual(withFormat.notes);
    const onlyCall = (await t.call("rushes_list_notes", { format: "9x16", onlyThisFormat: true })).json;
    expect(onlyCall.note).toBeUndefined();
    const only = onlyCall.notes;
    expect(only.map((n: any) => n.text)).toEqual(["Logo too close to the top."]);
    await t.call("rushes_reply", { replies: [{ id: only[0].id, reply: "Moved the logo down on 9:16.", status: "done" }] });
    const after = (await t.call("rushes_list_notes", { stage: "picture" })).json.notes;
    expect(after.filter((n: any) => n.status === "done").map((n: any) => n.id)).toEqual([only[0].id]);
    await t.close();
  });

  it("the new inputs carry the server's own limits (≤7 formats beside the cut, path ≤1024, id ≤16, label hint ≤16)", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const schema = (n: string) => tools.find((x) => x.name === n)!.inputSchema.properties as Record<string, any>;
    expect(schema("rushes_add_format").file).toMatchObject({ type: "string", maxLength: 1024 });
    expect(schema("rushes_add_format").label).toMatchObject({ type: "string", maxLength: 16 });
    expect(schema("rushes_add_version").formats).toMatchObject({ type: "array", maxItems: 7 });
    expect(schema("rushes_add_version").formats.items.properties.file).toMatchObject({ type: "string", maxLength: 1024 });
    expect(schema("rushes_list_notes").format).toMatchObject({ type: "string", maxLength: 16 });
    expect(schema("rushes_list_notes").format.pattern).toBeTruthy();
    expect(schema("rushes_add_format").video).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(schema("rushes_add_format").version).toMatchObject({ minLength: 1, maxLength: 64 });
    expect(schema("rushes_add_format").label).toMatchObject({ minLength: 1, maxLength: 16 });
    await t.close();
  });

  it("refuses a malformed format id or a blank label before asking the server", async () => {
    const f = await fakeServer((_req, res) => { res.statusCode = 500; res.end("never asked"); });
    for (const format of ["tall", "9x", "x16", "9:16:1"]) {
      const r = await f.call("rushes_list_notes", { format });
      expect(r.isError, format).toBe(true);
      expect(r.text, format).toMatch(/format/);
    }
    const blank = await f.call("rushes_add_format", { file: "renders/hero_1080x1920.mp4", label: "   " });
    expect(blank.isError).toBe(true);
    expect(blank.text).toMatch(/label/);
    expect(f.log).toEqual([]);
    await f.close();
  });

  it("describes every way a format is refused, and that the format filters are for Picture", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const add = tools.find((x) => x.name === "rushes_add_format")!.description!;
    for (const part of [/same ratio|ratio the cut already has/, /isn't a video|not a video/, /ffprobe/, /8 shapes|eight shapes/i, /own file.*main shape|main shape/]) expect(add).toMatch(part);
    const notes = (tools.find((x) => x.name === "rushes_list_notes")!.inputSchema.properties as Record<string, { description?: string }>);
    expect(notes.format.description).toMatch(/Picture/);
    const version = tools.find((x) => x.name === "rushes_add_version")!.description!;
    expect(version).toMatch(/formatWarnings/);
    expect(version).toMatch(/more than 0\.1 s/);
    await t.close();
  });

  it("a format the server's validation refuses comes back as a tool error naming the field", async () => {
    const t = await connect({ files: FILES, formatProbe: sizedProbe });
    await t.call("rushes_add_version", { video: "Hero", file: "renders/hero_1920x1080.mp4" });
    const r = await t.call("rushes_list_notes", { format: "tall" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/format/);
    await t.close();
  });

  it("the server's own validation issues come through a format tool's error", async () => {
    const f = await fakeServer((_req, res) => {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "invalid", message: "Request body is invalid", issues: [{ path: ["label"], message: "Too long" }] }));
    });
    const r = await f.call("rushes_add_format", { file: "a_1080x1920.mp4" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Request body is invalid (invalid): label: Too long");
    await f.close();
  });
});

describe("formats against a server that isn't the current one (§21.4)", () => {
  it("rushes_add_format against an older Rushes says to restart it, in words", async () => {
    const f = await fakeServer((_req, res) => { res.statusCode = 404; res.end("404 Not Found"); });
    const r = await f.call("rushes_add_format", { file: "a_1080x1920.mp4" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/older than/);
    expect(r.text).toMatch(/rushes stop/);
    await f.close();
  });

  it("rushes_add_version with formats against an older Rushes, which drops them, says so", async () => {
    const f = await fakeServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.statusCode = 201;
      res.end(JSON.stringify({ video: { id: "hero", name: "Hero" }, version: { id: "v1", file: "a.mp4" } }));
    });
    const r = await f.call("rushes_add_version", { video: "Hero", file: "a.mp4", formats: [{ file: "b.mp4" }] });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).note).toMatch(/older Rushes.*rushes stop/);
    // No formats asked for, nothing to say.
    expect(JSON.parse((await f.call("rushes_add_version", { video: "Hero", file: "a.mp4" })).text).note).toBeUndefined();
    await f.close();
  });

  it("rushes_add_version against a 0.2.x Rushes that drops both the label and formats says both, exactly (merge of §21 and §22)", async () => {
    // A 0.2.x reply: no label, no formats.
    const old = await fakeServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ video: { id: "hero", name: "Hero" }, version: { id: "v1", file: "a.mp4", note: "" } }));
    });
    const both = JSON.parse((await old.call("rushes_add_version", { video: "Hero", file: "a.mp4", label: "logo hold", formats: [{ file: "b.mp4" }] })).text).note;
    expect(both).toBe("An older Rushes is running and dropped the label and ignored `formats`: the cut is in, without its label and without its other shapes. Run `rushes stop`, then open again and add the shapes with rushes_add_format.");
    expect(JSON.parse((await old.call("rushes_add_version", { video: "Hero", file: "a.mp4", label: "logo hold" })).text).note).toBe(
      "An older Rushes is running and dropped the label: the cut was added without it. Run `rushes stop`, then open again.",
    );
    expect(JSON.parse((await old.call("rushes_add_version", { video: "Hero", file: "a.mp4", formats: [{ file: "b.mp4" }] })).text).note).toBe(
      "An older Rushes is running and ignored `formats`: the cut is in, its other shapes are not. Run `rushes stop`, then add them with rushes_add_format.",
    );
    await old.close();
    // A Rushes that keeps the label but has no formats says only the formats; one that keeps both says nothing.
    const labelOnly = await fakeServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ video: { id: "hero", name: "Hero" }, version: { id: "v1", file: "a.mp4", note: "", label: "logo hold" } }));
    });
    expect(JSON.parse((await labelOnly.call("rushes_add_version", { video: "Hero", file: "a.mp4", label: "logo hold", formats: [{ file: "b.mp4" }] })).text).note).toMatch(/^An older Rushes is running and ignored `formats`/);
    await labelOnly.close();
    const current = await fakeServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ video: { id: "hero", name: "Hero" }, version: { id: "v1", file: "a.mp4", note: "", label: "logo hold", formats: [] } }));
    });
    expect(JSON.parse((await current.call("rushes_add_version", { video: "Hero", file: "a.mp4", label: "logo hold", formats: [{ file: "b.mp4" }] })).text).note).toBeUndefined();
    await current.close();
  });

  it("the two meanings of `label` are told apart in the tools' own words", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const prop = (tool: string) => (tools.find((x) => x.name === tool)!.inputSchema.properties as Record<string, { description?: string }>).label.description!;
    expect(prop("rushes_add_version")).toMatch(/short label for the version list/);
    expect(prop("rushes_add_format")).toMatch(/ratio hint only/);
    expect(prop("rushes_add_format")).toMatch(/Not the cut's short label/);
    await t.close();
  });

  it("rushes_list_notes with a format against an older Rushes, which ignores it, says so", async () => {
    const f = await fakeServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ notes: [{ id: "n_1", stage: "picture", text: "a" }] }));
    });
    const r = await f.call("rushes_list_notes", { format: "9x16" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).note).toMatch(/older Rushes.*rushes stop/);
    expect(JSON.parse((await f.call("rushes_list_notes", {})).text).note).toBeUndefined();
    await f.close();
  });
});
