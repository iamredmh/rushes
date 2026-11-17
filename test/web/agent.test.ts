// Send to AI in the desk (plan 2, task 1): the pure helpers behind the chip, the note badges, the who-line,
// the live strip and what the desk does after Send. Every string is the plan's own.
import { describe, expect, it } from "vitest";
import {
  MENU_WORDS, PERMISSION_CHOICES, afterSend, focusAfterRemove, agentName, canStop, chipShows, chipText, chipTone, footLine, liveLines, menuAgents, menuRowCount, noteAgentBadge, rowText, ruleRows, whoLine,
  type NoteLite,
} from "../../web/src/agent.js";
import type { AgentInfo, AgentStatus } from "../../web/src/types.js";

const status = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  on: true, agent: "claude", phase: "idle", batches: [], current: { note: null, doing: null }, asks: [], lines: [], error: null, session: null,
  permissions: "project-edits", always: [], ...over,
});

const note = (id: string, over: Partial<NoteLite> = {}): NoteLite => ({ id, batch: null, status: "todo", fixVersion: null, ...over });

/** Three notes in batch b1 and one in b2. */
const notes: NoteLite[] = [note("n1", { batch: "b1" }), note("n2", { batch: "b1" }), note("n9", { batch: "b2" }), note("n3", { batch: "b1" })];

describe("agentName", () => {
  it("names each agent, and says your agent for none", () => {
    expect(agentName("claude")).toBe("Claude Code");
    expect(agentName("codex")).toBe("Codex");
    expect(agentName(null)).toBe("your agent");
  });
});

describe("chipText", () => {
  it("starting", () => {
    expect(chipText(status({ phase: "starting" }), notes)).toBe("Starting Claude Code");
  });

  it("working on a note in a batch: its place among that batch's notes", () => {
    const s = status({ phase: "working", batches: ["b1"], current: { note: "n2", doing: "Editing the cut" } });
    expect(chipText(s, notes)).toBe("Claude Code · note 2 of 3");
    expect(chipText({ ...s, current: { note: "n3", doing: null } }, notes)).toBe("Claude Code · note 3 of 3");
  });

  it("working with no current note", () => {
    expect(chipText(status({ phase: "working", agent: "codex" }), notes)).toBe("Codex is working");
  });

  it("working on a note it doesn't hold, or one in no batch, is just working", () => {
    expect(chipText(status({ phase: "working", current: { note: "gone", doing: null } }), notes)).toBe("Claude Code is working");
    expect(chipText(status({ phase: "working", current: { note: "n0", doing: null } }), [note("n0")])).toBe("Claude Code is working");
  });

  it("waiting", () => {
    expect(chipText(status({ phase: "waiting" }), notes)).toBe("Claude Code is waiting for you");
  });

  it("question", () => {
    expect(chipText(status({ phase: "question" }), notes)).toBe("Claude Code has a question");
  });

  it("finished", () => {
    expect(chipText(status({ phase: "finished" }), notes)).toBe("Claude Code finished");
  });

  it("failed", () => {
    expect(chipText(status({ phase: "failed" }), notes)).toBe("Claude Code didn't finish");
  });

  it("off and idle show no chip", () => {
    expect(chipText(status({ phase: "off", on: false, agent: null }), notes)).toBeNull();
    expect(chipText(status({ phase: "idle" }), notes)).toBeNull();
    expect(chipText(status({ phase: "idle", batches: ["b1", "b2"] }), notes)).toBeNull();
  });

  it("with no agent chosen it names your agent", () => {
    expect(chipText(status({ phase: "starting", agent: null }), notes)).toBe("Starting your agent");
  });

  it("adds the batch count when more than one is in hand", () => {
    const s = status({ phase: "working", batches: ["b1", "b2"], current: { note: "n1", doing: null } });
    expect(chipText(s, notes)).toBe("Claude Code · note 1 of 3 · 2 batches");
    expect(chipText(status({ phase: "waiting", batches: ["b1", "b2", "b3"] }), notes)).toBe("Claude Code is waiting for you · 3 batches");
    expect(chipText(status({ phase: "working", batches: ["b1"] }), notes)).toBe("Claude Code is working");
  });
});

