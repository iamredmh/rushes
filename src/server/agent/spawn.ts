// §34: finding and starting programs the same way on macOS, Linux and Windows. Never through a shell on macOS and
// Linux. On Windows a `.cmd`/`.bat` (how npm installs `claude` and `codex`) can only run through cmd.exe; cross-spawn
// wraps it in `cmd.exe /d /s /c` and escapes every argument for cmd, so an argument can't run anything else.
import { spawn as nodeSpawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import crossSpawn from "cross-spawn";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter as hostDelimiter, posix, win32 } from "node:path";

/** Folders a program may be installed in that a server started from a desktop shortcut or a service may not have on PATH. */
export function extraPathDirs(
  o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string; execPath?: string; npmPrefix?: string | null } = {},
): string[] {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const home = o.home ?? homedir();
  const p = platform === "win32" ? win32 : posix;
  const dirs: string[] = [];
  // The Node running Rushes: npm's global bin is beside it with most installers (nvm, fnm, volta, the official one).
  dirs.push(p.dirname(o.execPath ?? process.execPath));
  if (env.NVM_BIN) dirs.push(env.NVM_BIN);
  dirs.push(p.join(home, ".volta", "bin"));
  const prefix = o.npmPrefix === undefined ? npmGlobalPrefix(platform, env) : o.npmPrefix;
  if (platform === "win32") {
    if (env.APPDATA) dirs.push(p.join(env.APPDATA, "npm"));
    if (prefix) dirs.push(prefix);
    // Claude Code's native installer on Windows puts claude.exe here.
    dirs.push(p.join(home, ".local", "bin"));
    if (env.LOCALAPPDATA) dirs.push(p.join(env.LOCALAPPDATA, "Programs", "nodejs"));
  } else {
    if (prefix) dirs.push(p.join(prefix, "bin"));
    dirs.push(p.join(home, ".npm-global", "bin"), p.join(home, ".bun", "bin"));
    // Before §34, the only extra folders. Kept, in the same order.
    dirs.push("/opt/homebrew/bin", "/usr/local/bin", p.join(home, ".local", "bin"));
  }
  return dirs;
}

/** npm's global prefix without running npm: $npm_config_prefix, else where npm puts it by default for this Node. */
function npmGlobalPrefix(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | null {
  if (env.npm_config_prefix) return env.npm_config_prefix;
  if (platform === "win32") return env.APPDATA ? win32.join(env.APPDATA, "npm") : null;
  return posix.dirname(posix.dirname(process.execPath));
}

/** The user's PATH plus extraPathDirs, without repeats, joined for this platform. */
export function searchPath(o: Parameters<typeof extraPathDirs>[0] = {}): string {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const sep = platform === "win32" ? ";" : platform === process.platform ? hostDelimiter : ":";
  const parts = [...pathOf(env).split(sep), ...extraPathDirs(o)];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of parts) {
    if (!d) continue;
    const key = platform === "win32" ? d.toLowerCase() : d;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.join(sep);
}

/** PATH as Windows spells it too (`Path`). */
function pathOf(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
}

/** The env to start a program with: the user's, with the wider PATH (under the name Windows already uses). */
export function spawnEnv(extra: Record<string, string> = {}, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const key = platform === "win32" ? (Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path") : "PATH";
  env[key] = searchPath({ platform });
  const { PATH, ...rest } = extra;
  if (PATH !== undefined) env[key] = PATH;
  return { ...env, ...rest };
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return isFile(p);
  } catch {
    return false;
  }
};

/**
 * The full path of `bin` on the search path, or null: what `which` (or `where` on Windows) would print, done in Node.
 * On Windows each folder is tried with every PATHEXT extension (`.COM;.EXE;.BAT;.CMD` when unset), in order.
 */
export function findOnPath(
  bin: string,
  o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; path?: string; exists?: (p: string) => boolean } = {},
): string | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const win = platform === "win32";
  const p = win ? win32 : posix;
  const exists = o.exists ?? (win ? isFile : isExecutable);
  const dirs = (o.path ?? searchPath({ platform, env })).split(win ? ";" : ":").filter(Boolean);
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  // A name with its extension already (`claude.exe`) is tried as given first.
  const named = win && /\.[a-z0-9]+$/i.test(bin);
  for (const raw of dirs) {
    const dir = raw.replace(/^"(.*)"$/, "$1");
    if (named && exists(p.join(dir, bin))) return p.join(dir, bin);
    for (const ext of exts) {
      const candidate = p.join(dir, bin + ext.toLowerCase());
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Starts `file` (a full path from findOnPath, or process.execPath) with no shell; a Windows `.cmd`/`.bat` through cmd.exe. */
export function spawnProgram(file: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
  return process.platform === "win32" ? crossSpawn(file, args, opts) : nodeSpawn(file, args, { ...opts, shell: false });
}

/**
 * Stops `child` and everything it started. Windows: `taskkill /T /F` on its tree. Elsewhere the child must have been
 * started with `detached: true` (its own process group): the group gets `signal`. Falls back to the child alone.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

/** npm's own CLI script for the Node running Rushes, run as `node npm-cli.js`; null when it isn't where installers put it. */
export function npmCliScript(execPath: string = process.execPath, platform: NodeJS.Platform = process.platform): string | null {
  const p = platform === "win32" ? win32 : posix;
  const dir = p.dirname(execPath);
  const candidates =
    platform === "win32"
      ? [p.join(dir, "node_modules", "npm", "bin", "npm-cli.js")]
      : [p.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"), p.join(dir, "node_modules", "npm", "bin", "npm-cli.js")];
  return candidates.find((c) => isFile(c)) ?? null;
}

/**
 * §34: the program behind an npm `.cmd` shim, read from the shim, when there is one. npm writes, for a package's bin,
 * `"%_prog%"  "%dp0%\node_modules\<pkg>\<bin>" %*` (or `"%dp0%\node_modules\<pkg>\<bin>.exe" %*` for a native one).
 * Claude's Agent SDK spawns CLAUDE_CODE_EXECUTABLE with no shell, which Node refuses for a .cmd (EINVAL), but runs a
 * `.js` with node itself; so the Claude adapter is given the script. Null when `text` isn't such a shim.
 */
export function shimTarget(shimPath: string, text: string): string | null {
  const targets = [...text.matchAll(/"%~?dp0%?\\([^"%]+)"/gi)].map((m) => m[1]).filter((t) => !/^node(\.exe)?$/i.test(t));
  const last = targets.at(-1);
  return last ? win32.join(win32.dirname(shimPath), last) : null;
}

/** On Windows, the real program behind an npm .cmd/.bat shim when it is there; otherwise `path` as it is. */
export function unshim(path: string, o: { platform?: NodeJS.Platform; read?: (p: string) => string; exists?: (p: string) => boolean } = {}): string {
  const platform = o.platform ?? process.platform;
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(path)) return path;
  try {
    const text = (o.read ?? ((p: string) => readFileSync(p, "utf8")))(path);
    const target = shimTarget(path, text);
    return target && (o.exists ?? isFile)(target) ? target : path;
  } catch {
    return path;
  }
}
