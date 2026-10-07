import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { tmpProject } from "../helpers/tmp.js";
import { startServer } from "../../src/server/start.js";
import { createMcpServer } from "../../src/mcp/tools.js";
import { RushesClient } from "../../src/mcp/client.js";

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
