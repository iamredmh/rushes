import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { SetupEnv } from "./setup.js";

/**
 * Runs `cmd` and collects its output. With `timeout` (doctor's checks), the command gets no stdin
 * -- so one waiting on input finishes rather than stalling -- and is killed once the time is up,
 * resolving with `timedOut: true` without waiting for it to exit.
 */
function run(cmd: string, args: string[], cwd?: string, opts: { timeout?: number } = {}): Promise<{ code: number; out: string; timedOut?: boolean }> {
  return new Promise((ok) => {
    let out = "";
    let settled = false;
    const done = (r: { code: number; out: string; timedOut?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ok(r);
    };
    const limited = opts.timeout !== undefined;
    const child = spawn(cmd, args, { cwd, shell: process.platform === "win32", ...(limited ? { stdio: ["ignore", "pipe", "pipe"] as const } : {}) });
    const timer = limited
      ? setTimeout(() => {
          child.kill("SIGKILL");
          done({ code: 124, out, timedOut: true });
        }, opts.timeout)
      : undefined;
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => done({ code: 127, out: e.message }));
    child.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

/** The real machine: your home folder, PATH lookups and real commands. */
export function realSetupEnv(): SetupEnv {
  return {
    home: homedir(),
    platform: process.platform,
    appData: process.env.APPDATA,
    which: async (cmd) => (await run(process.platform === "win32" ? "where" : "which", [cmd])).code === 0,
    exec: run,
  };
}