describe("noteAgentBadge", () => {
  const working = status({ phase: "working", batches: ["b1"], current: { note: "n1", doing: "Trimming the intro" } });

  it("a note that needs you says so, ahead of everything", () => {
    expect(noteAgentBadge(note("n1", { batch: "b1", needsYou: true }), working)).toEqual({ kind: "needsYou", text: "Needs you" });
  });

  it("the note being worked on says what the agent is doing", () => {
    expect(noteAgentBadge(note("n1", { batch: "b1" }), working)).toEqual({ kind: "working", text: "Trimming the intro" });
  });

  it("the note being worked on with nothing said yet: Working on it", () => {
    const s = { ...working, current: { note: "n1", doing: null } };
    expect(noteAgentBadge(note("n1", { batch: "b1" }), s)).toEqual({ kind: "working", text: "Working on it" });
  });

  it("the current note outside a running phase is only with the agent", () => {
    const s = { ...working, phase: "finished" as const };
    expect(noteAgentBadge(note("n1", { batch: "b1" }), s)).toEqual({ kind: "with", text: "With Claude Code" });
  });

  it("a sent note is with the agent", () => {
    expect(noteAgentBadge(note("n2", { batch: "b1" }), working)).toEqual({ kind: "with", text: "With Claude Code" });
    expect(noteAgentBadge(note("n2", { batch: "b1" }), null)).toEqual({ kind: "with", text: "With your agent" });
  });

  it("a done note with a fix version says where it was fixed", () => {
    expect(noteAgentBadge(note("n2", { batch: "b1", status: "done", fixVersion: "v8" }), working)).toEqual({ kind: "fixed", text: "Fixed in v8" });
  });

  it("anything else has no badge", () => {
    expect(noteAgentBadge(note("n2", { status: "done" }), working)).toBeNull();
    expect(noteAgentBadge(note("n4"), working)).toBeNull();
    expect(noteAgentBadge(note("n4"), null)).toBeNull();
  });
});

describe("afterSend", () => {
  it("no hand-over at all, or a plain refusal: the Copy prompt dialog", () => {
    expect(afterSend(undefined)).toBe("dialog");
    expect(afterSend({ handedTo: null, why: "Send to AI is off" })).toBe("dialog");
  });

  it("a Stop's refusal", () => {
    expect(afterSend({ handedTo: null, why: "Stopped", stopped: true })).toBe("stopped");
  });

  it("a recalled start, even with no reason given", () => {
    expect(afterSend({ handedTo: null, why: "Claude Code did not start", recalled: true })).toBe("recalled");
    expect(afterSend({ handedTo: null, recalled: true } as never)).toBe("recalled");
  });

  it("still starting", () => {
    expect(afterSend({ handedTo: "claude", starting: true })).toBe("starting");
  });

  it("handed over", () => {
    expect(afterSend({ handedTo: "codex" })).toBe("handed");
  });
});

describe("whoLine", () => {
  it("ask-all", () => {
    expect(whoLine(status({ permissions: "ask-all" }))).toBe("Asks before everything");
  });

  it("project-edits", () => {
    expect(whoLine(status({ permissions: "project-edits" }))).toBe("Edits files in this project, asks before commands");
  });

  it("says the next Send continues a conversation there is", () => {
    expect(whoLine(status({ permissions: "ask-all", session: "s1" }))).toBe("Asks before everything · next Send continues the conversation");
    expect(whoLine(status({ session: "s1" }))).toBe("Edits files in this project, asks before commands · next Send continues the conversation");
  });
});

describe("liveLines", () => {
  const line = (i: number) => ({ at: `2026-11-17T10:00:${String(i).padStart(2, "0")}Z`, text: `line ${i}`, note: null });

  it("the newest lines first, at most 20 by default", () => {
    const s = status({ lines: Array.from({ length: 30 }, (_, i) => line(i)) });
    const got = liveLines(s);
    expect(got).toHaveLength(20);
    expect(got[0].text).toBe("line 29");
    expect(got[19].text).toBe("line 10");
  });

  it("takes a smaller limit, and fewer lines than the limit", () => {
    const s = status({ lines: [line(1), line(2), line(3)] });
    expect(liveLines(s, 2).map((l) => l.text)).toEqual(["line 3", "line 2"]);
    expect(liveLines(s).map((l) => l.text)).toEqual(["line 3", "line 2", "line 1"]);
  });

  it("never reorders the status it was given", () => {
    const s = status({ lines: [line(1), line(2)] });
    liveLines(s);
    expect(s.lines.map((l) => l.text)).toEqual(["line 1", "line 2"]);
  });
});

describe("the chip (task 2)", () => {
  const at = (iso: string) => ({ at: iso, text: "a line", note: null });
  const now = Date.parse("2026-11-17T12:00:00Z");

  it("chipShows: never for off or idle", () => {
    expect(chipShows(status({ phase: "off" }), now)).toBe(false);
    expect(chipShows(status({ phase: "idle" }), now)).toBe(false);
  });

  it("chipShows: always while the run is going", () => {
    for (const phase of ["starting", "working", "waiting", "question"] as const) {
      expect(chipShows(status({ phase, lines: [at("2026-11-17T09:00:00Z")] }), now)).toBe(true);
    }
  });

  it("chipShows: an ended run for 10 minutes after its newest line, then not", () => {
    for (const phase of ["finished", "failed"] as const) {
      expect(chipShows(status({ phase, lines: [at("2026-11-17T11:40:00Z"), at("2026-11-17T11:50:00Z")] }), now)).toBe(true);
      expect(chipShows(status({ phase, lines: [at("2026-11-17T11:49:59Z")] }), now)).toBe(false);
      // The newest line counts, wherever it sits.
      expect(chipShows(status({ phase, lines: [at("2026-11-17T11:55:00Z"), at("2026-11-17T11:00:00Z")] }), now)).toBe(true);
    }
  });

  it("chipShows: an ended run with no lines to date it still shows", () => {
    expect(chipShows(status({ phase: "finished" }), now)).toBe(true);
  });

  it("chipTone: busy while starting or working, to do while it waits on you, done, and over for a failure", () => {
    expect(chipTone("starting")).toBe("busy");
    expect(chipTone("working")).toBe("busy");
    expect(chipTone("waiting")).toBe("todo");
    expect(chipTone("question")).toBe("todo");
    expect(chipTone("finished")).toBe("done");
    expect(chipTone("failed")).toBe("over");
  });

  it("canStop: while starting, working or waiting only", () => {
    expect((["off", "idle", "starting", "working", "waiting", "question", "finished", "failed"] as const).filter(canStop)).toEqual(["starting", "working", "waiting"]);
  });
});

