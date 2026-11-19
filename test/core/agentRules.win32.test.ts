// §34: the Always rules on Windows. Run on any computer: rulesOS says which OS the rules judge for. Every case here is an
// attack that must ask, or a check that a POSIX rule stayed as it was.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alwaysWords, canAlways, decide, plainCommand, rulesOS, type PermissionRequest } from "../../src/core/agentRules.js";
import { shellScript, toRequest } from "../../src/server/agent/broker.js";
import type { AlwaysRule } from "../../src/core/schema.js";

const root = "C:\\Users\\Red\\Projects\\Launch";
const edits = (always: AlwaysRule[] = []) => ({ permissions: "project-edits" as const, always });
const edit = (...paths: string[]): PermissionRequest => ({ kind: "edit", title: "Edit", command: null, paths });
const exec = (command: string): PermissionRequest => ({ kind: "execute", title: command, command, paths: [] });

let was: NodeJS.Platform;
beforeEach(() => {
  was = rulesOS.platform;
  rulesOS.platform = "win32";
});
afterEach(() => {
  rulesOS.platform = was;
});

describe("§34 Windows commands", () => {
  it("Windows shells and runners never make an Always rule, with or without .exe, in any case", () => {
    for (const c of [
      "cmd /c calc", "cmd.exe /c calc", "CMD.EXE /C calc", "C:\\Windows\\System32\\cmd.exe /c x", "powershell -Command x", "powershell.exe -c x",
      "pwsh -c x", "wsl rm", "wsl.exe ls", "bash.exe -c x", "start calc", "start /b x", "cscript x.vbs", "wscript x", "mshta x",
      "rundll32 x", "forfiles /c x", "runas /user:x y", "schtasks /create", "explorer x", "conhost x", "wt x", "call x",
    ]) {
      expect(plainCommand(c), c).toBe(false);
      expect(canAlways(exec(c), root), c).toBe(false);
    }
  });

  it("one Always for `cmd /c` can't exist, and an old file's rule for it is never honoured", () => {
    expect(alwaysWords("cmd /c")).toBeNull();
    expect(decide(exec("cmd /c del /s /q C:\\"), edits([{ kind: "execute", command: "cmd /c" }]), root)).toBe("ask");
    expect(decide(exec("start /b calc"), edits([{ kind: "execute", command: "start /b" }]), root)).toBe("ask");
  });

  it("a /x word is a flag, never a subcommand", () => {
    expect(alwaysWords("git /c")).toBeNull();
    expect(alwaysWords("npm test")).toEqual(["npm", "test"]);
  });

  it("% is refused (cmd expands it); a backslash still is", () => {
    expect(plainCommand("npm test %PATH%")).toBe(false);
    expect(plainCommand("npm run build")).toBe(true);
    expect(plainCommand("node C:\\x\\y.js")).toBe(false);
  });

  it("the broker reads the script out of cmd and PowerShell, so a rule names the real command and a chained one asks", () => {
    expect(shellScript(["cmd", "/c", "npm test"])).toBe("npm test");
    expect(shellScript(["C:\\Windows\\System32\\CMD.EXE", "/d", "/s", "/c", "npm", "test"])).toBe("npm test");
    expect(shellScript(["powershell.exe", "-NoProfile", "-Command", "npm run build"])).toBe("npm run build");
    expect(shellScript(["pwsh", "/c", "npm", "test"])).toBe("npm test");
    // Shapes it can't read exactly stay the shell's own argv, which never gets Always.
    expect(shellScript(["powershell", "-ExecutionPolicy", "Bypass", "-Command", "x"])).toBeNull();
    expect(shellScript(["cmd", "/v:on", "/c", "x"])).toBeNull();
    const rule: AlwaysRule[] = [{ kind: "execute", command: "npm test" }];
    const req = (argv: string[]) => toRequest({ sessionId: "s", toolCall: { toolCallId: "t", kind: "execute", rawInput: { command: argv } }, options: [] }, root);
    expect(decide(req(["cmd", "/c", "npm test"]), edits(rule), root)).toBe("allow");
    for (const tail of ["npm test & calc", "npm test | calc", "npm test ^& calc", "npm test %COMSPEC%", "npm test > x"]) {
      expect(decide(req(["cmd", "/c", tail]), edits(rule), root), tail).toBe("ask");
    }
    expect(decide(req(["powershell", "-ExecutionPolicy", "Bypass", "-Command", "npm test"]), edits(rule), root)).toBe("ask");
  });
});

describe("§34 Windows paths", () => {
  it("an ordinary edit in the project goes through, whatever the case of the path", () => {
    expect(decide(edit(`${root}\\script.md`), edits(), root)).toBe("allow");
    expect(decide(edit("c:\\users\\red\\projects\\launch\\script.md"), edits(), root)).toBe("allow");
    expect(decide(edit("C:\\Users\\Red\\Projects\\Launch2\\x.md"), edits(), root)).toBe("ask");
    expect(decide(edit("D:\\Users\\Red\\Projects\\Launch\\x.md"), edits(), root)).toBe("ask");
  });

  it("protected folders ask in any case and with either slash", () => {
    for (const p of [".git\\hooks\\pre-commit", ".GIT\\config", ".rushes/agent.json", ".Claude\\settings.json", "sub\\.git\\hooks\\x", ".mcp.json"]) {
      expect(decide(edit(`${root}\\${p}`), edits(), root), p).toBe("ask");
    }
  });

  it("trailing dots and spaces, NTFS streams and 8.3 short names ask (they may open a protected file)", () => {
    for (const p of [".git.\\config", ".git \\config", ".git::$DATA", "x.md:hidden", "GIT~1\\config", "RUSHES~1\\agent.json", "notes.md.", "notes.md "]) {
      expect(decide(edit(`${root}\\${p}`), edits(), root), p).toBe("ask");
      expect(canAlways(edit(`${root}\\${p}`), root), p).toBe(false);
    }
  });

  it("deleting or moving the project folder itself asks, in any case", () => {
    expect(decide({ kind: "delete", title: "rm", command: null, paths: ["c:\\users\\red\\projects\\launch"] }, edits(), root)).toBe("ask");
  });
});

describe("§34 POSIX stays as it was", () => {
  beforeEach(() => {
    rulesOS.platform = "darwin";
  });
  it("% is still allowed, / words are paths, and a file named with ~1 or a trailing dot is in the project", () => {
    expect(plainCommand("npm test 50%")).toBe(true);
    expect(alwaysWords("find /tmp")).toEqual(["find", "/tmp"]);
    expect(decide(edit("/p/notes~1.md"), edits(), "/p")).toBe("allow");
    expect(decide(edit("/p/notes."), edits(), "/p")).toBe("allow");
    expect(decide(edit("/p/.git/config"), edits(), "/p")).toBe("ask");
  });
  it("the new names are refused on every OS (only ever stricter)", () => {
    expect(plainCommand("cmd /c x")).toBe(false);
    expect(plainCommand("start x")).toBe(false);
    expect(plainCommand("bash.exe -c x")).toBe(false);
  });
});
