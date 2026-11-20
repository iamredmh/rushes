// §35.5: going back to the agent's conversation: the resume command per agent and OS, the terminal script that runs
// it in the project folder, and the here key that proves a desk was opened on this computer.
import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resumeFor } from "../../src/server/agent/resume.js";
import { signInScript } from "../../src/server/agent/terminal.js";
import { hereKey, lockPath, withHere } from "../../src/server/lock.js";
import { isOpenAttention, raiseAttention, replySettles, resolveAttention } from "../../src/core/attention.js";
import { LogFileSchema } from "../../src/core/schema.js";

const session = (agent: "claude" | "codex", id = "a2973322-28b7-4e44-91b7-8e306bbd4fb6") => ({ id, agent, startedAt: "2026-11-19T09:23:34.350Z" });

describe("the resume command (§35.5)", () => {
  it("Claude Code: claude --resume <id>; Codex: codex resume <id>, on every OS", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(resumeFor(session("claude"), "/p", platform)).toEqual({ agent: "claude", session: session("claude").id, args: ["--resume", session("claude").id], command: `claude --resume ${session("claude").id}` });
      expect(resumeFor(session("codex"), "/p", platform)!.command).toBe(`codex resume ${session("codex").id}`);
    }
  });

  it("no kept session: nothing to resume", () => {
    expect(resumeFor(null, "/p", "darwin")).toBeNull();
  });

  it("a session id with odd characters is quoted for the shell it will be pasted into", () => {
    expect(resumeFor(session("claude", "a b'c"), "/p", "darwin")!.command).toBe(`claude --resume 'a b'\\''c'`);
    expect(resumeFor(session("claude", 'a b"c'), "/p", "win32")!.command).toBe(`claude --resume "a bc"`);
  });

  it("the terminal script goes to the project folder first, per OS, and stops if it can't", () => {
    expect(signInScript("darwin", "claude --resume x", ["/bin/claude", "--resume", "x"], "/Users/red/My Film")).toBe("#!/bin/sh\ncd '/Users/red/My Film' || exit 1\n/bin/claude --resume x\n");
    expect(signInScript("linux", "claude --resume x", undefined, "/srv/film")).toBe("#!/bin/sh\ncd /srv/film || exit 1\nclaude --resume x\n");
    expect(signInScript("win32", "codex resume x", ["C:\\\\bin\\\\codex.exe", "resume", "x"], "C:\\\\Films\\\\100%")).toBe(
      '@echo off\r\ncd /d "C:\\\\Films\\\\100%%" || exit /b 1\r\n"C:\\\\bin\\\\codex.exe" "resume" "x"\r\necho.\r\necho You can close this window.\r\npause >nul\r\n',
    );
    // A sign-in (no folder) is as it was.
    expect(signInScript("darwin", "claude auth login")).toBe("#!/bin/sh\nclaude auth login\n");
  });
});

describe("the here key (§35.5)", () => {
  it("is the live server's lock token, read from .rushes/server.json; none without a live server", async () => {
    const root = await mkdtemp(join(tmpdir(), "rushes-here-"));
    expect(await hereKey(root)).toBeNull();
    await mkdir(join(root, ".rushes"), { recursive: true });
    await writeFile(lockPath(root), JSON.stringify({ port: 1, pid: process.pid, startedAt: "x", token: "tok-1" }));
    expect(await hereKey(root)).toBe("tok-1");
    await writeFile(lockPath(root), JSON.stringify({ port: 1, pid: 999999999, startedAt: "x", token: "tok-2" }));
    expect(await hereKey(root)).toBeNull();
  });

  it("withHere adds it to the address once, and leaves an address alone without one", () => {
    expect(withHere("http://127.0.0.1:4580/p/abcdefgh/", "k")).toBe("http://127.0.0.1:4580/p/abcdefgh/#here=k");
    expect(withHere("http://127.0.0.1:4580/p/abcdefgh/#here=old", "k")).toBe("http://127.0.0.1:4580/p/abcdefgh/#here=k");
    expect(withHere("http://127.0.0.1:4580/p/abcdefgh/", null)).toBe("http://127.0.0.1:4580/p/abcdefgh/");
  });
});

describe("attention lines (§35.5, core)", () => {
  const empty = () => LogFileSchema.parse({ schema: 1, rev: 0, backfilled: true, entries: [] });
  const at = new Date("2026-11-20T10:00:00Z");

  it("raise writes a line of its own (never merged into another), and again with the same words adds nothing while open", () => {
    const f = empty();
    const a = raiseAttention(f, { title: "Sign in", note: "n1", video: "v1" }, at);
    expect(a.created).toBe(true);
    const b = raiseAttention(f, { title: "Missing key", note: "n1", video: "v1" }, at);
    expect(b.created).toBe(true);
    expect(f.entries).toHaveLength(2);
    expect(raiseAttention(f, { title: "Sign in", note: "n1", video: "v1" }, at).created).toBe(false);
    // Another film's is its own.
    expect(raiseAttention(f, { title: "Sign in", note: null, video: "v2" }, at).created).toBe(true);
    expect(() => raiseAttention(f, { title: "  ", note: null, video: null }, at)).toThrow();
  });

  it("resolve clears what it matches, once; a cleared line is no longer open", () => {
    const f = empty();
    raiseAttention(f, { title: "Sign in", note: "n1", video: "v1" }, at);
    raiseAttention(f, { title: "Other", note: "n2", video: "v1" }, at);
    expect(resolveAttention(f, (e) => e.note === "n1", at)).toHaveLength(1);
    expect(resolveAttention(f, (e) => e.note === "n1", at)).toHaveLength(0);
    expect(f.entries.filter(isOpenAttention).map((e) => e.note)).toEqual(["n2"]);
  });

  it("a reply settles it when it marks the note done or names a fix version", () => {
    expect(replySettles({ status: "done" })).toBe(true);
    expect(replySettles({ fixVersion: "v2" })).toBe(true);
    expect(replySettles({})).toBe(false);
    expect(replySettles({ status: "todo", fixVersion: null })).toBe(false);
  });
});
