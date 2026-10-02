import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { RushesClient } from "../../src/mcp/client.js";
import { ensureServer, findServer } from "../../src/mcp/ensure.js";
import { resolveProjectRoot, stdioContext } from "../../src/mcp/stdio.js";
import { lockPath } from "../../src/server/lock.js";
import { SOURCE } from "../../src/setup/harnesses.js";

async function connect() {
  const { root } = await tmpProject("spring-launch");
  const running = await startServer(root, { port: 0 });
  const opened: string[] = [];
  const server = createMcpServer({ client: async () => new RushesClient(running.url), openBrowser: (u) => opened.push(u) });
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
  it("lists the thirteen tools", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    expect(tools.map((x) => x.name).sort()).toEqual([
      "rushes_add_take", "rushes_add_variant", "rushes_add_version", "rushes_get_batch", "rushes_get_picks",
      "rushes_get_script", "rushes_list_notes", "rushes_lock_picture", "rushes_open", "rushes_reply",
      "rushes_set_script", "rushes_set_shots", "rushes_status",
    ]);
    const set = tools.find((x) => x.name === "rushes_set_script")!;
    expect((set.inputSchema.properties as Record<string, { description?: string }>).replace.description).toMatch(/replace the whole script; default merges by id/);
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
    // The hint names the install source that works today, not an npm package that isn't published.
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
