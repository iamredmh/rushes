import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alwaysLabel, decide, inside, ruleFor } from "../../src/core/agentRules.js";

const root = "/tmp/rushes test/My Project";
const s = { permissions: "project-edits" as const, always: [] };
const req = (kind: string | null, command: string | null, paths: string[] = []) => ({ kind, title: "T", command, paths });

describe("decide", () => {
  it("project-edits allows reads and edits inside the project", () => {
    expect(decide(req("edit", null, [`${root}/compositions/a.html`]), s, root)).toBe("allow");
    expect(decide(req("read", null, [`${root}/brief.md`]), s, root)).toBe("allow");
  });
  it("project-edits asks for commands, web requests, no path, or a path outside", () => {
    expect(decide(req("execute", "npx hyperframes render"), s, root)).toBe("ask");
    expect(decide(req("fetch", null), s, root)).toBe("ask");
    expect(decide(req("edit", null), s, root)).toBe("ask");
    expect(decide(req("edit", null, [`${root}/a`, "/etc/hosts"]), s, root)).toBe("ask");
    expect(decide(req(null, null, [`${root}/a`]), s, root)).toBe("ask");
  });
  it("ask-all asks for everything, even an edit inside or an Always rule", () => {
    const a = { permissions: "ask-all" as const, always: [{ kind: "edit", command: null }] };
    expect(decide(req("edit", null, [`${root}/a.html`]), a, root)).toBe("ask");
  });
  it("an Always rule allows the same command again, and only that one", () => {
    const rule = ruleFor(req("execute", "npx hyperframes render --out out/v8.mp4"));
    expect(rule).toEqual({ kind: "execute", command: "npx hyperframes" });
    expect(alwaysLabel(rule)).toBe("Always for npx hyperframes here");
    const t = { ...s, always: [rule] };
    expect(decide(req("execute", "npx hyperframes render --out out/v9.mp4"), t, root)).toBe("allow");
    expect(decide(req("execute", "npx hyperframes"), t, root)).toBe("allow");
    expect(decide(req("execute", "npx hyperframesx"), t, root)).toBe("ask");
    expect(decide(req("execute", "rm -rf out"), t, root)).toBe("ask");
  });
  it("a non-execute Always rule allows that kind anywhere", () => {
    const t = { ...s, always: [ruleFor(req("fetch", null))] };
    expect(decide(req("fetch", null), t, root)).toBe("allow");
    expect(decide(req("execute", "ls"), t, root)).toBe("ask");
  });
  it("an execute rule with no command never matches", () => {
    const rule = ruleFor(req("execute", null));
    expect(rule).toEqual({ kind: "execute", command: null });
    expect(decide(req("execute", "ls"), { ...s, always: [rule] }, root)).toBe("ask");
    expect(decide(req("execute", null), { ...s, always: [rule] }, root)).toBe("ask");
  });
});

describe("ruleFor and alwaysLabel", () => {
  it("keeps one word when the command is one word, and null command for other kinds", () => {
    expect(ruleFor(req("execute", "ls"))).toEqual({ kind: "execute", command: "ls" });
    expect(ruleFor(req("edit", "ignored"))).toEqual({ kind: "edit", command: null });
    expect(ruleFor(req(null, null))).toEqual({ kind: "other", command: null });
  });
  it("labels", () => {
    expect(alwaysLabel({ kind: "edit", command: null })).toBe("Always for edits here");
    expect(alwaysLabel({ kind: "fetch", command: null })).toBe("Always for web requests here");
    expect(alwaysLabel({ kind: "read", command: null })).toBe("Always for reads here");
    expect(alwaysLabel({ kind: "other", command: null })).toBe("Always for this here");
  });
});

describe("inside", () => {
  it("refuses escapes, siblings with a shared prefix, and symlinks pointing out", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "rushes-inside-")));
    const proj = join(base, "My Project");
    const sib = `${proj} 2`;
    await mkdir(join(proj, "sub"), { recursive: true });
    await mkdir(sib);
    await symlink(sib, join(proj, "link-out"));
    expect(inside(proj, proj)).toBe(true);
    expect(inside(proj, `${proj}/sub/x`)).toBe(true);
    expect(inside(proj, `${proj}/sub/deeper/not/yet/x`)).toBe(true);
    expect(inside(proj, `${proj}/../elsewhere/x`)).toBe(false);
    expect(inside(proj, `${sib}/x`)).toBe(false);
    expect(inside(proj, join(proj, "link-out"))).toBe(false);
    expect(inside(proj, join(proj, "link-out", "x"))).toBe(false);
    expect(inside(proj, join(proj, "link-out", "new", "x"))).toBe(false);
  });
});
