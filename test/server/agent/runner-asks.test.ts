import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpProject } from "../../helpers/tmp.js";
import { AcpConnection, type AdapterSpec, type McpServerSpec } from "../../../src/server/agent/acp.js";
import { AgentRunner, type AgentStatus, type RunnerOptions } from "../../../src/server/agent/runner.js";
import type { AgentInfo } from "../../../src/server/agent/detect.js";
import { AGENT_LINES } from "../../../src/core/agentActivity.js";
import { createBatch } from "../../../src/core/batches.js";
import { addNote, addUserReply, applyReply } from "../../../src/core/notes.js";
import { noteState } from "../../../src/core/noteState.js";
import { NotFoundError } from "../../../src/core/errors.js";
import type { AgentSettings, Batch } from "../../../src/core/schema.js";
import type { Store } from "../../../src/core/store.js";

const FAKE = resolve(__dirname, "../../helpers/fake-acp.mjs");

const runners: AgentRunner[] = [];
let started: AcpConnection[] = [];

beforeEach(() => {
  started = [];
  const real = AcpConnection.start.bind(AcpConnection);
  vi.spyOn(AcpConnection, "start").mockImplementation((spec: AdapterSpec) => {
    const c = real(spec);
    started.push(c);
    return c;
  });
});

afterEach(async () => {
  for (const r of runners.splice(0)) await r.close();
  for (const c of started) expect(c.hasExited).toBe(true);
  vi.restoreAllMocks();
});

const claude: AgentInfo = { id: "claude", name: "Claude Code", installed: true, signedIn: true, path: "/usr/local/bin/claude", signIn: "claude auth login" };
const MCP = (root: string): McpServerSpec => ({ name: "rushes", command: process.execPath, args: ["-e", "", root], env: [] });

