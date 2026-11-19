// §34: "Sign in" on every OS. Rushes only writes the agent's own login command into a file and opens a terminal on it.
import { describe, expect, it } from "vitest";
import { RushesError } from "../../../src/core/errors.js";
import { signInLabel } from "../../../src/core/agentHelp.js";
import { cmdQuote, shQuote, signInScript, terminalOpener } from "../../../src/server/agent/terminal.js";

describe("the sign-in file", () => {
  it("Mac and Linux: /bin/sh with the detected path quoted, then the login words", () => {
    expect(signInScript("darwin", "claude auth login", ["/Users/r/.local/bin/claude", "auth", "login"])).toBe("#!/bin/sh\n/Users/r/.local/bin/claude auth login\n");
    expect(signInScript("linux", "codex login", ["/home/o'neil/my bin/codex", "login"])).toBe("#!/bin/sh\n'/home/o'\\''neil/my bin/codex' login\n");
    expect(signInScript("darwin", "claude auth login")).toBe("#!/bin/sh\nclaude auth login\n");
  });

  it("Windows: a .cmd with the path in double quotes, % doubled, and a pause so the window stays", () => {
    const s = signInScript("win32", "claude auth login", ["C:\\Users\\Red & Co\\AppData\\Roaming\\npm\\claude.cmd", "auth", "login"]);
    expect(s.split("\r\n")[1]).toBe('"C:\\Users\\Red & Co\\AppData\\Roaming\\npm\\claude.cmd" "auth" "login"');
    expect(s).toContain("pause");
    expect(cmdQuote("50%PATH%")).toBe('"50%%PATH%%"');
    expect(shQuote("plain/path")).toBe("plain/path");
  });
});

describe("terminalOpener", () => {
  it("Linux with no terminal: a 501 that carries the command for the desk to show with Copy", async () => {
    const open = terminalOpener({ platform: "linux", find: () => null });
    const e = await open("codex login", ["/usr/bin/codex", "login"]).catch((x) => x);
    expect(e).toBeInstanceOf(RushesError);
    expect(e.status).toBe(501);
    expect(e.code).toBe("no_terminal");
    expect(e.detail).toEqual({ command: "codex login" });
  });
});

describe("the button's words", () => {
  it("per OS", () => {
    expect(signInLabel("darwin")).toBe("Sign in in Terminal");
    expect(signInLabel("win32")).toBe("Sign in in Command Prompt");
    expect(signInLabel("linux")).toBe("Sign in in a terminal");
  });
});
