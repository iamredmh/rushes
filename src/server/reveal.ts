import { spawn } from "node:child_process";
import { dirname } from "node:path";

/** Reveals a file on disk in the system file manager. */
export type Revealer = (abs: string) => Promise<void>;

/**
 * Reveals `abs` in Finder (macOS), Explorer (Windows) or the default file manager (elsewhere),
 * spawned without a shell, detached, with its own stdio ignored. Errors are swallowed (logged to
 * stderr) rather than thrown, since a failed reveal shouldn't fail the request that asked for it.
 *
 * Honours RUSHES_NO_REVEAL=1: instead of spawning anything, it logs `reveal <abs>` to stderr.
 * Tests set this (see vitest.config.ts and the e2e fixture) so nothing ever opens Finder.
 */
export const osRevealer: Revealer = async (abs) => {
  if (process.env.RUSHES_NO_REVEAL === "1") {
    console.error(`reveal ${abs}`);
    return;
  }
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", ["-R", abs]]
      : process.platform === "win32"
        ? ["explorer.exe", ["/select," + abs]]
        : ["xdg-open", [dirname(abs)]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => console.error(`Couldn't reveal ${abs}: ${(e as Error).message}`));
    child.unref();
  } catch (e) {
    console.error(`Couldn't reveal ${abs}: ${(e as Error).message}`);
  }
};
