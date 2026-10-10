import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

/** Reveals a file on disk in the system file manager. */
export type Revealer = (abs: string) => Promise<void>;

/** Opens a file in its default application. */
export type Opener = (abs: string) => Promise<void>;

export { OPEN_SAFE_EXT } from "../core/extensions.js";

/**
 * Reveals `abs` in Finder (macOS), Explorer (Windows) or the default file manager (elsewhere),
 * spawned without a shell, detached, with its own stdio ignored. Errors are swallowed (logged to
 * stderr) rather than thrown, since a failed reveal shouldn't fail the request that asked for it.
 *
 * A directory (used for §16.5's `POST /api/reveal { project: true }`, which reveals the project
 * root) is opened directly rather than selected inside its parent: macOS gets `open <abs>`
 * instead of `open -R <abs>`, Windows gets `explorer.exe <abs>` instead of `/select,<abs>`, and
 * the other platforms' `xdg-open` already takes a directory as-is.
 *
 * Honours RUSHES_NO_REVEAL=1: instead of spawning anything, it logs `reveal <abs>` to stderr.
 * Tests set this (see vitest.config.ts and the e2e fixture) so nothing ever opens Finder.
 */
export const osRevealer: Revealer = async (abs) => {
  if (process.env.RUSHES_NO_REVEAL === "1") {
    console.error(`reveal ${abs}`);
    return;
  }
  const isDir = await stat(abs).then((s) => s.isDirectory(), () => false);
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? isDir ? ["open", [abs]] : ["open", ["-R", abs]]
      : process.platform === "win32"
        ? isDir ? ["explorer.exe", [abs]] : ["explorer.exe", ["/select," + abs]]
        : ["xdg-open", [isDir ? abs : dirname(abs)]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => console.error(`Couldn't reveal ${abs}: ${(e as Error).message}`));
    child.unref();
  } catch (e) {
    console.error(`Couldn't reveal ${abs}: ${(e as Error).message}`);
  }
};

/**
 * Opens `abs` in its default application: `open <abs>` on macOS, `explorer.exe <abs>` on Windows
 * (never `cmd /c start`, since that runs through a shell), `xdg-open <abs>` elsewhere. Spawned
 * without a shell, detached, with its own stdio ignored; errors are logged rather than thrown.
 *
 * Honours RUSHES_NO_REVEAL=1 exactly as osRevealer does: it logs `open <abs>` and opens nothing.
 */
export const osOpener: Opener = async (abs) => {
  if (process.env.RUSHES_NO_REVEAL === "1") {
    console.error(`open ${abs}`);
    return;
  }
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin" ? ["open", [abs]] : process.platform === "win32" ? ["explorer.exe", [abs]] : ["xdg-open", [abs]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", (e) => console.error(`Couldn't open ${abs}: ${(e as Error).message}`));
    child.unref();
  } catch (e) {
    console.error(`Couldn't open ${abs}: ${(e as Error).message}`);
  }
};
