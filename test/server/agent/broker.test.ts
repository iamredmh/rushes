import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionBroker, allowOutcome, toRequest } from "../../../src/server/agent/broker.js";
import type { AcpPermissionParams } from "../../../src/server/agent/acp.js";
import { NotFoundError } from "../../../src/core/errors.js";
import { decide } from "../../../src/core/agentRules.js";

const ROOT = "/projects/demo";
const OPTIONS: AcpPermissionParams["options"] = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

const params = (toolCall: Partial<AcpPermissionParams["toolCall"]>, options = OPTIONS): AcpPermissionParams => ({
  sessionId: "s1",
  toolCall: { toolCallId: "t1", ...toolCall },
  options,
});

const NOW = new Date("2026-11-17T10:00:00.000Z");

describe("toRequest", () => {
  it("takes the command from rawInput.command, joining an array", () => {
    expect(toRequest(params({ title: "Run", kind: "execute", rawInput: { command: "npm run build" } }), ROOT)).toEqual({
      kind: "execute", title: "Run", command: "npm run build", paths: [],
    });
    expect(toRequest(params({ kind: "execute", rawInput: { command: ["git", "status", "-s"] } }), ROOT).command).toBe("git status -s");
    expect(toRequest(params({ kind: "execute", rawInput: { command: 42 } }), ROOT).command).toBeNull();
    expect(toRequest(params({ kind: "execute" }), ROOT)).toEqual({ kind: "execute", title: "", command: null, paths: [] });
  });

  it("takes the script out of a shell argv, so Always names the real command, not the shell", () => {
    for (const shell of ["bash", "/bin/zsh", "sh", "/usr/local/bin/bash", "/bin/tcsh", "csh", "pwsh"])
      for (const flag of ["-c", "-lc"])
        expect(toRequest(params({ kind: "execute", rawInput: { command: [shell, flag, "npm run build"] } }), ROOT).command).toBe("npm run build");
    // Other argv shapes are joined as before.
    expect(toRequest(params({ kind: "execute", rawInput: { command: ["bash", "script.sh"] } }), ROOT).command).toBe("bash script.sh");
    expect(toRequest(params({ kind: "execute", rawInput: { command: ["python", "-c", "print(1)"] } }), ROOT).command).toBe("python -c print(1)");
  });

  it("quotes a program or subcommand element with a space, a quote or nothing in it, so no Always rule can be made from it", () => {
    const cmd = (command: unknown) => toRequest(params({ kind: "execute", rawInput: { command } }), ROOT).command;
    expect(cmd(["/Volumes/4TB OWC 1M2/Developer/tool", "render"])).toBe(`"/Volumes/4TB OWC 1M2/Developer/tool" render`);
    expect(cmd(["tool", "a b", "c d"])).toBe(`tool "a b" c d`);
    expect(cmd(["it's", "x"])).toBe(`"it's" x`);
    expect(cmd(['a"b', "x"])).toBe(`"a\\"b" x`);
    expect(cmd(["", "npm", "run"])).toBe(`"" npm run`);
    expect(cmd(["tool\tx", "y"])).toBe(`"tool\\tx" y`);
    // Later elements are arguments and are joined as before.
    expect(cmd(["npx", "hyperframes", "render", "--out", "out/v 8.mp4"])).toBe("npx hyperframes render --out out/v 8.mp4");
    // A shell running a script is still unwrapped.
    expect(cmd(["/bin/bash", "-lc", "npm run build"])).toBe("npm run build");
  });

  it("an argv whose program has a space never matches an old rule made from it", () => {
    const old = { permissions: "project-edits" as const, always: [{ kind: "execute", command: "/Volumes/4TB OWC" }] };
    const perl = toRequest(params({ kind: "execute", rawInput: { command: ["/Volumes/4TB OWC 1M2/../../usr/bin/perl", "-e", "system qw,touch X,"] } }), ROOT);
    expect(decide(perl, old, ROOT)).toBe("ask");
    const tool = toRequest(params({ kind: "execute", rawInput: { command: ["/Volumes/4TB OWC 1M2/Developer/tool", "render"] } }), ROOT);
    expect(decide(tool, old, ROOT)).toBe("ask");
  });

  it("resolves relative locations against the project root, not the process cwd", () => {
    const req = toRequest(params({ kind: "edit", locations: [{ path: "compositions/a.html" }, { path: "/elsewhere/b.txt" }] }), ROOT);
    expect(req.paths).toEqual([join(ROOT, "compositions/a.html"), "/elsewhere/b.txt"]);
  });

  it("has no kind when the tool call gives none", () => {
    expect(toRequest(params({ title: "Something" }), ROOT).kind).toBeNull();
  });
});

