import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type ToolContext } from "./tools.js";
import { ensureServer, type EnsureOptions } from "./ensure.js";
import { runDoctor, realDoctorEnv } from "../cli/doctor.js";

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).on("error", () => undefined).unref();
}

/**
 * The project folder a tool call is about: `project` resolved against the
 * folder the harness launched us in. Claude Desktop launches MCP servers in
 * "/" (and some harnesses in the home folder), which is never a video
 * project, so those throw and ask the agent to name one.
 */
export function resolveProjectRoot(defaultRoot: string, project?: string): string {
  const root = resolve(defaultRoot, project ?? ".");
  if (dirname(root) === root || root === resolve(homedir())) {
    throw new Error('Tell me which project folder to use: pass "project" (e.g. "/Users/you/Videos/launch-film").');
  }
  return root;
}

/**
 * Same resolution as `resolveProjectRoot`, but for `rushes_doctor`: controller ruling, doctor
 * never refuses to run just because it was launched at "/" or the home folder. It still reports
 * the Node/ffmpeg/agent checks; its own project checks fall back to "No Rushes project in this
 * folder" there, same as any other folder with no .rushes.
 */
export function resolveDoctorRoot(defaultRoot: string, project?: string): string {
  return resolve(defaultRoot, project ?? ".");
}

/** The tool context runStdio uses. */
export function stdioContext(defaultRoot: string, ensure?: EnsureOptions): ToolContext {
  return {
    client: async (project) => ensureServer(resolveProjectRoot(defaultRoot, project), ensure),
    openBrowser,
    doctor: async (project) => runDoctor(realDoctorEnv(resolveDoctorRoot(defaultRoot, project))),
  };
}

/** Run the MCP server over stdio. Projects default to the directory the agent launched it in. */
export async function runStdio(defaultRoot = process.cwd()): Promise<void> {
  const server = createMcpServer(stdioContext(defaultRoot));
  await server.connect(new StdioServerTransport());
}
