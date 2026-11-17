// Send to AI (plan 2, task 5): when the desk notifies. Only while the page is hidden, once for each new ask and once
// when the run turns to a question; never for an ask or a question already heard.
import { describe, expect, it } from "vitest";
import { NOTHING_HEARD, notices, outOfSight, type Heard } from "../../web/src/notify.js";
import type { AgentStatus, PendingAsk } from "../../web/src/types.js";

const status = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  on: true, agent: "claude", phase: "working", batches: ["b_1"], current: { note: null, doing: null }, asks: [], lines: [], error: null, session: null, asked: true,
  permissions: "project-edits", always: [], ...over,
});
const ask = (id: string): PendingAsk => ({ id, title: "Run ffprobe", kind: "execute", command: "ffprobe renders/a.mp4", always: "", at: "2026-11-17T10:00:00.000Z" });
const waiting = (...ids: string[]) => status({ phase: "waiting", asks: ids.map(ask) });

/** Feeds the statuses in order, hidden or not, and gives every notice made. */
function run(steps: [AgentStatus | null, boolean][]): { body: string; tag: string }[] {
  let heard: Heard = NOTHING_HEARD;
  const all: { body: string; tag: string }[] = [];
  for (const [s, hidden] of steps) {
    const r = notices(heard, s, hidden);
    heard = r.heard;
    all.push(...r.notes);
  }
  return all;
}

describe("notices", () => {
  it("a new ask while the page is hidden: <A> is waiting for you, once", () => {
    expect(run([[status(), true], [waiting("ask_1"), true], [waiting("ask_1"), true], [waiting("ask_1"), true]])).toEqual([
      { body: "Claude Code is waiting for you", tag: "ask_1" },
    ]);
  });

  it("nothing while the page is shown, and an ask seen there never notifies later", () => {
    expect(run([[waiting("ask_1"), false], [waiting("ask_1"), false]])).toEqual([]);
    expect(run([[waiting("ask_1"), false], [waiting("ask_1"), true]])).toEqual([]);
  });

  it("a second ask notifies on its own; two arriving together notify once", () => {
    expect(run([[waiting("ask_1"), true], [waiting("ask_1", "ask_2"), true]])).toEqual([
      { body: "Claude Code is waiting for you", tag: "ask_1" },
      { body: "Claude Code is waiting for you", tag: "ask_2" },
    ]);
    expect(run([[status(), true], [waiting("ask_1", "ask_2"), true]])).toEqual([{ body: "Claude Code is waiting for you", tag: "ask_1" }]);
  });

  it("an answered ask going away notifies nothing; the next one does", () => {
    expect(run([[waiting("ask_1"), true], [status(), true], [waiting("ask_2"), true]]).map((n) => n.tag)).toEqual(["ask_1", "ask_2"]);
  });

  it("the phase turning to question: <A> has a question, once", () => {
    const q = status({ phase: "question", agent: "codex" });
    expect(run([[status({ agent: "codex" }), true], [q, true], [q, true], [{ ...q, lines: [{ at: "x", text: "y", note: null }] }, true]])).toEqual([
      { body: "Codex has a question", tag: "question" },
    ]);
  });

  it("a question shown on the page doesn't notify later; a new one after another phase does", () => {
    const q = status({ phase: "question" });
    expect(run([[q, false], [q, true]])).toEqual([]);
    expect(run([[q, true], [status({ phase: "working" }), true], [q, true]]).map((n) => n.body)).toEqual(["Claude Code has a question", "Claude Code has a question"]);
  });

  it("no status (no Send to AI) notifies nothing and forgets nothing", () => {
    expect(run([[null, true]])).toEqual([]);
    expect(run([[waiting("ask_1"), true], [null, true], [waiting("ask_1"), true]])).toHaveLength(1);
  });
});

describe("outOfSight (I5)", () => {
  const doc = (hidden: boolean, focused: boolean) => ({ hidden, hasFocus: () => focused });

  it("a hidden page is out of sight", () => {
    expect(outOfSight(doc(true, false))).toBe(true);
    expect(outOfSight(doc(true, true))).toBe(true);
  });

  it("a page shown but without focus (behind another window, as Safari leaves it visible) is out of sight", () => {
    expect(outOfSight(doc(false, false))).toBe(true);
  });

  it("only a page shown and in focus is in sight", () => {
    expect(outOfSight(doc(false, true))).toBe(false);
  });

  it("a blurred page notifies a new ask", () => {
    const r = notices(NOTHING_HEARD, waiting("ask_1"), outOfSight(doc(false, false)));
    expect(r.notes).toEqual([{ body: "Claude Code is waiting for you", tag: "ask_1" }]);
  });
});
