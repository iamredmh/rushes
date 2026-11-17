import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

it("rushes mcp <folder> serves that folder, not the working directory", async () => {
  const { root } = await tmpProject();
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "rushes unrelated ")));
  cleanup.push(() => rm(elsewhere, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: resolve("node_modules/.bin/tsx"),
    args: [resolve("src/cli/index.ts"), "mcp", root],
    cwd: elsewhere,
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  cleanup.push(() => client.close());
  await client.connect(transport);
  const r = (await client.callTool({ name: "rushes_doctor", arguments: {} })) as { content: { text: string }[] };
  const checks = JSON.parse(r.content[0].text) as { id: string; detail: string }[];
  // The project's own files were checked: it read the given folder. In the working directory it would say "No Rushes project".
  expect(checks.some((c) => c.id.startsWith("file:"))).toBe(true);
  expect(checks.find((c) => c.id === "project")?.detail).not.toBe("No Rushes project in this folder.");
}, 30000);
