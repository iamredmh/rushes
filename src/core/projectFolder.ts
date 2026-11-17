import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { real } from "./agentRules.js";

/**
 * `project` against the launch folder. A leading "~" or "~/" is the home folder, as a shell would
 * read it: agents write paths that way, and resolve() alone would make a folder called "~" in the
 * working directory.
 */
export function projectPath(defaultRoot: string, project = "."): string {
  const fromHome = project === "~" || /^~[\\/]/.test(project);
  return resolve(defaultRoot, fromHome ? join(homedir(), project.slice(2)) : project);
}

/**
 * R17: true when a tool's `project` argument names `root` itself: left out, or a string that resolves to the same
 * folder, symlinks resolved. Anything else (another folder, a non-string) is false.
 */
export function isProjectRoot(root: string, project: unknown): boolean {
  if (project === undefined) return true;
  if (typeof project !== "string") return false;
  return real(projectPath(root, project)) === real(root);
}
