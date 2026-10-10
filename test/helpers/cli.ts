import type { Io } from "../../src/cli/main.js";

/**
 * An Io that collects what the CLI prints and the addresses it opens. A test starts any server
 * itself, so the one the CLI might otherwise start throws.
 */
export function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: string[] = [];
  const x: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    cwd,
    openBrowser: (u) => opened.push(u),
    ensure: { spawnServer: () => { throw new Error("tests start the server themselves"); }, timeoutMs: 300 },
  };
  return { x, out, err, opened };
}
