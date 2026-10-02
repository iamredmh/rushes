import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { tmpProject } from "../helpers/tmp.js";
import { readLock } from "../../src/server/lock.js";

const cli = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

// Runs against the built package, the way an agent harness launches it.
describe.skipIf(!existsSync(cli))("built package over stdio", () => {
  it("an agent can open Rushes, which starts its own background server", async () => {
    const { root } = await tmpProject("e2e");
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp"], cwd: root, stderr: "pipe" });
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(transport);

    // rushes_open starts a background server with a 120-minute idle timer. If an assertion
    // below throws, the test must still stop it rather than leave it running for the rest of
    // the run, so everything after connecting is wrapped in try/finally.
    try {
      const r = (await client.callTool({ name: "rushes_open", arguments: { browser: false } })) as { content: { text: string }[] };
      const { url } = JSON.parse(r.content[0].text);
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/p\/[a-z2-9]{8}\/$/);

      const v = (await client.callTool({ name: "rushes_add_version", arguments: { video: "Hero", file: "renders/v1.mp4" } })) as { content: { text: string }[] };
      expect(JSON.parse(v.content[0].text).version.id).toBe("v1");

      await client.close();
      const lock = await readLock(root);
      expect(lock).not.toBeNull();
    } finally {
      await client.close().catch(() => undefined);
      const lock = await readLock(root);
      if (lock) process.kill(lock.pid, "SIGTERM");
    }
  });
});
