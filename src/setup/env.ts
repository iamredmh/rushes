import { spawn } from "node:child_process";
import { homedir } from "node:os";
import type { SetupEnv } from "./setup.js";

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    let out = "";
    const child = spawn(cmd, args, { cwd, shell: process.platform === "win32" });
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    child.on("error", (e) => ok({ code: 127, out: e.message }));
    child.on("close", (code) => ok({ code: code ?? 1, out }));
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