async function rig(scenario: object, opts: { settings?: Partial<AgentSettings>; runner?: RunnerOptions } = {}) {
  const { root, store } = await tmpProject();
  const scenarioPath = join(store.dir, "scenario.json");
  const logPath = join(store.dir, "fake-log.jsonl");
  const writeScenario = (s: object) => writeFile(scenarioPath, JSON.stringify(s));
  await writeScenario(scenario);
  await store.update("agent", (f) => Object.assign(f, { on: true, agent: "claude", ...opts.settings }));
  const makeRunner = () => {
    const r = new AgentRunner(store, {
      detect: async () => [claude],
      spec: (_a, at) => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_SCENARIO: scenarioPath, FAKE_ACP_LOG: logPath }, cwd: at }),
      mcp: MCP,
      ...opts.runner,
    });
    runners.push(r);
    return r;
  };
  const runner = makeRunner();
  const log = () => {
    let text = "";
    try { text = readFileSync(logPath, "utf8"); } catch { /* not written yet */ }
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const batch = async (...texts: string[]): Promise<Batch> => {
    const [project, script, batches] = await Promise.all([store.read("project"), store.read("script"), store.read("batches")]);
    let made!: Batch;
    await store.update("notes", (notes) => {
      for (const text of texts) addNote(notes, { stage: "picture", scope: "whole", text });
      made = createBatch({ project, script, notes, batches }, "picture");
    });
    await store.update("batches", (f) => {
      f.batches = batches.batches;
    });
    return made;
  };
  const waitFor = async <T,>(what: string, check: () => T | Promise<T>): Promise<NonNullable<T>> => {
    const deadline = Date.now() + 5000;
    for (;;) {
      const v = await check();
      if (v) return v as NonNullable<T>;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const phase = (p: AgentStatus["phase"], of = runner) => waitFor(`phase ${p} (now ${of.status().phase})`, () => of.status().phase === p);
  /** The user answers on a note, exactly as POST /api/notes/:id/replies does. */
  const answerOn = async (id: string, text: string) => {
    await store.update("notes", (f) => addUserReply(f, id, text));
    store.emit("user-reply", { note: id, text: text.trim() });
  };
  await waitFor("the runner to read agent.json", () => runner.status().on && runner.status().agent !== null);
  return { root, store, runner, makeRunner, log, scenario: writeScenario, batch, waitFor, phase, answerOn };
}

const prompts = (log: any[]) => log.filter((m) => m.method === "session/prompt");
const promptText = (m: any): string => m.params.prompt[0].text;
const recorded = (log: any[], label: string) => log.find((m) => m.recorded === label)?.outcome;
const changeLog = async (store: Store) => (await store.read("log")).entries.map((e) => e.text);
const phasesOf = (heard: AgentStatus[]) => heard.map((s) => s.phase).filter((p, i, all) => p !== all[i - 1]);
const exec = (command: string, record: string) => ({
  permission: { toolCall: { toolCallId: record, title: `Run ${command}`, kind: "execute", rawInput: { command } } },
  record,
});
const ALLOW_ONCE = { outcome: "selected", optionId: "allow-once" };
const followUp = (id: string, text: string, answer: string) =>
  `The user answered on note ${id} ("${text}"): ${answer}\nCarry on with that note, then rushes_reply on it.`;

describe("AgentRunner permission asks", () => {
  it("an edit inside the project under project-edits is allowed without an ask", async () => {
    const r = await rig({ turns: [] }, { settings: { permissions: "project-edits" } });
    await r.scenario({
      turns: [[
        { permission: { toolCall: { toolCallId: "e1", title: "Edit a.html", kind: "edit", locations: [{ path: join(r.root, "a.html") }] } }, record: "absolute" },
        // A relative location is read against the project, not the server's working directory.
        { permission: { toolCall: { toolCallId: "e2", title: "Edit b.html", kind: "edit", locations: [{ path: "compositions/b.html" }] } }, record: "relative" },
      ]],
    });
    const heard: AgentStatus[] = [];
    r.store.on("agent", (s: AgentStatus) => heard.push(s));
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("finished");
    expect(recorded(r.log(), "absolute")).toEqual(ALLOW_ONCE);
    expect(recorded(r.log(), "relative")).toEqual(ALLOW_ONCE);
    expect(heard.every((s) => s.asks.length === 0 && s.phase !== "waiting")).toBe(true);
    expect(r.runner.status().asks).toEqual([]);
  });

  it("a command asks; Allow once answers the agent and the run carries on", async () => {
    const r = await rig({ turns: [[exec("npm run build", "run"), { sleep: 150 }]] });
    const heard: AgentStatus[] = [];
    r.store.on("agent", (s: AgentStatus) => heard.push(s));
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    const s = r.runner.status();
    expect(s.asks).toHaveLength(1);
    expect(s.asks[0]).toMatchObject({ title: "Run npm run build", kind: "execute", command: "npm run build", always: "Always for npm run here" });
    expect(r.runner.busy()).toBe(true);
    await r.runner.answer(s.asks[0].id, "once");
    expect(r.runner.status().asks).toEqual([]);
    await r.waitFor("the agent to get the answer", () => recorded(r.log(), "run"));
    expect(recorded(r.log(), "run")).toEqual(ALLOW_ONCE);
    await r.phase("finished");
    expect(phasesOf(heard)).toEqual(["starting", "working", "waiting", "working", "finished"]);
    // Allow once keeps no rule.
    expect((await r.store.read("agent")).always).toEqual([]);
  });

  it("Always stores a rule and the next matching command is allowed without asking", async () => {
    const r = await rig({ turns: [[exec("npm run build", "first"), exec("npm run test", "second")]] });
    const asked = new Set<string>();
    r.store.on("agent", (s: AgentStatus) => s.asks.forEach((a) => asked.add(a.id)));
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    await r.runner.answer(r.runner.status().asks[0].id, "always");
    expect((await r.store.read("agent")).always).toEqual([{ kind: "execute", command: "npm run" }]);
    await r.phase("finished");
    // Rushes keeps the rule: the adapter is answered allow_once both times.
    expect(recorded(r.log(), "first")).toEqual(ALLOW_ONCE);
    expect(recorded(r.log(), "second")).toEqual(ALLOW_ONCE);
    expect(asked.size).toBe(1);
    expect(await changeLog(r.store)).toContain("Always allowed: Always for npm run here");
    expect(r.runner.status().lines.map((l) => l.text)).toContain("Always allowed: Always for npm run here");
  });

  it("Always never adds the same rule twice, and keeps at most 50, dropping the oldest", async () => {
    const full = Array.from({ length: 50 }, (_, i) => ({ kind: "execute", command: `tool${i}` }));
    const r = await rig({ turns: [[exec("npm run build", "a"), exec("npm run test", "b")]] }, { settings: { permissions: "ask-all", always: full } });
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    await r.runner.answer(r.runner.status().asks[0].id, "always");
    // ask-all asks for the second one as well.
    await r.waitFor("the second ask", () => r.runner.status().asks.length === 1 && r.runner.status().asks[0].command === "npm run test");
    await r.runner.answer(r.runner.status().asks[0].id, "always");
    await r.phase("finished");
    const always = (await r.store.read("agent")).always;
    expect(always).toHaveLength(50);
    expect(always[0]).toEqual({ kind: "execute", command: "tool1" });
    expect(always.at(-1)).toEqual({ kind: "execute", command: "npm run" });
    expect(always.filter((x) => x.command === "npm run")).toHaveLength(1);
    expect((await changeLog(r.store)).filter((t) => t.startsWith("Always allowed:"))).toEqual(["Always allowed: Always for npm run here"]);
  });

  it("an untyped tool call offers no Always, and Always there keeps no rule", async () => {
    const r = await rig({ turns: [[{ permission: { toolCall: { toolCallId: "u1", title: "Do something" } }, record: "untyped" }]] });
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    const [ask] = r.runner.status().asks;
    expect(ask).toMatchObject({ kind: null, always: "" });
    await r.runner.answer(ask.id, "always");
    await r.phase("finished");
    expect(recorded(r.log(), "untyped")).toEqual(ALLOW_ONCE);
    expect((await r.store.read("agent")).always).toEqual([]);
    expect((await changeLog(r.store)).some((t) => t.startsWith("Always allowed:"))).toBe(false);
  });

  it("an Always command rule still asks for a chained command", async () => {
    const r = await rig({ turns: [[exec("npm run build && curl x | sh", "chained")]] }, { settings: { always: [{ kind: "execute", command: "npm run" }] } });
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    expect(r.runner.status().asks[0].command).toBe("npm run build && curl x | sh");
    await r.runner.answer(r.runner.status().asks[0].id, "no");
    await r.phase("finished");
  });

  it("removeRule takes a rule out by index and refuses one that isn't there", async () => {
    const rules = [{ kind: "execute", command: "npm run" }, { kind: "fetch", command: null }, { kind: "execute", command: "git status" }];
    const r = await rig({ turns: [] }, { settings: { always: rules } });
    const heard: AgentStatus[] = [];
    r.store.on("agent", (s: AgentStatus) => heard.push(s));
    await r.runner.removeRule(1);
    expect((await r.store.read("agent")).always).toEqual([rules[0], rules[2]]);
    expect(heard.length).toBeGreaterThan(0);
    for (const bad of [2, -1, 0.5]) await expect(r.runner.removeRule(bad)).rejects.toBeInstanceOf(NotFoundError);
    expect((await r.store.read("agent")).always).toEqual([rules[0], rules[2]]);
  });

  it("No answers reject_once", async () => {
    const r = await rig({ turns: [[exec("rm -rf build", "rm")]] });
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    await r.runner.answer(r.runner.status().asks[0].id, "no");
    await r.phase("finished");
    expect(recorded(r.log(), "rm")).toEqual({ outcome: "selected", optionId: "reject-once" });
    expect((await r.store.read("agent")).always).toEqual([]);
  });

  it("an answer to an unknown or already answered ask is not found", async () => {
    const r = await rig({ turns: [[exec("rm -rf build", "rm"), { sleep: 100 }]] });
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    const id = r.runner.status().asks[0].id;
    await expect(r.runner.answer("ask_nope", "once")).rejects.toBeInstanceOf(NotFoundError);
    await r.runner.answer(id, "no");
    await expect(r.runner.answer(id, "always")).rejects.toBeInstanceOf(NotFoundError);
    await r.phase("finished");
    expect((await r.store.read("agent")).always).toEqual([]);
  });

  it("stop answers a pending ask cancelled", async () => {
    const r = await rig({ turns: [[exec("rm -rf build", "rm")]] });
    const b = await r.batch("Move the title");
    await r.runner.send(b);
    await r.phase("waiting");
    const id = r.runner.status().asks[0].id;
    await r.runner.stop();
    expect(r.runner.status()).toMatchObject({ phase: "idle", asks: [] });
    expect(r.runner.busy()).toBe(false);
    const log = r.log();
    expect(recorded(log, "rm")).toEqual({ outcome: "cancelled" });
    // Rushes itself answered the request cancelled (Stop lets that answer out before it cancels and kills).
    expect(log.find((m) => m.result?.outcome && !m.method)?.result).toEqual({ outcome: { outcome: "cancelled" } });
    await expect(r.runner.answer(id, "once")).rejects.toBeInstanceOf(NotFoundError);
    expect((await r.store.read("notes")).notes.filter((n) => b.noteIds.includes(n.id)).map(noteState)).toEqual(["todo"]);
  });

  it("an adapter exit answers nothing more and leaves no ask", async () => {
    const r = await rig({ turns: [[{ permission: { toolCall: { toolCallId: "x", title: "Run x", kind: "execute", rawInput: { command: "x" } } } }]] });
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    started[0].kill();
    await r.phase("failed");
    expect(r.runner.status().asks).toEqual([]);
    expect(r.runner.busy()).toBe(false);
  });

  it("an ask is never answered by time passing", async () => {
    const r = await rig({ turns: [[exec("rm -rf build", "rm")]] }, { runner: { idleMs: 50 } });
    await r.runner.send(await r.batch("Move the title"));
    await r.phase("waiting");
    // By design: well past idleMs, with nobody answering.
    await new Promise((res) => setTimeout(res, 300));
    expect(r.runner.status().phase).toBe("waiting");
    expect(r.runner.status().asks).toHaveLength(1);
    expect(r.runner.busy()).toBe(true);
    expect(started[0].hasExited).toBe(false);
    expect(recorded(r.log(), "rm")).toBeUndefined();
  });
});

describe("AgentRunner answers on notes", () => {
  it("an answer on a note during a turn is sent after the turn ends", async () => {
    const r = await rig({ turns: [[{ sleep: 300 }], []] });
    const b = await r.batch("Move the title");
    const promptsWhenB1Ended: number[] = [];
    r.store.on("agent", (s: AgentStatus) => {
      if (s.lines.some((l) => l.text === "Claude Code finished b_1") && !promptsWhenB1Ended.length) promptsWhenB1Ended.push(prompts(r.log()).length);
    });
    await r.runner.send(b);
    await r.phase("working");
    await r.answerOn(b.noteIds[0], "  Up a bit.  ");
    await r.waitFor("the follow-up prompt", () => prompts(r.log()).length === 2);
    expect(promptsWhenB1Ended).toEqual([1]);
    const [first, second] = prompts(r.log());
    expect(promptText(first)).toBe(b.prompt + "\n\n" + AGENT_LINES);
    expect(promptText(second)).toBe(followUp(b.noteIds[0], "Move the title", "Up a bit."));
    expect(second.params.sessionId).toBe("fake-session-1");
    await r.phase("finished");
    expect(started).toHaveLength(1);
  });

  it("an answer on a note while the adapter idles is sent at once", async () => {
    const r = await rig({ turns: [] });
    const b = await r.batch("Move the title");
    await r.runner.send(b);
    await r.phase("finished");
    await r.answerOn(b.noteIds[0], "Up a bit.");
    await r.waitFor("the follow-up prompt", () => prompts(r.log()).length === 2);
    expect(promptText(prompts(r.log())[1])).toBe(followUp(b.noteIds[0], "Move the title", "Up a bit."));
    await r.phase("finished");
    expect(started).toHaveLength(1);
  });

  it("an answer on a note after the adapter exited restarts it and loads the session", async () => {
    const r = await rig({ loadSession: true, turns: [] }, { runner: { idleMs: 30 } });
    const long = "A".repeat(150) + "B".repeat(100);
    const b = await r.batch(long);
    await r.runner.send(b);
    await r.phase("finished");
    await r.waitFor("the first adapter to exit", () => started[0]?.hasExited);
    await r.answerOn(b.noteIds[0], "Yes, both.");
    await r.waitFor("the follow-up prompt", () => prompts(r.log()).length === 2);
    expect(started).toHaveLength(2);
    const log = r.log();
    expect(log.filter((m) => m.loaded).map((m) => m.loaded)).toEqual(["fake-session-1"]);
    expect(log.filter((m) => m.method === "session/new")).toHaveLength(1);
    const second = prompts(log)[1];
    expect(second.params.sessionId).toBe("fake-session-1");
    // The note's text is cut to its first 200 characters.
    expect(promptText(second)).toBe(followUp(b.noteIds[0], long.slice(0, 200), "Yes, both."));
    await r.phase("finished");
  });

  it("an answer that arrives while the adapter is starting goes after the batch that started it", async () => {
    const r = await rig({ loadSession: true, turns: [] }, { runner: { idleMs: 30 } });
    const b1 = await r.batch("One");
    await r.runner.send(b1);
    await r.phase("finished");
    await r.waitFor("the first adapter to exit", () => started[0]?.hasExited);
    const b2 = await r.batch("Two");
    const sending = r.runner.send(b2);
    await r.answerOn(b1.noteIds[0], "Yes");
    expect(await sending).toEqual({ handedTo: "claude" });
    await r.waitFor("three prompts", () => prompts(r.log()).length === 3);
    await r.phase("finished");
    expect(prompts(r.log()).map(promptText)).toEqual([
      b1.prompt + "\n\n" + AGENT_LINES,
      b2.prompt + "\n\n" + AGENT_LINES,
      followUp(b1.noteIds[0], "One", "Yes"),
    ]);
    expect(started).toHaveLength(2);
  });

  it("an answer on a note from outside this run's batches sends nothing", async () => {
    const r = await rig({ turns: [] });
    const b1 = await r.batch("One", "Done already");
    await r.runner.send(b1);
    await r.phase("finished");
    await r.store.update("notes", (f) => void applyReply(f, { id: b1.noteIds[1], reply: "Done.", status: "done" }));
    // b_2 was sent by copying its prompt: never carried by this runner.
    const b2 = await r.batch("Two");
    await r.store.update("notes", (f) => void addNote(f, { stage: "picture", scope: "whole", text: "Not sent" }));
    const todo = (await r.store.read("notes")).notes.find((n) => n.text === "Not sent")!;
    await r.answerOn(b2.noteIds[0], "Yes");
    await r.answerOn(todo.id, "Yes");
    await r.answerOn(b1.noteIds[1], "Yes");
    // Answers are queued in order of arrival, so a batch sent now would run after any follow-up they made.
    const b3 = await r.batch("Three");
    await r.runner.send(b3);
    await r.waitFor("b_3's prompt", () => prompts(r.log()).length >= 2);
    await r.phase("finished");
    expect(prompts(r.log()).map(promptText)).toEqual([b1.prompt + "\n\n" + AGENT_LINES, b3.prompt + "\n\n" + AGENT_LINES]);

    // After a restart, nothing this process carried is known: b_1's open note gets no follow-up either.
    await r.runner.close();
    const again = r.makeRunner();
    await r.waitFor("the new runner to read agent.json", () => again.status().on);
    await r.answerOn(b1.noteIds[0], "Yes");
    const b4 = await r.batch("Four");
    await again.send(b4);
    await r.waitFor("b_4's prompt", () => prompts(r.log()).length >= 3);
    await r.phase("finished", again);
    expect(prompts(r.log()).map(promptText).slice(2)).toEqual([b4.prompt + "\n\n" + AGENT_LINES]);
  });

  it("stop during a follow-up gives that note back and leaves the batch's other notes", async () => {
    const r = await rig({ turns: [[], [{ sleep: 60000 }]] });
    const b1 = await r.batch("One", "Two");
    await r.runner.send(b1);
    await r.phase("finished");
    await r.answerOn(b1.noteIds[0], "Yes");
    await r.waitFor("the follow-up prompt", () => prompts(r.log()).length === 2);
    await r.phase("working");
    expect(r.runner.status().lines.map((l) => l.text)).toContain(`Claude Code picked up your answer on ${b1.noteIds[0]}`);
    await r.runner.stop();
    const [one, two] = (await r.store.read("notes")).notes.filter((n) => b1.noteIds.includes(n.id));
    expect([noteState(one), one.batch]).toEqual(["todo", null]);
    expect([noteState(two), two.batch]).toEqual(["sent", "b_1"]);
  });

  it("a follow-up whose adapter fails to start gives its note back", async () => {
    const r = await rig({ loadSession: true, turns: [] }, { runner: { idleMs: 30 } });
    const b1 = await r.batch("One", "Two");
    await r.runner.send(b1);
    await r.phase("finished");
    await r.waitFor("the first adapter to exit", () => started[0]?.hasExited);
    await r.scenario({ exitOnStart: 9, turns: [] });
    await r.answerOn(b1.noteIds[0], "Yes");
    await r.phase("failed");
    await r.waitFor("the note to come back", async () => {
      const n = (await r.store.read("notes")).notes.find((x) => x.id === b1.noteIds[0])!;
      return noteState(n) === "todo" && n.batch === null;
    });
    const two = (await r.store.read("notes")).notes.find((x) => x.id === b1.noteIds[1])!;
    expect([noteState(two), two.batch]).toEqual(["sent", "b_1"]);
  });

  it("an answer that can't be handed over says so in Activity, except when Send to AI is off", async () => {
    let signedIn = true;
    const r = await rig({ turns: [] }, { runner: { detect: async () => [{ ...claude, signedIn }] } });
    const b1 = await r.batch("One", "Two");
    await r.runner.send(b1);
    await r.phase("finished");
    signedIn = false;
    await r.answerOn(b1.noteIds[0], "Yes");
    const line = `Your answer on ${b1.noteIds[0]} was not sent: Claude Code is not signed in`;
    await r.waitFor("the Activity line", () => r.runner.status().lines.some((l) => l.text === line));
    expect(r.runner.status().lines.find((l) => l.text === line)?.note).toBe(b1.noteIds[0]);

    signedIn = true;
    await r.store.update("agent", (f) => void (f.on = false));
    await r.waitFor("the switch to go off", () => r.runner.status().phase === "off");
    const before = r.runner.status().lines.length;
    await r.answerOn(b1.noteIds[1], "Yes");
    // Turning it back on and sending shows any follow-up the answer had made: there is none, and no line.
    await r.store.update("agent", (f) => void (f.on = true));
    const b2 = await r.batch("Three");
    await r.runner.send(b2);
    await r.waitFor("b_2's prompt", () => prompts(r.log()).length >= 2);
    await r.phase("finished");
    expect(prompts(r.log()).map(promptText).slice(1)).toEqual([b2.prompt + "\n\n" + AGENT_LINES]);
    expect(r.runner.status().lines.slice(before).some((l) => l.text.startsWith("Your answer on"))).toBe(false);
  });

  it("stop drops a queued follow-up along with the queued batches", async () => {
    const r = await rig({ turns: [[{ sleep: 60000 }]] });
    const b1 = await r.batch("One");
    await r.runner.send(b1);
    await r.phase("working");
    await r.answerOn(b1.noteIds[0], "Yes");
    const b2 = await r.batch("Two");
    await r.runner.send(b2);
    expect(r.runner.status().batches).toEqual(["b_1", "b_2"]);
    await r.runner.stop();
    expect(r.runner.status()).toMatchObject({ phase: "idle", batches: [] });
    expect(r.runner.status().lines.some((l) => l.text.includes("picked up your answer"))).toBe(false);
    const notes = (await r.store.read("notes")).notes.filter((n) => [...b1.noteIds, ...b2.noteIds].includes(n.id));
    expect(notes.map(noteState)).toEqual(["todo", "todo"]);
    // Nothing queued survives the Stop: the next send is the only prompt the new adapter gets.
    await r.scenario({ turns: [] });
    const b3 = await r.batch("Three");
    await r.runner.send(b3);
    await r.phase("finished");
    expect(prompts(r.log()).map(promptText)).toEqual([b1.prompt + "\n\n" + AGENT_LINES, b3.prompt + "\n\n" + AGENT_LINES]);
  });
});