describe("allowOutcome", () => {
  it("prefers allow_once, falls back to allow_always, else cancelled", () => {
    expect(allowOutcome(OPTIONS)).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(allowOutcome([OPTIONS[1], OPTIONS[2]])).toEqual({ outcome: "selected", optionId: "allow-always" });
    expect(allowOutcome([OPTIONS[2]])).toEqual({ outcome: "cancelled" });
  });
});

describe("PermissionBroker", () => {
  const broker = (changes: number[] = []) => {
    let n = 0;
    return new PermissionBroker(ROOT, { now: () => NOW, onChange: () => changes.push(++n) });
  };

  it("holds an ask until it is answered, and lists it as the desk shows it", async () => {
    const changes: number[] = [];
    const b = broker(changes);
    const outcome = b.ask(params({ title: "Run npm run build", kind: "execute", rawInput: { command: "npm run build" } }));
    const [ask] = b.pending();
    expect(ask).toEqual({
      id: ask.id, title: "Run npm run build", kind: "execute", command: "npm run build", always: "Always for npm run here", at: NOW.toISOString(),
    });
    expect(ask.id).toMatch(/^ask_/);
    expect(changes).toHaveLength(1);
    expect(b.answer(ask.id, "once")).toBeNull();
    expect(await outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(b.pending()).toEqual([]);
    expect(changes).toHaveLength(2);
  });

  it("Always answers allow_once (Rushes keeps the rule) and returns the rule", async () => {
    const b = broker();
    const outcome = b.ask(params({ kind: "execute", rawInput: { command: "npm run build" } }));
    expect(b.answer(b.pending()[0].id, "always")).toEqual({ kind: "execute", command: "npm run" });
    expect(await outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
  });

  it("offers no Always for an untyped tool call, and Always there acts as once, keeping nothing", async () => {
    const b = broker();
    for (const kind of [undefined, "other"]) {
      const outcome = b.ask(params({ title: "Something", kind }));
      const [ask] = b.pending();
      expect(ask.always).toBe("");
      expect(b.answer(ask.id, "always")).toBeNull();
      expect(await outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    }
  });

  it("offers no Always for a shell however its argv is shaped, and Always there keeps nothing", async () => {
    const b = broker();
    for (const command of [
      "bash -lc 'npm run build'",
      ["bash", "-ec", "npm run build"],
      ["bash", "-l", "-c", "npm run build"],
      ["/usr/bin/env", "bash", "-c", "npm run build"],
      ["bash", "-lc", "zsh -c ls"],
      ["bash", "-lc", "npm run build =(touch p1)"],
      "FOO=1 bash -c 'npm run build'",
      "nohup bash -c ls",
      ["xargs", "-I", "@", "sh", "-c", "ls"],
      // As a string (not unwrapped) a tcsh or csh line is a shell; as an argv its plain script is the command.
      "tcsh -c ls",
      "/bin/csh -c ls",
      ["tcsh", "-c", "nohup ls"],
      "npm exec -- x",
      "npx -y pkg",
    ]) {
      const outcome = b.ask(params({ kind: "execute", rawInput: { command } }));
      const [ask] = b.pending();
      expect(ask.always, JSON.stringify(command)).toBe("");
      expect(b.answer(ask.id, "always")).toBeNull();
      expect(await outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    }
  });

  it("offers no Always for a quoted, spaced or climbing program, or a package runner, and Always there keeps nothing (R7)", async () => {
    const b = broker();
    for (const command of [
      `"/Volumes/4TB OWC 1M2/Developer/tool" render out.mp4`,
      `'/Volumes/4TB OWC 1M2/Developer/tool' render`,
      `"./My Tools v2/run" x`,
      ["/Volumes/4TB OWC 1M2/Developer/tool", "render"],
      ["./My Tools v2/run", "x"],
      "npm x -y pkg",
      "npm exec -- pkg",
      "pnpm dlx pkg",
      "yarn dlx pkg",
      "pipx run pkg",
      "uv run perl",
      ["uv", "run", "perl"],
      `"/bin/bash" -c x`,
      "../bin/tool run",
      "tools/../../bin/x y",
      "npx npm exec x",
      ["npx", "pnpm", "dlx", "x"],
      "bunx npm x",
      "deno run https://x",
      "nix run github:x/y",
    ]) {
      const outcome = b.ask(params({ kind: "execute", rawInput: { command } }));
      const [ask] = b.pending();
      expect(ask.always, JSON.stringify(command)).toBe("");
      expect(b.answer(ask.id, "always"), JSON.stringify(command)).toBeNull();
      expect(await outcome).toEqual({ outcome: "selected", optionId: "allow-once" });
    }
  });

  it("still offers and keeps Always for a plain program and subcommand (R7)", async () => {
    const b = broker();
    for (const [command, label, rule] of [
      [`npx hyperframes render --out "out/v 8.mp4"`, "Always for npx hyperframes here", "npx hyperframes"],
      [["npx", "hyperframes", "render", "--out", "out/v 8.mp4"], "Always for npx hyperframes here", "npx hyperframes"],
      ["npm run build", "Always for npm run here", "npm run"],
      ["bun run build", "Always for bun run here", "bun run"],
      [`git commit -m "fix the time display"`, "Always for git commit here", "git commit"],
    ] as const) {
      void b.ask(params({ kind: "execute", rawInput: { command } }));
      const [ask] = b.pending();
      expect(ask.always, JSON.stringify(command)).toBe(label);
      expect(b.answer(ask.id, "always")).toEqual({ kind: "execute", command: rule });
    }
  });

  it("keeps no rule when Always ends in cancelled (no allow option offered)", async () => {
    const b = broker();
    const outcome = b.ask(params({ kind: "execute", rawInput: { command: "npm run build" } }, [OPTIONS[2]]));
    expect(b.answer(b.pending()[0].id, "always")).toBeNull();
    expect(await outcome).toEqual({ outcome: "cancelled" });
  });

  it("falls back to allow_always only when no allow_once is offered", async () => {
    const b = broker();
    const outcome = b.ask(params({ kind: "execute" }, [OPTIONS[1], OPTIONS[2]]));
    b.answer(b.pending()[0].id, "once");
    expect(await outcome).toEqual({ outcome: "selected", optionId: "allow-always" });
  });

  it("No answers reject_once, falling back to reject_always, else cancelled", async () => {
    const b = broker();
    const one = b.ask(params({ kind: "execute" }));
    b.answer(b.pending()[0].id, "no");
    expect(await one).toEqual({ outcome: "selected", optionId: "reject-once" });
    const two = b.ask(params({ kind: "execute" }, [OPTIONS[0], { optionId: "never", name: "Never", kind: "reject_always" }]));
    b.answer(b.pending()[0].id, "no");
    expect(await two).toEqual({ outcome: "selected", optionId: "never" });
    const three = b.ask(params({ kind: "execute" }, [OPTIONS[0]]));
    b.answer(b.pending()[0].id, "no");
    expect(await three).toEqual({ outcome: "cancelled" });
    const four = b.ask(params({ kind: "execute" }, [OPTIONS[2]]));
    b.answer(b.pending()[0].id, "once");
    expect(await four).toEqual({ outcome: "cancelled" });
  });

  it("an unknown or already answered id is not found", () => {
    const b = broker();
    void b.ask(params({ kind: "execute" }));
    const id = b.pending()[0].id;
    expect(() => b.answer("ask_nope", "once")).toThrow(NotFoundError);
    b.answer(id, "no");
    expect(() => b.answer(id, "once")).toThrow(NotFoundError);
  });

  it("cancelAll settles every pending ask cancelled and leaves none", async () => {
    const changes: number[] = [];
    const b = broker(changes);
    const one = b.ask(params({ kind: "execute" }));
    const two = b.ask(params({ kind: "fetch" }));
    const ids = b.pending().map((a) => a.id);
    expect(new Set(ids).size).toBe(2);
    b.cancelAll();
    expect(await one).toEqual({ outcome: "cancelled" });
    expect(await two).toEqual({ outcome: "cancelled" });
    expect(b.pending()).toEqual([]);
    expect(() => b.answer(ids[0], "once")).toThrow(NotFoundError);
    expect(changes).toHaveLength(3);
    // Nothing pending: no change to announce.
    b.cancelAll();
    expect(changes).toHaveLength(3);
  });

  it("pending() hands out copies", () => {
    const b = broker();
    void b.ask(params({ kind: "execute", title: "Run" }));
    b.pending()[0].title = "changed";
    expect(b.pending()[0].title).toBe("Run");
  });
});
