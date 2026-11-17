// Send to AI in the desk (plan 2, task 1): the pure helpers behind the chip, the note badges, the who-line,
// the live strip and what the desk does after Send. Every string is the plan's own.
import { describe, expect, it } from "vitest";
import { afterSend, agentName, canStop, chipShows, chipText, chipTone, liveLines, noteAgentBadge, whoLine, type NoteLite } from "../../web/src/agent.js";
import type { AgentStatus } from "../../web/src/types.js";

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
