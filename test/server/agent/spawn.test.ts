// §34: finding and starting programs on macOS, Linux and Windows.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { extraPathDirs, findOnPath, killTree, searchPath, shimTarget, spawnEnv, unshim } from "../../../src/server/agent/spawn.js";

describe("findOnPath", () => {
  it("POSIX: the first folder on the path that has it", () => {
    const have = new Set(["/b/claude", "/c/claude"]);
    expect(findOnPath("claude", { platform: "darwin", env: {}, path: "/a:/b:/c", exists: (p) => have.has(p) })).toBe("/b/claude");
    expect(findOnPath("codex", { platform: "linux", env: {}, path: "/a:/b", exists: (p) => have.has(p) })).toBeNull();
  });

  it("Windows: each folder with every PATHEXT extension, in order, so npm's claude.cmd is found", () => {
    const have = new Set(["C:\\Users\\Red\\AppData\\Roaming\\npm\\claude.cmd", "C:\\Users\\Red\\AppData\\Roaming\\npm\\claude"]);
    const found = findOnPath("claude", {
      platform: "win32", env: { PATHEXT: ".COM;.EXE;.BAT;.CMD" }, path: "C:\\Windows;C:\\Users\\Red\\AppData\\Roaming\\npm", exists: (p) => have.has(p),
    });
    // The extensionless file npm also writes (a sh script for Git Bash) is never picked: Windows can't run it.
    expect(found).toBe("C:\\Users\\Red\\AppData\\Roaming\\npm\\claude.cmd");
  });

  it("Windows: an .exe before a .cmd in the same folder, a quoted folder, and PATHEXT unset", () => {
    const have = new Set(["C:\\Program Files\\x\\codex.exe", "C:\\Program Files\\x\\codex.cmd"]);
    expect(findOnPath("codex", { platform: "win32", env: {}, path: '"C:\\Program Files\\x"', exists: (p) => have.has(p) })).toBe("C:\\Program Files\\x\\codex.exe");
  });
});

describe("the search path", () => {
  it("POSIX: the user's PATH first, then the Node running Rushes, nvm, volta, npm's global bin and the old three", () => {
    const dirs = extraPathDirs({ platform: "darwin", env: { NVM_BIN: "/n/bin" }, home: "/Users/r", execPath: "/opt/node/bin/node", npmPrefix: "/opt/npm" });
    expect(dirs).toEqual([
      "/opt/node/bin", "/n/bin", "/Users/r/.volta/bin", "/opt/npm/bin", "/Users/r/.npm-global/bin", "/Users/r/.bun/bin",
      "/opt/homebrew/bin", "/usr/local/bin", "/Users/r/.local/bin",
    ]);
    const path = searchPath({ platform: "darwin", env: { PATH: "/usr/bin:/opt/homebrew/bin" }, home: "/Users/r", execPath: "/opt/node/bin/node", npmPrefix: null });
    const parts = path.split(":");
    expect(parts.slice(0, 2)).toEqual(["/usr/bin", "/opt/homebrew/bin"]);
    expect(new Set(parts).size).toBe(parts.length);
  });

  it("Windows: %APPDATA%\\npm, the native installer's folder and Path spelled as Windows does, without repeats in any case", () => {
    const env = { Path: "C:\\Windows;c:\\users\\red\\appdata\\roaming\\npm", APPDATA: "C:\\Users\\Red\\AppData\\Roaming" };
    const path = searchPath({ platform: "win32", env, home: "C:\\Users\\Red", execPath: "C:\\Program Files\\nodejs\\node.exe", npmPrefix: null });
    const parts = path.split(";");
    expect(parts[0]).toBe("C:\\Windows");
    expect(parts).toContain("C:\\Program Files\\nodejs");
    expect(parts).toContain("C:\\Users\\Red\\.local\\bin");
    expect(parts.filter((p) => p.toLowerCase() === "c:\\users\\red\\appdata\\roaming\\npm")).toHaveLength(1);
  });

  it("spawnEnv puts the path under one PATH key, and an extra PATH wins", () => {
    const env = spawnEnv({ PATH: "/only", X: "1" });
    expect(env.X).toBe("1");
    expect(Object.keys(env).filter((k) => k.toUpperCase() === "PATH")).toHaveLength(1);
    expect(env.PATH ?? env.Path).toBe("/only");
  });
});

describe("killTree", () => {
  it("ends a child and the process it started", { timeout: 15_000 }, async () => {
    // The child starts a grandchild and prints its pid; killTree must end both.
    const script = "const {spawn}=require('child_process');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(g.pid);setInterval(()=>{},1000)";
    const child = spawn(process.execPath, ["-e", script], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
    const grandchild = await new Promise<number>((r) => child.stdout!.once("data", (d) => r(Number(String(d).trim()))));
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    killTree(child, "SIGKILL");
    await exited;
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 50 && alive(grandchild); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
  });
});

describe("§34: npm's Windows shims", () => {
  const SHIM = [
    "@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join("\r\n");
  const shim = "C:\\Users\\Red\\AppData\\Roaming\\npm\\claude.cmd";
  const target = "C:\\Users\\Red\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";

  it("reads the script behind a shim, never node.exe", () => {
    expect(shimTarget(shim, SHIM)).toBe(target);
    expect(shimTarget(shim, "@echo off\r\necho hi")).toBeNull();
  });

  it("unshim gives the script on Windows when it is there, and the path as it is otherwise", () => {
    expect(unshim(shim, { platform: "win32", read: () => SHIM, exists: () => true })).toBe(target);
    expect(unshim(shim, { platform: "win32", read: () => SHIM, exists: () => false })).toBe(shim);
    expect(unshim("C:\\Users\\Red\\.local\\bin\\claude.exe", { platform: "win32" })).toBe("C:\\Users\\Red\\.local\\bin\\claude.exe");
    expect(unshim("/usr/local/bin/claude", { platform: "darwin" })).toBe("/usr/local/bin/claude");
  });
});
