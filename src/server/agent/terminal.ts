// "Sign in" (§5.1, §34): Rushes never runs a login itself. It opens a terminal window with the agent's own login
// command for the user to run there, and never sees what they type. A Mac opens Terminal, Windows a Command Prompt,
// Linux the first terminal it finds; with none, the desk shows the command to copy.
import { execFile, spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RushesError } from "../../core/errors.js";
import { findOnPath, spawnEnv, windowsSystemTool } from "./spawn.js";

/** How long the sign-in file is kept after the terminal is asked to open it. */
export const SIGN_IN_FILE_MS = 60_000;

/**
 * Opens a terminal running the sign-in. `command` is always an AgentInfo.signIn (what the desk shows), never text from a
 * request; `argv`, when given, is the detected program's path and its login arguments, which run in its place.
 */
export type TerminalOpener = (command: string, argv?: string[], opts?: TerminalOptions) => Promise<void>;

/** §35.5: where the command runs (the project folder, for a resume), and the file's name, for the window's title. */
export interface TerminalOptions {
  cwd?: string;
  name?: string;
}

/** A word for /bin/sh: single-quoted, with any single quote closed, escaped and reopened. */
export const shQuote = (s: string): string => (/^[A-Za-z0-9_./:=@+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * A word for a .cmd file. A path can't hold `"`, so double quotes are enough, but cmd still expands `%` inside them: a
 * `%` is doubled. Words that cmd reads as more than text (`& | < > ^`) are only ever inside the quotes.
 */
export const cmdQuote = (s: string): string => `"${s.replace(/%/g, "%%").replace(/"/g, "")}"`;

/**
 * The sign-in file's body for this OS: only the login command, then a pause on Windows so the window stays to read. With
 * `cwd` (§35.5's resume), it first goes to that folder, and stops there if it can't.
 */
export function signInScript(platform: NodeJS.Platform, command: string, argv?: string[], cwd?: string): string {
  if (platform === "win32") {
    const line = argv?.length ? argv.map(cmdQuote).join(" ") : command;
    const go = cwd ? `cd /d ${cmdQuote(cwd)} || exit /b 1\r\n` : "";
    return `@echo off\r\n${go}${line}\r\necho.\r\necho You can close this window.\r\npause >nul\r\n`;
  }
  const line = argv?.length ? argv.map(shQuote).join(" ") : command;
  const go = cwd ? `cd ${shQuote(cwd)} || exit 1\n` : "";
  return `#!/bin/sh\n${go}${line}\n`;
}

/** Linux terminals tried in order, each with the words that make it run a program. */
export const LINUX_TERMINALS: readonly { bin: string; args: (file: string) => string[] }[] = [
  { bin: "x-terminal-emulator", args: (f) => ["-e", f] },
  { bin: "gnome-terminal", args: (f) => ["--", f] },
  { bin: "konsole", args: (f) => ["-e", f] },
  { bin: "xfce4-terminal", args: (f) => ["-x", f] },
  { bin: "xterm", args: (f) => ["-e", f] },
];

const noTerminal = (command: string) =>
  new RushesError(`Rushes couldn't open a terminal here. Run \`${command}\` in a terminal, then try again.`, 501, "no_terminal", { command });

/** Starts a window and lets it go: Rushes doesn't wait for the user to finish signing in. */
function launch(file: string, args: string[], opts: { windowsVerbatimArguments?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", env: spawnEnv(), ...opts });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function terminalOpener(o: { platform?: NodeJS.Platform; find?: (bin: string) => string | null } = {}): TerminalOpener {
  const platform = o.platform ?? process.platform;
  const find = o.find ?? ((bin: string) => findOnPath(bin));
  return async (command, argv, opts = {}) => {
    const linuxTerminal = platform !== "darwin" && platform !== "win32" ? LINUX_TERMINALS.find((t) => find(t.bin)) : undefined;
    if (platform !== "darwin" && platform !== "win32" && !linuxTerminal) throw noTerminal(command);
    const dir = await mkdtemp(join(tmpdir(), "rushes-sign-in-"));
    const name = opts.name ?? "sign-in";
    const file = join(dir, platform === "win32" ? `${name}.cmd` : platform === "darwin" ? `${name}.command` : `${name}.sh`);
    await writeFile(file, signInScript(platform, command, argv, opts.cwd), { mode: 0o700 });
    if (platform !== "win32") await chmod(file, 0o700);
    // The terminal has read the file long before this: the folder goes, quietly, whatever happens.
    setTimeout(() => void rm(dir, { recursive: true, force: true }).catch(() => undefined), SIGN_IN_FILE_MS).unref();
    try {
      if (platform === "darwin") {
        await new Promise<void>((resolve, reject) => {
          execFile("open", ["-a", "Terminal", file], (error) => (error ? reject(error) : resolve()));
        });
      } else if (platform === "win32") {
        // `start "" "<file>"` opens it in a new console window. The path is Rushes's own temp file.
        await launch(process.env.ComSpec || windowsSystemTool("cmd.exe"), ["/d", "/c", `start "" "${file}"`], { windowsVerbatimArguments: true });
      } else {
        await launch(find(linuxTerminal!.bin)!, linuxTerminal!.args(file));
      }
    } catch {
      throw noTerminal(command);
    }
  };
}

/** The default for this computer. */
export const openInTerminal: TerminalOpener = (command, argv, opts) => terminalOpener()(command, argv, opts);
