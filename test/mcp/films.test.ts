import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { RushesClient } from "../../src/mcp/client.js";
import { addVersion } from "../../src/core/project.js";

// §31.6: the MCP tools that read or write a film's material take `film`. With one film it may be left out; with
// several, leaving it out is an error that lists the films. A batch names its film.

async function connect(films: string[]) {
  const { root, store } = await tmpProject("caffeine");
  await store.update("project", (p) => {
    for (const f of films) addVersion(p, { video: f, file: `renders/${f}.mp4` });
  });
  const running = await startServer(root, { port: 0 });
  const server = createMcpServer({ client: async () => new RushesClient(running.url), openBrowser: () => undefined, doctor: async () => [] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = r.content[0].text;
    return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
  };
  return { call, close: async () => { await client.close(); await running.close(); } };
}

describe("MCP film arguments (§31.6)", () => {
  it("refuses a film's material with no film in a two-film project, listing the films", async () => {
    const t = await connect(["Meet your agents", "Five views"]);
    try {
      for (const [tool, args] of [
        ["rushes_get_script", {}],
        ["rushes_set_script", { sections: [{ start: 0, end: 2, current: "x" }] }],
        ["rushes_list_notes", {}],
        ["rushes_get_log", {}],
        ["rushes_list_assets", {}],
      ] as const) {
        const r = await t.call(tool, args);
        expect(r.isError, tool).toBe(true);
        expect(r.text, tool).toMatch(/2 films.*Meet your agents \(meet-your-agents\), Five views \(five-views\)/);
      }
      // Status without a film is the project's: tabs, films and where each film's plan files are, no film's plan.
      const status = (await t.call("rushes_status")).json;
      expect(status.brief).toBeUndefined();
      expect(status.plans["five-views"]).toEqual({ brief: "films/five-views/brief.md", storyboard: "films/five-views/storyboard.md" });
      expect(status.note).toMatch(/2 films/);
    } finally {
      await t.close();
    }
  });

  it("reads and writes the film named, by id or name, and a batch names its film", async () => {
    const t = await connect(["Meet your agents", "Five views"]);
    try {
      expect((await t.call("rushes_set_script", { film: "Five views", sections: [{ start: 0, end: 2, current: "Five" }] })).isError).toBe(false);
      expect((await t.call("rushes_get_script", { film: "five-views" })).json.script.sections.map((s: { current: string }) => s.current)).toEqual(["Five"]);
      expect((await t.call("rushes_get_script", { film: "meet-your-agents" })).json.script.sections).toEqual([]);
      expect((await t.call("rushes_status", { film: "five-views" })).json.build).toBeDefined();
      expect((await t.call("rushes_list_notes", { film: "five-views" })).json.notes).toEqual([]);
      expect(Array.isArray((await t.call("rushes_get_log", { film: "five-views" })).json.entries)).toBe(true);
      expect(Array.isArray((await t.call("rushes_list_assets", { film: "five-views" })).json.assets)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("needs no film with one film", async () => {
    const t = await connect(["Hero"]);
    try {
      expect((await t.call("rushes_set_script", { sections: [{ start: 0, end: 2, current: "Hi" }] })).isError).toBe(false);
      expect((await t.call("rushes_get_script")).json.script.sections).toHaveLength(1);
      expect((await t.call("rushes_list_notes")).isError).toBe(false);
      expect((await t.call("rushes_status")).json.brief).toBeDefined();
    } finally {
      await t.close();
    }
  });
});