describe("the Send to AI row and the agent menu (task 3)", () => {
  const info = (id: "claude" | "codex", over: Partial<AgentInfo> = {}): AgentInfo => ({
    id, name: id === "claude" ? "Claude Code" : "Codex", installed: true, signedIn: true, path: `/usr/local/bin/${id}`, signIn: `${id} login`, ...over,
  });

  it("rowText: the agent by name, or Set up Send to AI with none chosen", () => {
    expect(rowText(status())).toBe("Send to AI · Claude Code");
    expect(rowText(status({ agent: "codex", on: false }))).toBe("Send to AI · Codex");
    expect(rowText(status({ agent: null, on: false }))).toBe("Set up Send to AI");
  });

  it("footLine: the who-line while on, what Send does while off", () => {
    expect(footLine(status())).toBe("Edits files in this project, asks before commands");
    expect(footLine(status({ permissions: "ask-all", session: "s1" }))).toBe("Asks before everything · next Send continues the conversation");
    expect(footLine(status({ on: false }))).toBe("Copies a prompt for your own chat");
    expect(footLine(status({ on: false, agent: null }))).toBe("Copies a prompt for your own chat");
  });

  it("menuAgents: installed agents only, in order, the current one ticked", () => {
    const got = menuAgents([info("claude"), info("codex", { signedIn: false })], status({ agent: "codex" }));
    expect(got).toEqual([
      { id: "claude", name: "Claude Code", signedIn: true, current: false },
      { id: "codex", name: "Codex", signedIn: false, current: true },
    ]);
    expect(menuAgents([info("claude", { installed: false, signedIn: false }), info("codex")], status())).toEqual([
      { id: "codex", name: "Codex", signedIn: true, current: false },
    ]);
    expect(menuAgents(null, status())).toEqual([]);
  });

  it("ruleRows: each Always rule by its label, and the rule to remove", () => {
    const always = [{ kind: "execute", command: "npx hyperframes" }, { kind: "fetch", command: null }];
    expect(ruleRows(status({ always }))).toEqual([
      { rule: always[0], label: "Always for npx hyperframes here" },
      { rule: always[1], label: "Always for web requests here" },
    ]);
    expect(ruleRows(status())).toEqual([]);
  });

  it("menuRowCount: every row the arrows reach", () => {
    const agents = menuAgents([info("claude"), info("codex", { signedIn: false })], status());
    // Two agents, Codex's Sign in, the two permissions.
    expect(menuRowCount(status(), agents)).toBe(5);
    // A conversation to start fresh from, and a rule's Remove.
    expect(menuRowCount(status({ session: "s1", always: [{ kind: "execute", command: "npx hyperframes" }] }), agents)).toBe(7);
  });

  it("focusAfterRemove: the next rule's Remove, else the previous one's, else the menu's first row", () => {
    const agents = menuAgents([info("claude"), info("codex")], status());
    const r = (command: string) => ({ kind: "execute", command });
    // Two agents and two permissions come first: the Removes start at row 4.
    const three = status({ always: [r("a b"), r("c d"), r("e f")] });
    expect(focusAfterRemove(three, agents, 0)).toBe(4);
    expect(focusAfterRemove(three, agents, 1)).toBe(5);
    expect(focusAfterRemove(three, agents, 2)).toBe(5);
    expect(focusAfterRemove(status({ always: [r("a b")] }), agents, 0)).toBe(0);
    // A conversation to start fresh from moves the Removes down a row.
    expect(focusAfterRemove(status({ session: "s1", always: [r("a b"), r("c d")] }), agents, 1)).toBe(5);
  });

  it("the menu's fixed words", () => {
    expect(PERMISSION_CHOICES).toEqual([
      { value: "project-edits", label: "Edit files in this project" },
      { value: "ask-all", label: "Ask me for everything" },
    ]);
    expect(MENU_WORDS).toEqual({
      sendTo: "Send notes to",
      signedIn: "Signed in",
      notSignedIn: "Not signed in",
      signIn: "Sign in in Terminal",
      fresh: "Start a fresh conversation",
      may: "What it may do without asking",
      always: "Always rules",
      noRules: "No Always rules yet",
      remove: "Remove",
      footer: "Switch off: Send copies a prompt, as now",
    });
  });
});
