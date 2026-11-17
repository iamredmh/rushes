import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpProject } from "../../helpers/tmp.js";
import { AcpConnection, type AdapterSpec, type McpServerSpec } from "../../../src/server/agent/acp.js";
import { AGENT_START_MS, AgentRunner, type AgentStatus, type RunnerOptions } from "../../../src/server/agent/runner.js";
import type { AgentInfo } from "../../../src/server/agent/detect.js";
import { AGENT_LINES } from "../../../src/core/agentActivity.js";
import { createBatch } from "../../../src/core/batches.js";
import { addNote, addUserReply, applyReply } from "../../../src/core/notes.js";
import { noteState, recallNote } from "../../../src/core/noteState.js";
import { RushesError } from "../../../src/core/errors.js";
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
  // close() leaves no child behind.
  for (const c of started) expect(c.hasExited).toBe(true);
  vi.restoreAllMocks();
});

const claude = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: "claude", name: "Claude Code", installed: true, signedIn: true, path: "/usr/local/bin/claude", signIn: "claude auth login", ...over,
});
const codex: AgentInfo = { id: "codex", name: "Codex", installed: false, signedIn: false, path: null, signIn: "codex login" };
const MCP = (root: string): McpServerSpec => ({ name: "rushes", command: process.execPath, args: ["-e", "", root], env: [] });

interface Rig {
  root: string;
  store: Store;
  runner: AgentRunner;
  log: () => any[];
  scenario: (s: object) => Promise<void>;
  /** Notes on the Picture tab, filed in a new batch exactly as Send files them. */
  batch: (...texts: string[]) => Promise<Batch>;
  waitFor: <T>(what: string, check: () => T | Promise<T>) => Promise<NonNullable<T>>;
  phase: (p: AgentStatus["phase"]) => Promise<void>;
  settings: (over: Partial<AgentSettings>) => Promise<void>;
}

