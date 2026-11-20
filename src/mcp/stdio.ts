import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, type ToolContext } from "./tools.js";
import { ensureServer, type EnsureOptions } from "./ensure.js";
import { runDoctor, realDoctorEnv } from "../cli/doctor.js";
import { isProjectRoot, projectPath } from "../core/projectFolder.js";
import { hereKey } from "../server/lock.js";

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
  const root = projectPath(defaultRoot, project);
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
  return projectPath(defaultRoot, project);
}

/**
 * R17: for a pinned server (the one Send to AI hands its agent, `rushes mcp <root> --pinned`), the only folder a
 * tool may name is `root`: `project` left out, or resolving to it (symlinks resolved). Anything else throws, and the
 * tool returns that as its error, so an auto-allowed rushes_* call can't write .rushes/ into another folder.
 */
export function pinnedRoot(root: string, project?: string): string {
  if (!isProjectRoot(root, project)) throw new Error(`This Rushes MCP server only works on ${root}. Leave "project" out, or pass that folder.`);
  return root;
}

export interface StdioOptions {
  /** R17: every tool works on the launch folder only. */
  pinned?: boolean;
}

/** The tool context runStdio uses. */
export function stdioContext(defaultRoot: string, ensure?: EnsureOptions, opts: StdioOptions = {}): ToolContext {
  const forTool = opts.pinned ? (p?: string) => pinnedRoot(defaultRoot, p) : (p?: string) => resolveProjectRoot(defaultRoot, p);
  const forDoctor = opts.pinned ? (p?: string) => pinnedRoot(defaultRoot, p) : (p?: string) => resolveDoctorRoot(defaultRoot, p);
  return {
    client: async (project) => ensureServer(forTool(project), ensure),
    openBrowser,
    here: (project) => hereKey(forTool(project)),
    doctor: async (project) => runDoctor(realDoctorEnv(forDoctor(project))),
  };
}

/** Run the MCP server over stdio. Projects default to the directory the agent launched it in. */
export async function runStdio(defaultRoot = process.cwd(), opts: StdioOptions = {}): Promise<void> {
  const server = createMcpServer(stdioContext(defaultRoot, undefined, opts));
  await server.connect(new StdioServerTransport());
}
