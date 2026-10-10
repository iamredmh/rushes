import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { createMcpServer } from "../../src/mcp/tools.js";

/** A client linked in memory to `server`, already connected. */
export async function linkedClient(server: ReturnType<typeof createMcpServer>, name = "test"): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