async function rig(scenario: object, opts: { agents?: AgentInfo[]; settings?: Partial<AgentSettings>; runner?: RunnerOptions } = {}): Promise<Rig> {
  const { root, store } = await tmpProject();
  const scenarioPath = join(store.dir, "scenario.json");
  const logPath = join(store.dir, "fake-log.jsonl");
  const writeScenario = (s: object) => writeFile(scenarioPath, JSON.stringify(s));
  await writeScenario(scenario);
  const settings = async (over: Partial<AgentSettings>) => {
    await store.update("agent", (f) => Object.assign(f, over));
  };
  await settings({ on: true, agent: "claude", ...opts.settings });
  const runner = new AgentRunner(store, {
    detect: async () => opts.agents ?? [claude(), codex],
    spec: (_a, r) => ({ command: process.execPath, args: [FAKE], env: { FAKE_ACP_SCENARIO: scenarioPath, FAKE_ACP_LOG: logPath }, cwd: r }),
    mcp: MCP,
    ...opts.runner,
  });
  runners.push(runner);
  const log = () => {
    let text = "";
    try { text = readFileSync(logPath, "utf8"); } catch { /* not written yet */ }
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const batch = async (...texts: string[]) => {
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
  const phase = async (p: AgentStatus["phase"]) => {
    await waitFor(`phase ${p} (now ${runner.status().phase})`, () => runner.status().phase === p);
  };
  // The runner reads agent.json as it starts; wait for that, so a test hears only what it causes.
  const wantOn = opts.settings?.on ?? true;
  await waitFor("the runner to read agent.json", () => runner.status().on === wantOn && (!wantOn || runner.status().agent !== null || opts.settings?.agent === null));
  return { root, store, runner, log, scenario: writeScenario, batch, waitFor, phase, settings };
}

const prompts = (log: any[]) => log.filter((m) => m.method === "session/prompt");
const notesOf = async (store: Store, ids: readonly string[]) => (await store.read("notes")).notes.filter((n) => ids.includes(n.id));
const changeLog = async (store: Store) => (await store.read("log")).entries.map((e) => e.text);

describe("AgentRunner", () => {
  it("send while off hands nothing over and says why", async () => {
    const r = await rig({ turns: [] }, { settings: { on: false } });
    const b = await r.batch("Move the title");
    expect(await r.runner.send(b)).toEqual({ handedTo: null, why: "Send to AI is off" });
    await r.settings({ on: true, agent: null });
    expect(await r.runner.send(b)).toEqual({ handedTo: null, why: "No agent chosen" });
    expect(started).toHaveLength(0);
    expect(r.runner.busy()).toBe(false);
    expect(r.runner.status().batches).toEqual([]);
    // The notes stay with the batch: the desk copies the prompt instead.
    expect((await notesOf(r.store, b.noteIds)).map(noteState)).toEqual(["sent"]);
  });

  it("send while the agent is not signed in says so and starts nothing", async () => {
    const r = await rig({ turns: [] }, { agents: [claude({ signedIn: false }), codex] });
    const b = await r.batch("Move the title");
    expect(await r.runner.send(b)).toEqual({ handedTo: null, why: "Claude Code is not signed in" });
    await r.settings({ agent: "codex" });
    expect(await r.runner.send(b)).toEqual({ handedTo: null, why: "Codex is not installed" });
    expect(started).toHaveLength(0);
    expect(r.runner.status().phase).not.toBe("starting");
  });

  it("first send starts a session in the project folder with the rushes MCP server and stores the session", async () => {
    const r = await rig({ turns: [[{ stop: "end_turn" }]] });
    const b = await r.batch("Move the title");
    expect(await r.runner.send(b)).toEqual({ handedTo: "claude" });
    await r.phase("finished");
    const log = r.log();
    expect(log.map((m) => m.method).filter(Boolean)).toEqual(["initialize", "session/new", "session/prompt"]);
    const created = log.find((m) => m.method === "session/new");
    expect(created.params.cwd).toBe(r.root);
    expect(created.params.mcpServers[0].name).toBe("rushes");
    const text: string = prompts(log)[0].params.prompt[0].text;
    expect(text).toBe(b.prompt + "\n\n" + AGENT_LINES);
    expect(text.endsWith(AGENT_LINES)).toBe(true);
    const settings = await r.store.read("agent");
    expect(settings.session).toMatchObject({ id: "fake-session-1", agent: "claude" });
    expect(r.runner.status().session).toBe("fake-session-1");
    // The stored prompt is the batch's own; the extra lines go only to the agent.
    expect((await r.store.read("batches")).batches[0].prompt).toBe(b.prompt);
  });

  it("a later send loads the kept session when the agent supports it", async () => {
    const r = await rig({ loadSession: true, turns: [] }, { runner: { idleMs: 30 } });
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    await r.waitFor("the first adapter to exit", () => started[0]?.hasExited);
    await r.runner.send(await r.batch("Two"));
    await r.waitFor("the second prompt", () => prompts(r.log()).length === 2);
    expect(started).toHaveLength(2);
    const log = r.log();
    expect(log.filter((m) => m.loaded).map((m) => m.loaded)).toEqual(["fake-session-1"]);
    expect(log.filter((m) => m.method === "session/new")).toHaveLength(1);
    expect(prompts(log)[1].params.sessionId).toBe("fake-session-1");
  });

  it("a later send starts a new session when the agent cannot load sessions", async () => {
    const r = await rig({ loadSession: false, turns: [] }, { runner: { idleMs: 30 } });
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    const first = (await r.store.read("agent")).session!;
    await r.waitFor("the first adapter to exit", () => started[0]?.hasExited);
    await r.runner.send(await r.batch("Two"));
    await r.waitFor("the second prompt", () => prompts(r.log()).length === 2);
    const log = r.log();
    expect(log.some((m) => m.loaded)).toBe(false);
    expect(log.filter((m) => m.method === "session/new")).toHaveLength(2);
    const second = (await r.store.read("agent")).session!;
    expect(second.agent).toBe("claude");
    expect(second.startedAt >= first.startedAt).toBe(true);
  });

  it("a kept session that cannot be loaded falls back to a new conversation", async () => {
    const r = await rig(
      { loadSession: true, loadFails: "Session not found", turns: [] },
      { settings: { session: { id: "pruned-1", agent: "claude", startedAt: "2026-11-01T00:00:00.000Z" } } },
    );
    const b = await r.batch("One");
    expect(await r.runner.send(b)).toEqual({ handedTo: "claude" });
    await r.phase("finished");
    const log = r.log();
    expect(log.filter((m) => m.loaded).map((m) => m.loaded)).toEqual(["pruned-1"]);
    expect(log.filter((m) => m.method === "session/new")).toHaveLength(1);
    expect(prompts(log).map((m) => m.params.sessionId)).toEqual(["fake-session-1"]);
    expect((await r.store.read("agent")).session).toMatchObject({ id: "fake-session-1", agent: "claude" });
    expect(r.runner.status().lines.map((l) => l.text)).toContain("Started a new conversation (the last one could not be loaded)");
    expect(r.runner.status().error).toBeNull();
    expect(started).toHaveLength(1);
  });

  it("a kept session of another agent is not loaded", async () => {
    const r = await rig({ loadSession: true, turns: [] }, { settings: { session: { id: "codex-session", agent: "codex", startedAt: "2026-11-01T00:00:00.000Z" } } });
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    expect(r.log().some((m) => m.loaded)).toBe(false);
    expect((await r.store.read("agent")).session).toMatchObject({ id: "fake-session-1", agent: "claude" });
  });

  it("a second send queues and runs after the first", async () => {
    const r = await rig({ turns: [[{ sleep: 200 }]] });
    const b1 = await r.batch("One");
    const b2 = await r.batch("Two");
    // When the runner moves past b_1, the fake must have seen only one prompt so far.
    const promptsWhenB1Ended: number[] = [];
    r.store.on("agent", (s: AgentStatus) => {
      if (s.batches.length === 1 && s.batches[0] === "b_2") promptsWhenB1Ended.push(prompts(r.log()).length);
    });
    const [one, two] = await Promise.all([r.runner.send(b1), r.runner.send(b2)]);
    expect(one).toEqual({ handedTo: "claude" });
    expect(two).toEqual({ handedTo: "claude" });
    expect(r.runner.status().batches).toEqual(["b_1", "b_2"]);
    expect(r.runner.busy()).toBe(true);
    await r.phase("finished");
    expect(started).toHaveLength(1);
    expect(promptsWhenB1Ended[0]).toBe(1);
    const sent = prompts(r.log()).map((m) => m.params.prompt[0].text);
    expect(sent).toEqual([b1.prompt + "\n\n" + AGENT_LINES, b2.prompt + "\n\n" + AGENT_LINES]);
    expect(r.runner.status().batches).toEqual([]);
    expect(r.runner.busy()).toBe(false);
  });

  it("updates become activity lines with the project root removed", async () => {
    const r = await rig({ turns: [] });
    await r.scenario({
      turns: [[
        { update: { sessionUpdate: "tool_call", toolCallId: "t1", title: `Opened ${r.root}/compositions/engine-sizes.html`, kind: "read" } },
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking" } } },
        { update: { sessionUpdate: "plan", entries: [{ content: "a" }, { content: "b" }, { content: "c" }] } },
        { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } },
      ]],
    });
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    const texts = r.runner.status().lines.map((l) => l.text);
    expect(texts).toContain("Opened compositions/engine-sizes.html");
    expect(texts).toContain("Planned 3 steps");
    expect(texts.indexOf("Opened compositions/engine-sizes.html")).toBeLessThan(texts.indexOf("Planned 3 steps"));
    expect(texts.some((t) => t.includes("Looking"))).toBe(false);
    expect(texts.some((t) => t.includes(r.root))).toBe(false);
    for (const l of r.runner.status().lines) expect(Number.isNaN(Date.parse(l.at))).toBe(false);
  });

  it("lines keep the last 200", async () => {
    const r = await rig({ turns: [] });
    const steps = Array.from({ length: 230 }, (_, i) => ({ update: { sessionUpdate: "tool_call", toolCallId: `t${i}`, title: `Step ${i}` } }));
    await r.scenario({ turns: [steps] });
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    const lines = r.runner.status().lines;
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)!.text).not.toBe("Step 0");
    expect(lines.some((l) => l.text === "Step 229")).toBe(true);
    expect(lines.some((l) => l.text === "Step 0")).toBe(false);
  });

  it("workingOn marks the current note, and is refused for a note that is not sent", async () => {
    const r = await rig({ turns: [[{ sleep: 60000 }]] });
    const b = await r.batch("One");
    await r.store.update("notes", (f) => void addNote(f, { stage: "picture", scope: "whole", text: "Not sent" }));
    const unsent = (await r.store.read("notes")).notes.find((n) => n.text === "Not sent")!;
    await r.runner.send(b);
    await r.phase("working");
    await r.runner.workingOn(b.noteIds[0], "Moving the title up");
    const s = r.runner.status();
    expect(s.current).toEqual({ note: b.noteIds[0], doing: "Moving the title up" });
    expect(s.lines.at(-1)).toMatchObject({ text: "Moving the title up", note: b.noteIds[0] });
    const refused = await r.runner.workingOn(unsent.id, "Something").then(() => null, (e) => e);
    expect(refused).toBeInstanceOf(RushesError);
    expect(refused).toMatchObject({ status: 409, code: "note_not_sent" });
    expect(r.runner.status().current.note).toBe(b.noteIds[0]);
  });

  it("workingOn outside a turn changes nothing, and still refuses a note that is not sent (M2)", async () => {
    const r = await rig({ turns: [] });
    const b = await r.batch("One");
    await r.store.update("notes", (f) => void applyReply(f, { id: b.noteIds[0], reply: "Up or down?" }));
    await r.store.update("notes", (f) => void addNote(f, { stage: "picture", scope: "whole", text: "Not sent" }));
    const unsent = (await r.store.read("notes")).notes.find((n) => n.text === "Not sent")!;
    const heard: AgentStatus[] = [];
    r.store.on("agent", (s: AgentStatus) => heard.push(s));
    // Before any run, and after one has finished.
    await r.runner.workingOn(b.noteIds[0], "Moving the title up");
    await r.runner.send(b);
    await r.phase("question");
    const lines = r.runner.status().lines.length;
    heard.length = 0;
    await r.runner.workingOn(b.noteIds[0], "Moving the title up");
    expect(r.runner.status().current).toEqual({ note: null, doing: null });
    expect(r.runner.status().lines).toHaveLength(lines);
    expect(r.runner.status().lines.some((l) => l.text === "Moving the title up")).toBe(false);
    expect(heard).toEqual([]);
    await expect(r.runner.workingOn(unsent.id, "Something")).rejects.toMatchObject({ status: 409, code: "note_not_sent" });
  });

  it("when a turn ends, the notes it left untouched go back to to do; done and asked ones stay (M3)", async () => {
    const r = await rig({ turns: [[{ sleep: 300 }], [{ stop: "refusal" }], [{ stop: "max_tokens" }]] });
    const b1 = await r.batch("Done one", "Asked one", "Untouched one");
    await r.runner.send(b1);
    await r.phase("working");
    await r.store.update("notes", (f) => {
      applyReply(f, { id: b1.noteIds[0], reply: "Done.", status: "done" });
      applyReply(f, { id: b1.noteIds[1], reply: "Up or down?" });
    });
    await r.phase("question");
    expect((await notesOf(r.store, b1.noteIds)).map((n) => [noteState(n), n.batch])).toEqual([["done", "b_1"], ["sent", "b_1"], ["todo", null]]);
    expect(r.runner.status().lines.map((l) => l.text)).toContain("1 note was not picked up and is back in to do");

    // Any stop reason: a refusal leaves both notes of b_2 untouched.
    const b2 = await r.batch("Two", "Three");
    expect(b2.noteIds).toHaveLength(3); // b_1's untouched note goes again
    await r.runner.send(b2);
    await r.phase("finished");
    expect((await notesOf(r.store, b2.noteIds)).map(noteState)).toEqual(["todo", "todo", "todo"]);
    expect(r.runner.status().lines.map((l) => l.text)).toContain("3 notes were not picked up and are back in to do");

    // A follow-up turn answers for its own note: b_1's asked note, answered, comes back when the turn leaves it.
    const lines = r.runner.status().lines.length;
    await r.store.update("notes", (f) => void addUserReply(f, b1.noteIds[1], "Up."));
    r.store.emit("user-reply", { note: b1.noteIds[1], text: "Up." });
    await r.waitFor("the follow-up to end", () => r.runner.status().lines.slice(lines).some((l) => l.text.startsWith("Claude Code ended your answer")));
    await r.phase("finished");
    expect((await notesOf(r.store, [b1.noteIds[1]])).map(noteState)).toEqual(["todo"]);
    expect(r.runner.status().lines.slice(lines).map((l) => l.text)).toContain("1 note was not picked up and is back in to do");
  });

  it("a turn that ends with every note done or asked says nothing about notes coming back (M3)", async () => {
    const r = await rig({ turns: [] });
    const b = await r.batch("One");
    await r.store.update("notes", (f) => void applyReply(f, { id: b.noteIds[0], reply: "Up or down?" }));
    await r.runner.send(b);
    await r.phase("question");
    expect(r.runner.status().lines.some((l) => l.text.includes("not picked up"))).toBe(false);
    expect((await notesOf(r.store, b.noteIds)).map(noteState)).toEqual(["sent"]);
  });

  /** A detect whose first call answers at once and every later one waits until `release()` (a follow-up held in accept). */
  const heldDetect = () => {
    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const detect = async () => {
      if (calls++ > 0) await held;
      return [claude(), codex];
    };
    return { detect, release, calls: () => calls };
  };
  /** Every state `id` is written in, in order, as the store's notes updates write it. */
  const watchNote = (store: Store, id: string) => {
    const states: string[] = [];
    const real = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementation((async (key: any, fn: any, rev?: number) => {
      const out = await real(key, fn, rev);
      if (key === "notes") {
        const n = (out.data as any).notes.find((x: any) => x.id === id);
        if (n) states.push(noteState(n));
      }
      return out;
    }) as any);
    return states;
  };

  it("a turn that ends while an answer's follow-up is still being accepted leaves that note to the follow-up (Residual 2)", async () => {
    const d = heldDetect();
    const r = await rig({ turns: [[{ sleep: 300 }], [{ sleep: 200 }]] }, { runner: { detect: d.detect } });
    const b = await r.batch("Move the title", "Fix the colour");
    const [asked, untouched] = b.noteIds;
    const states = watchNote(r.store, asked);
    await r.runner.send(b);
    await r.phase("working");
    await r.store.update("notes", (f) => void applyReply(f, { id: asked, reply: "Which title?" }));
    // The user answers before the turn ends; the follow-up waits in accept (detect) past the turn's end.
    await r.store.update("notes", (f) => void addUserReply(f, asked, "The top one"));
    r.store.emit("user-reply", { note: asked, text: "The top one" });
    await r.waitFor("the follow-up to reach detect", () => d.calls() >= 2);
    await r.phase("finished");
    expect((await notesOf(r.store, [asked, untouched])).map(noteState)).toEqual(["sent", "todo"]);
    const texts = () => r.runner.status().lines.map((l) => l.text);
    expect(texts()).toContain("1 note was not picked up and is back in to do");
    expect(texts().some((t) => t.startsWith("2 notes"))).toBe(false);

    d.release();
    await r.waitFor("the follow-up to start", () => texts().includes(`Claude Code picked up your answer on ${asked}`));
    expect((await notesOf(r.store, [asked])).map(noteState)).toEqual(["sent"]);
    const sent = prompts(r.log());
    expect(sent).toHaveLength(2);
    expect(sent[1].params.prompt[0].text).toContain(`The user answered on note ${asked} ("Move the title"): The top one`);
    expect(states).not.toContain("todo");
    // The follow-up turn itself, left untouched, still gives its own note back (M3).
    await r.waitFor("the follow-up to end", () => texts().includes(`Claude Code finished your answer on ${asked}`));
    await r.phase("finished");
    expect((await notesOf(r.store, [asked])).map(noteState)).toEqual(["todo"]);
  });

  it("a follow-up whose note was taken back while it was being accepted is dropped quietly: no turn, no line (Residual 2)", async () => {
    const d = heldDetect();
    const r = await rig({ turns: [] }, { runner: { detect: d.detect } });
    const b = await r.batch("Move the title");
    const id = b.noteIds[0];
    await r.store.update("notes", (f) => void applyReply(f, { id, reply: "Which title?" }));
    await r.runner.send(b);
    await r.phase("question");
    const lines = r.runner.status().lines.length;
    await r.store.update("notes", (f) => void addUserReply(f, id, "The top one"));
    r.store.emit("user-reply", { note: id, text: "The top one" });
    await r.waitFor("the follow-up to reach detect", () => d.calls() >= 2);
    // Another path takes the note back meanwhile.
    await r.store.update("notes", (f) => void recallNote(f.notes, id));
    d.release();
    await new Promise((res) => setTimeout(res, 300));
    expect(prompts(r.log())).toHaveLength(1);
    expect(r.runner.status().lines.slice(lines)).toEqual([]);
    expect(r.runner.busy()).toBe(false);
    expect((await notesOf(r.store, [id])).map(noteState)).toEqual(["todo"]);
  });

  it("a follow-up still being accepted when Rushes closes gives its note back (Residual minor)", async () => {
    const d = heldDetect();
    const r = await rig({ turns: [] }, { runner: { detect: d.detect } });
    const b = await r.batch("Move the title");
    const id = b.noteIds[0];
    await r.store.update("notes", (f) => void applyReply(f, { id, reply: "Which title?" }));
    await r.runner.send(b);
    await r.phase("question");
    await r.store.update("notes", (f) => void addUserReply(f, id, "The top one"));
    r.store.emit("user-reply", { note: id, text: "The top one" });
    await r.waitFor("the follow-up to reach detect", () => d.calls() >= 2);
    const closing = r.runner.close();
    d.release();
    await closing;
    expect(prompts(r.log())).toHaveLength(1);
    expect((await notesOf(r.store, [id])).map((n) => [noteState(n), n.batch])).toEqual([["todo", null]]);
  });

  it("a turn that leaves a question ends in phase question; one without ends finished", async () => {
    const r = await rig({ turns: [] });
    const b = await r.batch("Move the title");
    // The agent asked on the note (rushes_reply with no status): it needs the user.
    await r.store.update("notes", (f) => void applyReply(f, { id: b.noteIds[0], reply: "Up or down?" }));
    await r.runner.send(b);
    await r.phase("question");
    expect(r.runner.busy()).toBe(false);
    await r.runner.send(await r.batch("Trim the end"));
    await r.waitFor("the second prompt", () => prompts(r.log()).length === 2);
    // The phase follows the batch the turn carried: b_2 asked nothing.
    await r.phase("finished");

    const plain = await rig({ turns: [] });
    await plain.runner.send(await plain.batch("Move the title"));
    await plain.phase("finished");
  });

  it("stop cancels the turn and gives the unfinished notes back", async () => {
    const r = await rig({ turns: [[{ sleep: 60000 }]] });
    const b1 = await r.batch("One", "Two");
    const b2 = await r.batch("Three");
    await r.store.update("notes", (f) => void applyReply(f, { id: b1.noteIds[1], reply: "Done.", status: "done" }));
    await Promise.all([r.runner.send(b1), r.runner.send(b2)]);
    await r.phase("working");
    await r.runner.stop();
    expect(r.log().some((m) => m.method === "session/cancel")).toBe(true);
    const s = r.runner.status();
    expect(s.phase).toBe("idle");
    expect(s.batches).toEqual([]);
    expect(r.runner.busy()).toBe(false);
    expect(started[0].hasExited).toBe(true);
    const [one, two, three] = await notesOf(r.store, [...b1.noteIds, ...b2.noteIds]);
    expect([one.status, one.batch]).toEqual(["todo", null]);
    expect([two.status, two.batch]).toEqual(["done", "b_1"]);
    expect([three.status, three.batch]).toEqual(["todo", null]);
    expect(await changeLog(r.store)).toContain("Stopped Claude Code");
    // The session is kept for the next send.
    expect((await r.store.read("agent")).session?.id).toBe("fake-session-1");
  });

  it("stop is never a failure, even when the adapter exits on cancel", async () => {
    const r = await rig({ exitOnCancel: true, turns: [[{ sleep: 60000 }]] });
    const heard: AgentStatus[] = [];
    r.store.on("agent", (s: AgentStatus) => heard.push(s));
    const b = await r.batch("One");
    await r.runner.send(b);
    await r.phase("working");
    await r.runner.stop();
    expect(r.runner.status()).toMatchObject({ phase: "idle", error: null });
    // close waits for every write a stray failure would have started.
    await r.runner.close();
    const phases = heard.map((s) => s.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(["starting", "working", "idle"]);
    const texts = await changeLog(r.store);
    expect(texts).toContain("Stopped Claude Code");
    expect(texts.some((t) => t.includes("stopped unexpectedly"))).toBe(false);
    expect((await notesOf(r.store, b.noteIds)).map(noteState)).toEqual(["todo"]);
  });

  it("a plain refusal is not flagged as stopped", async () => {
    const r = await rig({ turns: [] }, { settings: { on: false } });
    expect(await r.runner.send(await r.batch("One"))).not.toHaveProperty("stopped");
  });

  it("stop with nothing running changes nothing", async () => {
    const r = await rig({ turns: [] });
    const heard: AgentStatus[] = [];
    r.store.on("agent", (s: AgentStatus) => heard.push(s));
    await r.runner.stop();
    expect(heard).toEqual([]);
    expect(await changeLog(r.store)).not.toContain("Stopped Claude Code");
  });

  it("stop while the adapter is starting kills it and gives the notes back", async () => {
    // An adapter that never answers initialize, so the run stays in starting until Stop.
    const r = await rig({ turns: [] }, { runner: { spec: (_a, root) => ({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: {}, cwd: root }) } });
    const b = await r.batch("One");
    const sending = r.runner.send(b);
    await r.phase("starting");
    await r.runner.stop();
    // Flagged, so the desk doesn't copy the prompt after the user pressed Stop.
    expect(await sending).toEqual({ handedTo: null, why: "Stopped before the agent started", stopped: true });
    expect(r.runner.status().phase).toBe("idle");
    expect(started.every((c) => c.hasExited)).toBe(true);
    expect((await notesOf(r.store, b.noteIds)).map(noteState)).toEqual(["todo"]);
  });

  it("adapter exit mid-turn fails the run and recalls its notes", async () => {
    const r = await rig({ loadSession: true, turns: [[{ stderr: "warming up\nboom: out of memory\n" }, { crash: 3 }]] });
    const b = await r.batch("One");
    await r.runner.send(b);
    await r.phase("failed");
    expect(r.runner.status().error).toBe("Claude Code stopped unexpectedly: boom: out of memory");
    await r.waitFor("the notes to come back", async () => (await notesOf(r.store, b.noteIds)).every((n) => noteState(n) === "todo"));
    await r.waitFor("the Change Log line", async () => (await changeLog(r.store)).some((t) => t.startsWith("Claude Code stopped unexpectedly")));
    expect(r.runner.busy()).toBe(false);
    // The next send starts a fresh adapter and loads the kept session.
    await r.scenario({ loadSession: true, turns: [] });
    expect(await r.runner.send(await r.batch("Two"))).toEqual({ handedTo: "claude" });
    await r.phase("finished");
    expect(started).toHaveLength(2);
    expect(r.log().filter((m) => m.loaded).map((m) => m.loaded)).toEqual(["fake-session-1"]);
    expect(r.runner.status().error).toBeNull();
  });

  it("adapter exit mid-turn recalls the queued batches too", async () => {
    const r = await rig({ turns: [[{ sleep: 150 }, { crash: 4 }]] });
    const b1 = await r.batch("One");
    const b2 = await r.batch("Two", "Three");
    await Promise.all([r.runner.send(b1), r.runner.send(b2)]);
    expect(r.runner.status().batches).toEqual(["b_1", "b_2"]);
    await r.phase("failed");
    expect(r.runner.status().batches).toEqual([]);
    const ids = [...b1.noteIds, ...b2.noteIds];
    await r.waitFor("every note to come back", async () => (await notesOf(r.store, ids)).every((n) => noteState(n) === "todo" && n.batch === null));
    expect(prompts(r.log())).toHaveLength(1);
  });

  it("adapter exit with no stderr says only that it stopped", async () => {
    const r = await rig({ turns: [[{ crash: 1 }]] });
    await r.runner.send(await r.batch("One"));
    await r.phase("failed");
    expect(r.runner.status().error).toBe("Claude Code stopped unexpectedly");
  });

  it("an adapter that fails to start fails the send, which says why, and recalls its notes", async () => {
    const r = await rig({ exitOnStart: 7, turns: [] });
    const b = await r.batch("One");
    const b2 = await r.batch("Two");
    // A second Send joins the start in flight, and is refused with it.
    const [result, second] = await Promise.all([r.runner.send(b), r.runner.send(b2)]);
    expect(result.handedTo).toBeNull();
    const why = (result as { why: string }).why;
    expect(why).toMatch(/Claude Code/);
    // R12: a refusal after a start began carries recalled, so the desk doesn't copy the prompt.
    expect(result).toEqual({ handedTo: null, why, recalled: true });
    expect(second).toEqual({ handedTo: null, why, recalled: true });
    expect((await notesOf(r.store, b2.noteIds)).map(noteState)).toEqual(["todo"]);
    const s = r.runner.status();
    expect(s.phase).toBe("failed");
    expect(s.error).toBe(why);
    expect((await notesOf(r.store, b.noteIds)).map(noteState)).toEqual(["todo"]);
    expect(r.runner.busy()).toBe(false);
  });

  it("an adapter that never finishes starting fails after startMs, is killed, and gives its notes back", async () => {
    const r = await rig({ hangOnInitialize: true, turns: [] }, { runner: { startMs: 300 } });
    const b = await r.batch("One");
    const t0 = Date.now();
    const result = await r.runner.send(b);
    expect(Date.now() - t0).toBeLessThan(3000);
    // R12: the notes were recalled, so the desk doesn't copy the prompt.
    expect(result).toEqual({ handedTo: null, why: "Claude Code did not start within 0.3 seconds", recalled: true });
    const s = r.runner.status();
    expect(s.phase).toBe("failed");
    expect(s.error).toBe("Claude Code did not start within 0.3 seconds");
    expect((await notesOf(r.store, b.noteIds)).map(noteState)).toEqual(["todo"]);
    expect(r.runner.busy()).toBe(false);
    await r.waitFor("the adapter to exit", () => started[0].hasExited);
    // The next Send starts a fresh adapter.
    await r.scenario({ turns: [] });
    expect(await r.runner.send(await r.batch("Two"))).toEqual({ handedTo: "claude" });
  });

  it("the start timeout defaults to two minutes and says so", async () => {
    expect(AGENT_START_MS).toBe(120_000);
    const r = await rig({ hangOnInitialize: true, turns: [] }, { runner: { startMs: 120_000 } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const sending = r.runner.send(await r.batch("One"));
      // Only setTimeout is faked: setImmediate still turns, so poll with it.
      for (let i = 0; i < 1000 && r.runner.status().phase !== "starting"; i++) await new Promise((ok) => setImmediate(ok));
      expect(r.runner.status().phase).toBe("starting");
      await vi.advanceTimersByTimeAsync(119_000);
      expect(r.runner.status().phase).toBe("starting");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await sending).toEqual({ handedTo: null, why: "Claude Code did not start within 2 minutes", recalled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the adapter exits after idleMs with nothing to do, keeping the session", async () => {
    const r = await rig({ turns: [] }, { runner: { idleMs: 50 } });
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    await r.waitFor("the adapter to exit", () => started[0].hasExited);
    expect((await r.store.read("agent")).session?.id).toBe("fake-session-1");
    expect(r.runner.status().phase).toBe("finished");
    expect(r.runner.status().session).toBe("fake-session-1");
  });

  it("the adapter stays up between turns while idleMs has not passed", async () => {
    const r = await rig({ turns: [] });
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    await r.runner.send(await r.batch("Two"));
    await r.waitFor("the second prompt", () => prompts(r.log()).length === 2);
    await r.phase("finished");
    expect(started).toHaveLength(1);
    expect(r.log().filter((m) => m.method === "initialize")).toHaveLength(1);
  });

  it("every status change is announced on the store", async () => {
    const r = await rig({ turns: [[{ update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran the render" } }]] });
    const heard: AgentStatus[] = [];
    r.store.on("agent", (s: AgentStatus) => heard.push(s));
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    const phases = heard.map((s) => s.phase).filter((p, i, all) => p !== all[i - 1]);
    expect(phases).toEqual(["starting", "working", "finished"]);
    expect(heard.some((s) => s.lines.some((l) => l.text === "Ran the render"))).toBe(true);
    expect(heard.at(-1)).toEqual(r.runner.status());
    expect(heard[0]).toMatchObject({ on: true, agent: "claude", batches: ["b_1"], asks: [], error: null });
  });

  it("the Change Log gets the milestones, not the activity", async () => {
    const r = await rig({ turns: [[{ update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Ran the render" } }]] });
    await r.runner.send(await r.batch("One"));
    await r.phase("finished");
    const texts = await r.waitFor("the finished line", async () => {
      const t = await changeLog(r.store);
      return t.some((x) => x.includes("finished")) ? t : null;
    });
    expect(texts.some((t) => t.includes("started") && t.includes("b_1"))).toBe(true);
    expect(texts.some((t) => t.includes("Ran the render"))).toBe(false);
  });

  it("close during a turn ends the adapter and puts the in-flight and queued batches' notes back in to do (I3)", async () => {
    const r = await rig({ turns: [[{ sleep: 60000 }]] });
    const b = await r.batch("One", "Two");
    await r.runner.send(b);
    await r.phase("working");
    const queued = await r.batch("Three");
    await r.runner.send(queued);
    // A note the agent already finished stays done.
    await r.store.update("notes", (f) => void applyReply(f, { id: b.noteIds[1], reply: "Done.", status: "done" }));
    await r.runner.close();
    expect(started[0].hasExited).toBe(true);
    expect((await notesOf(r.store, b.noteIds)).map(noteState)).toEqual(["todo", "done"]);
    expect((await notesOf(r.store, queued.noteIds)).map(noteState)).toEqual(["todo"]);
    expect(await r.runner.send(await r.batch("Four"))).toMatchObject({ handedTo: null });
  });

  it("status reads the switch and the agent from agent.json", async () => {
    const r = await rig({ turns: [] });
    await r.waitFor("the settings to load", () => r.runner.status().on);
    expect(r.runner.status()).toMatchObject({ on: true, agent: "claude", phase: "idle" });
    await r.settings({ on: false });
    await r.waitFor("the switch to go off", () => r.runner.status().phase === "off");
    expect(r.runner.status().on).toBe(false);
  });
});
