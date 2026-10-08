import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { RushesClient } from "../../src/mcp/client.js";

async function connect() {
  const { root } = await tmpProject("cue-files");
  const running = await startServer(root, { port: 0 });
  const server = createMcpServer({ client: async () => new RushesClient(running.url), openBrowser: () => undefined, doctor: async () => [] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { isError: !!r.isError, text: r.content[0].text, json: r.isError ? null : JSON.parse(r.content[0].text) };
  };
  return { client, call, close: async () => { await client.close(); await running.close(); } };
}

type Prop = { description?: string; items?: { properties: Record<string, Prop>; required?: string[] } };

describe("rushes_add_variant: a cue's file (§23.4)", () => {
  it("describes `file` on each cue, keeps name and t required, and passes it through", async () => {
    const t = await connect();
    const { tools } = await t.client.listTools();
    const cues = (tools.find((x) => x.name === "rushes_add_variant")!.inputSchema.properties as Record<string, Prop>).cues;
    expect(cues.description).toMatch(/`file`/);
    expect(cues.items!.properties.file.description).toMatch(/the sample you placed at this cue/);
    expect(cues.items!.required).toEqual(["name", "t"]);
    const r = await t.call("rushes_add_variant", {
      stage: "sfx", name: "Effects for Lumen", file: "pass.wav",
      cues: [{ name: "thud", t: 1, file: "sfx/thud_low_03.wav" }, { name: "click", t: 2 }],
    });
    expect(r.isError).toBe(false);
    expect(r.json.variant.cues).toEqual([{ id: "thud", name: "thud", t: 1, file: "sfx/thud_low_03.wav" }, { id: "click", name: "click", t: 2 }]);
    await t.close();
  });

  it("reports a cue file that isn't audio, and refuses one over 1024 characters", async () => {
    const t = await connect();
    const bad = await t.call("rushes_add_variant", { stage: "sfx", name: "Pass", file: "pass.wav", cues: [{ name: "key", t: 1, file: "notes.json" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Cue "key": "notes\.json" isn't an audio file/);
    const long = await t
      .call("rushes_add_variant", { stage: "sfx", name: "Pass", file: "pass.wav", cues: [{ name: "thud", t: 1, file: `${"a".repeat(1021)}.wav` }] })
      .catch((e: Error) => ({ isError: true, text: e.message, json: null }));
    expect(long.isError).toBe(true);
    await t.close();
  });
});
