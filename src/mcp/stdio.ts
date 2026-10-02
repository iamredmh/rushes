import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./tools.js";
import { ensureServer } from "./ensure.js";

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
}

/** Run the MCP server over stdio. Projects default to the directory the agent launched it in. */
export async function runStdio(defaultRoot = process.cwd()): Promise<void> {
  const server = createMcpServer({
    client: (project) => ensureServer(resolve(defaultRoot, project ?? ".")),
    openBrowser,
  });
  await server.connect(new StdioServerTransport());
}
