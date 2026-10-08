import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { RushesClient } from "../../src/mcp/client.js";
import { addVariant } from "../../src/core/project.js";

/** An MCP client talking to the Rushes at `url`. */
async function mcpOn(url: string) {
  const server = createMcpServer({ client: async () => new RushesClient(url), openBrowser: () => undefined, doctor: async () => [] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0].text };
  };
  return { client, call };
}

describe("labels for agents (§22.4)", () => {
  it("rushes_add_version takes a label of 48 characters at most, and says to put the detail in note", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const t = await mcpOn(s.url);
    const ok = await t.call("rushes_add_version", { video: "Lumen launch film", file: "renders/lumen_v1.mp4", note: "v1: the long detail", label: "First pass" });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.text).version).toMatchObject({ label: "First pass", note: "v1: the long detail" });
    const long = await t.call("rushes_add_version", { video: "Lumen launch film", file: "renders/lumen_v1.mp4", label: "x".repeat(49) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain("48");
    const { tools } = await t.client.listTools();
    const add = tools.find((x) => x.name === "rushes_add_version")!;
    expect((add.inputSchema as any).properties.label).toMatchObject({ maxLength: 48 });
    expect(add.description).toMatch(/short `label`/);
    await t.client.close();
    await s.close();
  });
});

describe("the Change Log for agents (§22.7)", () => {
  it("rushes_log adds a line as the agent; rushes_get_log reads back newest first, with what it left out", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const t = await mcpOn(s.url);
    await t.call("rushes_add_version", { video: "Lumen launch film", file: "renders/lumen_v1.mp4", note: "v1: first pass; rough", label: "First pass" });
    const added = await t.call("rushes_log", { text: "Decided to slow the zooms\nthe first cut felt rushed", area: "picture" });
    expect(added.isError).toBe(false);
    expect(JSON.parse(added.text).entry).toMatchObject({ text: "Decided to slow the zooms the first cut felt rushed", by: "agent", area: "picture" });
    const one = JSON.parse((await t.call("rushes_get_log", { limit: 1 })).text);
    expect(one.entries.map((e: { text: string }) => e.text)).toEqual(["Decided to slow the zooms the first cut felt rushed"]);
    expect(one.earlier).toBe(1);
    const picture = JSON.parse((await t.call("rushes_get_log", { area: "picture" })).text);
    expect(picture.entries.map((e: { text: string }) => e.text)).toEqual(["Decided to slow the zooms the first cut felt rushed", "v1 added: First pass"]);
    expect((await t.call("rushes_get_log", { limit: 201 })).isError).toBe(true);
    expect((await t.call("rushes_log", { text: "" })).isError).toBe(true);
    const { tools } = await t.client.listTools();
    expect(tools.find((x) => x.name === "rushes_log")!.description).toMatch(/already logs cuts, formats/);
    expect(tools.find((x) => x.name === "rushes_get_log")!.description).toMatch(/start of a session/);
    expect(tools.find((x) => x.name === "rushes_export_notes")!.description).toMatch(/change-log-<date>\.md/);
    await t.client.close();
    await s.close();
  });

  it("a real ref round-trips onto the line, and one that isn't there is refused in words (I1, M5)", async () => {
    const { root, store } = await tmpProject("Lumen launch film");
    let variantId = "";
    await store.update("project", (p) => {
      variantId = addVariant(p, { stage: "music", lane: "night-drive", name: "Night drive", file: "audio/night.wav" }).variant.id;
    });
    const s = await startServer(root, { port: 0 });
    const t = await mcpOn(s.url);
    const ok = await t.call("rushes_log", { text: "Settled on the quiet bed", area: "music", ref: `night-drive/${variantId}` });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.text).entry.ref).toBe(`night-drive/${variantId}`);
    const gone = await t.call("rushes_log", { text: "Opened a bed that isn't there", ref: "night-drive/nope" });
    expect(gone.isError).toBe(true);
    expect(gone.text).toMatch(/ref "night-drive\/nope" not found/);
    const { tools } = await t.client.listTools();
    const props = (tools.find((x) => x.name === "rushes_log")!.inputSchema as any).properties;
    expect(props.ref.description).toContain("<section>:<take>");
    expect(props.video).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(props.version).toMatchObject({ minLength: 1, maxLength: 64 });
    expect(props.ref).toMatchObject({ minLength: 1, maxLength: 300 });
    await t.client.close();
    await s.close();
  });

  it("rushes_log says one line per decision and never to copy a note or reply into it, and lists what Rushes logs itself (I2, M3)", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const t = await mcpOn(s.url);
    const { tools } = await t.client.listTools();
    const d = tools.find((x) => x.name === "rushes_log")!.description!;
    expect(d).toMatch(/one line per decision, not a running commentary/);
    expect(d).toMatch(/never copy a note's or reply's text into it/);
    expect(d).toMatch(/picture lock/);
    expect(d).toMatch(/files added/);
    expect(d).toMatch(/bring-ins/);
    expect(tools.find((x) => x.name === "rushes_get_log")!.description).toMatch(/`dropped`/);
    await t.client.close();
    await s.close();
  });

  it("against an older Rushes, both tools say to restart it, in words (§22.9)", async () => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify({ ok: true }));
      }
      res.statusCode = 404;
      res.end("404 Not Found");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const t = await mcpOn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    for (const [name, args] of [["rushes_log", { text: "x" }], ["rushes_get_log", {}]] as const) {
      const r = await t.call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).toMatch(/older than/);
      expect(r.text, name).toMatch(/rushes stop/);
    }
    await t.client.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("passes since through, and says what the server refused instead of dropping it", async () => {
    const { root } = await tmpProject("Lumen launch film");
    const s = await startServer(root, { port: 0 });
    const t = await mcpOn(s.url);
    await t.call("rushes_log", { text: "Moved the logo hold earlier" });
    const names = async (a: Record<string, unknown>) => JSON.parse((await t.call("rushes_get_log", a)).text).entries.map((e: { text: string }) => e.text);
    expect(await names({ since: "2000-01-01T00:00:00Z" })).toEqual(["Moved the logo hold earlier"]);
    expect(await names({ since: "2999-01-01T00:00:00Z" })).toEqual([]);
    const bad = await t.call("rushes_get_log", { since: "yesterday" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/since/);
    const nowhere = await t.call("rushes_log", { text: "Opened a cut that isn't there", video: "No such film" });
    expect(nowhere.isError).toBe(true);
    expect(nowhere.text).toMatch(/No such film/);
    expect((await names({})).includes("Opened a cut that isn't there")).toBe(false);
    const defaults = JSON.parse((await t.call("rushes_get_log")).text);
    expect(defaults.entries[0]).toMatchObject({ area: "project", by: "agent" });
    await t.call("rushes_log", { text: "Picked a calmer bed", area: "music" });
    expect(await names({ area: "music" })).toEqual(["Picked a calmer bed"]);
    for (let i = 0; i < 31; i++) await t.call("rushes_log", { text: `Tweak ${i}` });
    const page = JSON.parse((await t.call("rushes_get_log")).text);
    expect(page.entries).toHaveLength(30);
    expect(page.earlier).toBeGreaterThan(0);
    await t.client.close();
    await s.close();
  });
});
