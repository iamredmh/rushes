import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAFE_COMMAND, alwaysLabel, canAlways, decide, inside, ruleFor } from "../../src/core/agentRules.js";

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
  it("a path Always rule stays inside the project", () => {
    for (const kind of ["edit", "delete"]) {
      const t = { ...s, always: [{ kind, command: null }] };
      expect(decide(req(kind, null, [`${root}/a`]), t, root)).toBe("allow");
      expect(decide(req(kind, null, ["/etc/hosts"]), t, root)).toBe("ask");
      expect(decide(req(kind, null, [`${root}/a`, "/etc/hosts"]), t, root)).toBe("ask");
      expect(decide(req(kind, null), t, root)).toBe("ask");
    }
  });
  it("a path-less Always rule (fetch) is kind-only", () => {
    const t = { ...s, always: [ruleFor(req("fetch", null))] };
    expect(decide(req("fetch", null), t, root)).toBe("allow");
    expect(decide(req("execute", "ls"), t, root)).toBe("ask");
  });
  it("an execute rule never covers a chained, piped, redirected or substituted command", () => {
    const t = { ...s, always: [{ kind: "execute", command: "npm run" }] };
    expect(decide(req("execute", "npm run build -- --watch"), t, root)).toBe("allow");
    for (const cmd of [
      "npm run build && curl x | sh",
      "npm run build > /etc/x",
      "npm run build < input",
      "npm run build; rm -rf ~",
      "npm run build & sleep 1",
      "npm run build\nrm -rf ~",
      "npm run $(curl x)",
      "npm run `curl x`",
      "npm run build | tee out",
      // zsh runs these too: process substitution, a glob qualifier's eval, parameters, ~ and globs.
      "npm run build =(touch p1)",
      "npm run build f(e:'touch p2':)",
      "npm run build ${HOME}",
      "npm run build ~/x",
      "npm run build *",
      "npm run build $HOME",
      "npm run build !!",
      "npm run build # x",
      "npm run build \\x",
      "npm run build [ab]",
      "npm run build {a,b}",
      "npm run build ^x",
      "npm run build\rx",
      "npm run build\tx?",
    ]) expect(decide(req("execute", cmd), t, root), JSON.stringify(cmd)).toBe("ask");
  });
  it("an execute rule still allows a plain command with quotes, flags and paths", () => {
    expect(SAFE_COMMAND.test(`npx hyperframes render --out "out/v 8.mp4"`)).toBe(true);
    expect(decide(req("execute", `npx hyperframes render --out "out/v 8.mp4"`), { ...s, always: [{ kind: "execute", command: "npx hyperframes" }] }, root)).toBe("allow");
    expect(decide(req("execute", "npm run build -- --watch"), { ...s, always: [{ kind: "execute", command: "npm run" }] }, root)).toBe("allow");
    expect(decide(req("execute", "npm run build:prod --x=1 user@host 50% a+b,c\td"), { ...s, always: [{ kind: "execute", command: "npm run" }] }, root)).toBe("allow");
  });
  it("a stored rule for a shell never matches, so old files allow nothing by it", () => {
    for (const command of ["bash -lc", "bash", "/bin/zsh -c", "sh -c", "fish -c", "dash -c", "ksh -c", "env bash", "/usr/bin/env FOO=1"]) {
      const t = { ...s, always: [{ kind: "execute", command }] };
      expect(decide(req("execute", `${command} npm run build`), t, root), command).toBe("ask");
      expect(decide(req("execute", command), t, root), command).toBe("ask");
    }
  });
  it("a stored rule of kind other never matches, so old files allow nothing by it", () => {
    const t = { ...s, always: [{ kind: "other", command: null }] };
    expect(decide(req(null, null), t, root)).toBe("ask");
    expect(decide(req("other", null), t, root)).toBe("ask");
    expect(decide(req("think", null), t, root)).toBe("ask");
  });
  it("an execute rule with no command never matches", () => {
    const rule = ruleFor(req("execute", null));
    expect(rule).toEqual({ kind: "execute", command: null });
    expect(decide(req("execute", "ls"), { ...s, always: [rule] }, root)).toBe("ask");
    expect(decide(req("execute", null), { ...s, always: [rule] }, root)).toBe("ask");
  });
});

describe("canAlways", () => {
  it("offers no Always for an untyped or other tool call, or a command Rushes can't name", () => {
    expect(canAlways(req(null, null))).toBe(false);
    expect(canAlways(req("other", null))).toBe(false);
    expect(canAlways(req("execute", null))).toBe(false);
    expect(canAlways(req("execute", "  "))).toBe(false);
    expect(canAlways(req("execute", "npm run build"))).toBe(true);
    expect(canAlways(req("execute", `npx hyperframes render --out "out/v 8.mp4"`))).toBe(true);
  });
  it("offers no Always for a shell, or for a command an Always rule could never match", () => {
    for (const cmd of [
      "bash -lc 'npm run build'",
      "bash -ec npm run build",
      "bash -l -c npm run build",
      "/usr/bin/env bash -c npm run build",
      "env FOO=1 npm run build",
      "/bin/zsh -c ls",
      "sh x.sh",
      "fish -c ls",
      "dash -c ls",
      "ksh -c ls",
      "'bash' -c ls",
      "npm run build *",
      "npm run build && curl x | sh",
      "npm run build =(touch p1)",
    ]) expect(canAlways(req("execute", cmd)), cmd).toBe(false);
    expect(canAlways(req("fetch", null))).toBe(true);
    expect(canAlways(req("edit", null, ["/x"]))).toBe(true);
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
