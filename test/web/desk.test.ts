import { describe, expect, it } from "vitest";
import { clampView, followView, fullView, isFull, panView, viewPct, viewTime, zoomView } from "../../web/src/desk.js";
import { defaultTake, deskPlace, NOTE_STATE_LABEL, noteState, pctOf, noteTarget, rulerMarks, takeCount, takeGroups, takeKey, takeSections, timecode, sendAgainOffer, undeliveredBatches, unfinishedBatches, unfinishedLines, unsentCount, unsentEdits, deskView, viewForKey, viewForTab } from "../../web/src/desk.js";
import type { Batch, Lane, Note, Variant } from "../../web/src/types.js";

describe("deskPlace", () => {
  it("puts the planning pages in Plan", () => {
    for (const v of ["brief", "script", "storyboard"] as const) expect(deskPlace(v)).toEqual({ workspace: "plan", tab: null });
  });
  it("puts picture and the mix on the Timeline tab of Review", () => {
    expect(deskPlace("picture")).toEqual({ workspace: "review", tab: "timeline" });
    expect(deskPlace("mix")).toEqual({ workspace: "review", tab: "timeline" });
  });
  it("gives each sound its own tab of Review", () => {
    expect(deskPlace("voice")).toEqual({ workspace: "review", tab: "voice" });
    expect(deskPlace("music")).toEqual({ workspace: "review", tab: "music" });
    expect(deskPlace("sfx")).toEqual({ workspace: "review", tab: "sfx" });
  });
  it("keeps Visuals and Assets as workspaces of their own", () => {
    expect(deskPlace("visuals")).toEqual({ workspace: "visuals", tab: null });
    expect(deskPlace("assets")).toEqual({ workspace: "assets", tab: null });
  });
});

describe("viewForKey", () => {
  it("keeps the number keys where they were", () => {
    expect(viewForKey("1", "storyboard")).toBe("storyboard");
    expect(viewForKey("1", "brief")).toBe("brief");
    expect(viewForKey("2", "script")).toBe("picture");
    expect(viewForKey("3", "script")).toBe("voice");
    expect(viewForKey("4", "script")).toBe("music");
    expect(viewForKey("5", "script")).toBe("sfx");
    expect(viewForKey("7", "script")).toBe("visuals");
    expect(viewForKey("8", "script")).toBe("assets");
  });
  it("sends 6, which was Mix, to the timeline", () => {
    expect(viewForKey("6", "script")).toBe("picture");
  });
  it("ignores every other key", () => {
    for (const k of ["0", "9", "a", "", "12"]) expect(viewForKey(k, "script")).toBeNull();
  });
});

describe("deskView", () => {
  it("opens the mix as the Timeline tab, which plays it now, and leaves every other view as it is", () => {
    expect(deskView("mix")).toBe("picture");
    for (const v of ["picture", "voice", "music", "sfx", "visuals", "assets", "brief", "script", "storyboard"] as const) expect(deskView(v)).toBe(v);
  });
});

describe("viewForTab", () => {
  it("opens the view each Review tab shows", () => {
    expect(viewForTab("timeline")).toBe("picture");
    expect(viewForTab("voice")).toBe("voice");
    expect(viewForTab("music")).toBe("music");
    expect(viewForTab("sfx")).toBe("sfx");
  });
});

const take = (id: string, extra: Partial<Variant> = {}): Variant => ({ id, name: id, file: `audio/${id}.wav`, meta: {}, cues: [], ...extra });
const lane = (id: string, name: string, stage: Lane["stage"], variants: Variant[]): Lane => ({ id, stage, name, variants });
const hero = { id: "hero", versions: [{ id: "v1" }, { id: "v2" }] } as never;

describe("takeGroups", () => {
  // Round 1: two reads, one put away. Round 2: one read, in use, made for v1 (the film is at v2). Round 3: two reads added after the pick.
  const lanes = [
    lane("round-1", "Round 1 · two voices", "voice", [
      take("george", { addedAt: "2026-11-10T09:00:00.000Z", madeFor: { hero: "v1" } }),
      take("eliza", { addedAt: "2026-11-10T09:00:00.000Z", madeFor: { hero: "v1" }, putAway: "2026-11-11T09:00:00.000Z" }),
    ]),
    lane("beds", "Music", "music", [take("pulse")]),
    lane("round-2", "Round 2 · slower", "voice", [take("george-slow", { addedAt: "2026-11-11T09:00:00.000Z", madeFor: { hero: "v1" } })]),
    lane("round-3", "Round 3 · retimed", "voice", [
      take("george-retimed", { addedAt: "2026-11-13T09:00:00.000Z", madeFor: { hero: "v2" } }),
      take("george-warm", { addedAt: "2026-11-13T09:00:00.000Z", madeFor: { hero: "v2" } }),
    ]),
  ];
  const use = { lane: "round-2", variant: "george-slow", at: "2026-11-12T09:00:00.000Z", seen: {} };
  const g = takeGroups(lanes, "voice", use, hero);

  it("lists the takes added since the pick as new, newest round first", () => {
    expect(g.fresh.map((t) => t.variant.id)).toEqual(["george-retimed", "george-warm"]);
    expect(g.fresh[0]).toMatchObject({ lane: "round-3", round: "Round 3 · retimed", madeFor: "v2", stale: false, inUse: false });
  });
  it("names the take in use, and says when it was made for an older cut", () => {
    expect(g.inUse).toMatchObject({ lane: "round-2", round: "Round 2 · slower", madeFor: "v1", stale: true, inUse: true });
    expect(g.inUse?.variant.id).toBe("george-slow");
  });
  it("groups everything else by round, newest first, leaving out a round with nothing left", () => {
    expect(g.earlier).toEqual([{ round: "Round 1 · two voices", takes: [expect.objectContaining({ lane: "round-1", stale: true })] }]);
    expect(g.earlier[0].takes[0].variant.id).toBe("george");
  });
  it("keeps what was put away apart", () => {
    expect(g.away.map((t) => t.variant.id)).toEqual(["eliza"]);
  });
  it("counts every take, and the new ones", () => {
    expect(takeCount(g)).toEqual({ all: 5, fresh: 2 });
  });
  it("only looks at the sound asked for", () => {
    const m = takeGroups(lanes, "music", undefined, hero);
    // No date on it (a take from before dates were kept): never new, so it waits under Earlier.
    expect(m.fresh).toEqual([]);
    expect(m.inUse).toBeNull();
    expect(m.earlier.map((r) => r.takes.map((t) => t.variant.id))).toEqual([["pulse"]]);
    expect(m.earlier[0].takes[0]).toMatchObject({ madeFor: null, stale: false });
  });
  it("with nothing in use, every dated take is new", () => {
    const n = takeGroups(lanes, "voice", undefined, hero);
    expect(n.inUse).toBeNull();
    expect(n.fresh.map((t) => t.variant.id)).toEqual(["george-retimed", "george-warm", "george-slow", "george"]);
    expect(n.earlier).toEqual([]);
  });
  it("works with no film", () => {
    expect(takeGroups(lanes, "voice", use, undefined).inUse).toMatchObject({ madeFor: null, stale: false });
  });
});

describe("takeGroups: takes added with no round", () => {
  // The stage's own lane (id "music"): two beds on 12 Nov, one on 14 Nov (just after midnight in London, still 13 Nov in
  // New York), and one from before takes were dated. A real round beside it keeps its name.
  const lanes = [
    lane("music", "Music", "music", [
      take("a", { addedAt: "2026-11-12T09:00:00.000Z" }),
      take("old"),
      take("b", { addedAt: "2026-11-12T15:00:00.000Z" }),
      take("c", { addedAt: "2026-11-14T00:30:00.000Z" }),
    ]),
    lane("round-2", "Round 2", "music", [take("r", { addedAt: "2026-11-13T09:00:00.000Z" })]),
  ];
  const pick = { lane: "music", variant: "a", at: "2026-11-12T16:00:00.000Z", seen: {} };

  it("groups them by the local day they arrived, newest day first, each headed by the day; undated ones under the lane's name", () => {
    const g = takeGroups(lanes, "music", undefined, hero, "Europe/London");
    expect(g.fresh.map((t) => [t.variant.id, t.round])).toEqual([["r", "Round 2"], ["c", "14 Nov"], ["a", "12 Nov"], ["b", "12 Nov"]]);
    expect(g.earlier).toEqual([{ round: "Music", takes: [expect.objectContaining({ variant: expect.objectContaining({ id: "old" }) })] }]);
    expect(takeSections(g).map((s) => s.heading)).toEqual(["New · Round 2", "New · 14 Nov", "New · 12 Nov", "Earlier · Music"]);
  });
  it("keeps two days with the same short date in different years apart", () => {
    const years = [lane("music", "Music", "music", [take("x", { addedAt: "2026-11-12T09:00:00.000Z" }), take("y", { addedAt: "2025-11-12T09:00:00.000Z" })])];
    const s = takeSections(takeGroups(years, "music", undefined, hero, "Europe/London"));
    expect(s.map((x) => [x.heading, x.takes.map((t) => t.variant.id)])).toEqual([["New · 12 Nov", ["x"]], ["New · 12 Nov", ["y"]]]);
  });
  it("uses the day where you are", () => {
    const g = takeGroups(lanes, "music", undefined, hero, "America/New_York");
    expect(g.fresh.find((t) => t.variant.id === "c")?.round).toBe("13 Nov");
  });
  it("splits Earlier by day too", () => {
    const g = takeGroups(lanes, "music", pick, hero, "Europe/London");
    expect(g.inUse).toMatchObject({ round: "12 Nov", variant: expect.objectContaining({ id: "a" }) });
    expect(g.earlier.map((r) => [r.round, r.takes.map((t) => t.variant.id)])).toEqual([["12 Nov", ["b"]], ["Music", ["old"]]]);
    expect(takeSections(g).map((s) => s.heading)).toEqual(["New · Round 2", "New · 14 Nov", "In use · 12 Nov", "Earlier · 12 Nov", "Earlier · Music"]);
  });
});

describe("takeSections", () => {
  const lanes = [
    lane("round-1", "Round 1", "voice", [take("a", { addedAt: "2026-11-10T09:00:00.000Z" }), take("b", { addedAt: "2026-11-10T09:00:00.000Z" })]),
    lane("round-2", "Round 2", "voice", [take("c", { addedAt: "2026-11-11T09:00:00.000Z" }), take("d", { addedAt: "2026-11-11T09:00:00.000Z" })]),
    lane("round-3", "Round 3", "voice", [take("e", { addedAt: "2026-11-13T09:00:00.000Z" })]),
    lane("round-4", "Round 4", "voice", [take("f", { addedAt: "2026-11-14T09:00:00.000Z" }), take("g", { addedAt: "2026-11-14T09:00:00.000Z", putAway: "2026-11-14T10:00:00.000Z" })]),
  ];
  const use = { lane: "round-2", variant: "c", at: "2026-11-12T09:00:00.000Z", seen: {} };
  const g = takeGroups(lanes, "voice", use, hero);
  const ids = (s: { takes: { variant: { id: string } }[] }) => s.takes.map((t) => t.variant.id);

  it("heads New per round newest first, then In use, then Earlier per round, and leaves Put away out", () => {
    const s = takeSections(g);
    expect(s.map((x) => x.heading)).toEqual(["New · Round 4", "New · Round 3", "In use · Round 2", "Earlier · Round 2", "Earlier · Round 1"]);
    expect(s.map((x) => x.kind)).toEqual(["fresh", "fresh", "inUse", "earlier", "earlier"]);
    expect(s.map(ids)).toEqual([["f"], ["e"], ["c"], ["d"], ["a", "b"]]);
  });
  it("shuffles inside a heading only (Blind)", () => {
    const s = takeSections(g, (t) => [...t].reverse());
    expect(s.map(ids)).toEqual([["f"], ["e"], ["c"], ["d"], ["b", "a"]]);
  });
  it("has nothing to head for a sound with no takes", () => {
    expect(takeSections(takeGroups([], "music", undefined, hero))).toEqual([]);
  });
});

describe("defaultTake", () => {
  const lanes = [
    lane("round-1", "Round 1", "music", [take("old")]),
    lane("round-2", "Round 2", "music", [take("x", { addedAt: "2026-11-11T09:00:00.000Z" }), take("y", { addedAt: "2026-11-11T09:00:00.000Z" })]),
  ];
  it("is the take in use when there is one", () => {
    const g = takeGroups(lanes, "music", { lane: "round-1", variant: "old", at: "2026-11-12T09:00:00.000Z", seen: {} }, hero);
    expect(defaultTake(g)?.variant.id).toBe("old");
    expect(takeKey(defaultTake(g)!)).toBe("round-1/old");
  });
  it("is the first take waiting when nothing is in use, else the newest earlier one, else none", () => {
    expect(defaultTake(takeGroups(lanes, "music", undefined, hero))?.variant.id).toBe("x");
    expect(defaultTake(takeGroups([lanes[0]], "music", undefined, hero))?.variant.id).toBe("old");
    expect(defaultTake(takeGroups([], "music", undefined, hero))).toBeNull();
  });
});

describe("rulerMarks", () => {
  const note = (id: string, t: number, tOut: number | null = null, status: "todo" | "done" = "todo"): Note => ({
    id, stage: "picture", video: "hero", version: "v1", on: null, scope: tOut === null ? "point" : "range", t, tOut, frame: null, text: "Tighter.",
    box: null, pin: null, grab: null, shot: null, marks: [], format: null, status, reply: "", replies: [], fixT: null, fixVersion: null, batch: null,
    createdAt: "2026-11-14T10:00:00.000Z", by: "user",
  });
  it("places a point note as a percentage of the length, with no width", () => {
    expect(rulerMarks([note("a", 2)], 4)).toEqual([{ id: "a", left: 50, width: null, status: "todo" }]);
  });
  it("gives a range note its width", () => {
    expect(rulerMarks([note("a", 1, 2)], 4)).toEqual([{ id: "a", left: 25, width: 25, status: "todo" }]);
  });
  it("clamps a note past the end to 100, and a range to what is left", () => {
    expect(rulerMarks([note("a", 6)], 4)).toEqual([{ id: "a", left: 100, width: null, status: "todo" }]);
    expect(rulerMarks([note("b", 3, 6)], 4)).toEqual([{ id: "b", left: 75, width: 25, status: "todo" }]);
  });
  // Spec 5.5, ruled in the final review (I4): amber to do, blue while the agent has it, green done.
  it("marks a to-do note that went in a batch as sent, and a done one as done whatever its batch", () => {
    const sent = { ...note("a", 2), batch: "b_1" };
    const done = { ...note("b", 1, 2, "done"), batch: "b_1" };
    expect(rulerMarks([note("c", 3), sent, done], 4).map((m) => [m.id, m.status])).toEqual([["c", "todo"], ["a", "sent"], ["b", "done"]]);
  });
  it("says what each state is, for a marker's name and a note's dot", () => {
    expect(noteState({ status: "todo", batch: null })).toBe("todo");
    expect(noteState({ status: "todo", batch: "b_1" })).toBe("sent");
    expect(noteState({ status: "done", batch: "b_1" })).toBe("done");
    expect(NOTE_STATE_LABEL.sent).toBe("With your agent");
  });
  it("keeps a done note's status", () => {
    expect(rulerMarks([note("a", 1, null, "done")], 4)[0].status).toBe("done");
  });
  it("leaves out a note with no time, and places nothing on a cut of no length", () => {
    expect(rulerMarks([{ ...note("a", 1), t: null, scope: "whole" }], 4)).toEqual([]);
    expect(rulerMarks([note("a", 1)], 0)).toEqual([{ id: "a", left: 0, width: null, status: "todo" }]);
  });
});

describe("noteTarget", () => {
  const scan = { n: 3, name: "The scan" };
  it("aims at this frame: picture, a point at the playhead, named by its timecode and shot", () => {
    expect(noteTarget({ kind: "frame", t: 11 }, scan, 25)).toEqual({ stage: "picture", on: null, scope: "point", t: 11, tOut: null, label: "00:00:11:00 · 03 The scan", when: "00:00:11:00", name: "03 The scan" });
    expect(noteTarget({ kind: "frame", t: 61.48 }, null, 25)).toMatchObject({ label: "00:01:01:12", when: "00:01:01:12", name: "" });
  });
  it("aims at a range marked: picture, from In to Out", () => {
    expect(noteTarget({ kind: "range", t: 11, tOut: 12.5 }, scan, 24)).toEqual({ stage: "picture", on: null, scope: "range", t: 11, tOut: 12.5, label: "00:00:11:00–00:00:12:12 · 03 The scan", when: "00:00:11:00–00:00:12:12", name: "03 The scan" });
  });
  it("aims at a shot: picture, a point where it starts, named by the shot", () => {
    expect(noteTarget({ kind: "shot", n: 4, name: "The door", t: 14 }, scan, 30)).toEqual({ stage: "picture", on: null, scope: "point", t: 14, tOut: null, label: "00:00:14:00 · 04 The door", when: "00:00:14:00", name: "04 The door" });
  });
  it("aims at a whole take: its sound's stage and on, no time", () => {
    expect(noteTarget({ kind: "take", stage: "voice", on: "r2/george", name: "George · retimed", t: null }, scan, 30)).toEqual({ stage: "voice", on: "r2/george", scope: "whole", t: null, tOut: null, label: "Voice · George · retimed", when: null, name: "Voice · George · retimed" });
  });
  it("aims at a point on a take when its block was clicked, and a range on it when one is marked", () => {
    expect(noteTarget({ kind: "take", stage: "music", on: "b/warm", name: "Warm keys", t: 2 }, null, 30)).toEqual({ stage: "music", on: "b/warm", scope: "point", t: 2, tOut: null, label: "00:00:02:00 · Music · Warm keys", when: "00:00:02:00", name: "Music · Warm keys" });
    expect(noteTarget({ kind: "take", stage: "sfx", on: "p/a", name: "Pass A", t: 1, tOut: 2 }, null, 30)).toEqual({ stage: "sfx", on: "p/a", scope: "range", t: 1, tOut: 2, label: "00:00:01:00–00:00:02:00 · Effects · Pass A", when: "00:00:01:00–00:00:02:00", name: "Effects · Pass A" });
  });
  it("aims at the whole mix: stage mix, on null, as a whole-mix note is stored", () => {
    expect(noteTarget({ kind: "mix" }, scan, 30)).toEqual({ stage: "mix", on: null, scope: "whole", t: null, tOut: null, label: "The whole mix", when: null, name: "The whole mix" });
    expect(noteTarget({ kind: "mix", t: 3 }, scan, 30)).toEqual({ stage: "mix", on: null, scope: "point", t: 3, tOut: null, label: "00:00:03:00 · The whole mix", when: "00:00:03:00", name: "The whole mix" });
    expect(noteTarget({ kind: "mix", t: 3, tOut: 4 }, scan, 30).scope).toBe("range");
  });
  it("aims at a script line: stage script, on its id, the whole line", () => {
    expect(noteTarget({ kind: "line", id: "s2", label: "S2 · The scan finds it" }, scan, 30)).toEqual({ stage: "script", on: "s2", scope: "whole", t: null, tOut: null, label: "S2 · The scan finds it", when: null, name: "S2 · The scan finds it" });
  });
});

describe("pctOf", () => {
  it("is a time as a percentage of the length, clamped to the timeline, and 0 with no length", () => {
    expect(pctOf(1, 4)).toBe(25);
    expect(pctOf(-1, 4)).toBe(0);
    expect(pctOf(9, 4)).toBe(100);
    expect(pctOf(1, 0)).toBe(0);
  });
});

describe("timecode", () => {
  it("reads hours, minutes, seconds and frames, snapping to the nearest frame", () => {
    expect(timecode(0, 30)).toBe("00:00:00:00");
    expect(timecode(3725.5, 24)).toBe("01:02:05:12");
    expect(timecode(1.999, 30)).toBe("00:00:02:00");
  });
});

describe("unsentCount", () => {
  const n = (over: Partial<Note>): Note => ({
    id: "n", stage: "picture", video: "hero", version: "v1", on: null, scope: "point", t: 1, tOut: null, frame: null, text: "x",
    box: null, pin: null, grab: null, shot: null, marks: [], format: null, status: "todo", reply: "", replies: [], fixT: null, fixVersion: null, batch: null,
    createdAt: "2026-11-14T10:00:00.000Z", by: "user", ...over,
  });
  const base = { inPlay: new Set(["hero"]), scriptTodo: 0, briefChanged: 0, storyboardChanged: 0 };
  it("counts to-do notes not yet in a batch, on films in play or on no film", () => {
    const notes = [n({ id: "a" }), n({ id: "b", video: null }), n({ id: "c", batch: "b_1" }), n({ id: "d", status: "done" }), n({ id: "e", video: "cutdown" })];
    expect(unsentCount({ ...base, notes })).toBe(2);
  });
  it("adds changed script rows (the script tab's to-do less its own notes) and the brief's and storyboard's changes", () => {
    const notes = [n({ id: "a", stage: "script", on: "s1", scope: "whole", t: null })];
    expect(unsentCount({ ...base, notes, scriptTodo: 3, briefChanged: 1, storyboardChanged: 2 })).toBe(1 + 2 + 1 + 2);
  });
  it("never counts fewer than no script rows", () => {
    const notes = [n({ id: "a", stage: "script", scope: "whole", t: null }), n({ id: "b", stage: "script", scope: "whole", t: null })];
    expect(unsentCount({ ...base, notes, scriptTodo: 1 })).toBe(2);
  });
  it("is nothing when nothing waits", () => {
    expect(unsentCount({ ...base, notes: [] })).toBe(0);
  });
});

describe("undeliveredBatches (I3, Send again)", () => {
  const n = (over: Partial<Note>): Note => ({
    id: "n", stage: "picture", video: "hero", version: "v1", on: null, scope: "point", t: 1, tOut: null, frame: null, text: "x",
    box: null, pin: null, grab: null, shot: null, marks: [], format: null, status: "todo", reply: "", replies: [], fixT: null, fixVersion: null, batch: null,
    createdAt: "2026-11-14T10:00:00.000Z", by: "user", ...over,
  });
  const b = (id: string, undelivered: Batch["undelivered"] = null): Batch => ({ id, stage: "picture", noteIds: [], sectionIds: [], sentAt: "2026-11-19T14:43:57.217Z", prompt: `Work through ${id}`, undelivered });
  const refused = { at: "2026-11-19T14:43:57.300Z", why: "Claude Code is not signed in" };
  it("lists a refused batch with the notes still waiting in it, which Send's count leaves out", () => {
    const notes = [n({ id: "a", batch: "b_11" }), n({ id: "b", batch: "b_11" }), n({ id: "c", batch: "b_11", status: "done" })];
    const out = undeliveredBatches([b("b_10"), b("b_11", refused)], notes);
    expect(out.map((x) => [x.batch.id, x.notes])).toEqual([["b_11", 2]]);
    expect(unsentCount({ notes, inPlay: new Set(["hero"]), scriptTodo: 0, briefChanged: 0, storyboardChanged: 0 })).toBe(0);
  });
  it("leaves out a refused batch whose notes are all done or back in to do, and batches from before the mark existed", () => {
    const notes = [n({ id: "a", batch: "b_11", status: "done" }), n({ id: "b", batch: null })];
    const old = { id: "b_9", stage: null, noteIds: [], sectionIds: [], sentAt: "2026-11-19T11:35:33.200Z", prompt: "p" } as Batch;
    expect(undeliveredBatches([old, b("b_11", refused)], notes)).toEqual([]);
  });
});

describe("unfinished batches and Send again's row (§35.7)", () => {
  const n = (over: Partial<Note>): Note => ({
    id: "n", stage: "picture", video: "eu-only", version: "v1", on: null, scope: "point", t: 1, tOut: null, frame: null, text: "x",
    box: null, pin: null, grab: null, shot: null, marks: [], format: null, status: "todo", reply: "", replies: [], fixT: null, fixVersion: null, batch: null,
    createdAt: "2026-11-22T18:48:00.000Z", by: "user", ...over,
  });
  const b = (id: string, sentAt: string, over: Partial<Batch> = {}): Batch => ({ id, stage: "picture", noteIds: [], sectionIds: [], sentAt, prompt: `Work through ${id}`, ...over });
  const ended = (said: string | null) => ({ unfinished: { at: "2026-11-22T19:27:15.254Z", said } });

  it("lists a batch whose turn ended with notes unanswered, by its sent notes, and they stay out of Send's count", () => {
    const notes = [n({ id: "n_3e87dd", batch: "b_6" }), n({ id: "n_f719c1", batch: "b_6" }), n({ id: "n_b88d5d", batch: "b_5", status: "done" })];
    const batches = [b("b_5", "2026-11-22T18:48:41.105Z", ended(null)), b("b_6", "2026-11-22T18:49:25.761Z", ended("Not done yet, and neither note is replied to."))];
    // b_5's only note left is done: nothing of it waits.
    expect(unfinishedBatches(batches, notes).map((x) => [x.batch.id, x.notes])).toEqual([["b_6", 2]]);
    expect(unsentCount({ notes, inPlay: new Set(["eu-only"]), scriptTodo: 0, briefChanged: 0, storyboardChanged: 0 })).toBe(0);
  });

  it("gives each unfinished batch's notes their status line: the agent's last words, or that the run ended first", () => {
    const batches = [b("b_5", "2026-11-22T18:48:41.105Z", ended(null)), b("b_6", "2026-11-22T18:49:25.761Z", ended("Not done yet.")), b("b_7", "2026-11-22T19:19:25.658Z")];
    expect(unfinishedLines(batches)).toEqual({ b_5: "The run ended before this note was answered", b_6: "Not finished: Not done yet." });
  });

  it("Send again's row: not answered in the sent colour, didn't reach the agent in the to-do colour, both counted together", () => {
    const notes = [n({ id: "a", batch: "b_6" }), n({ id: "b", batch: "b_6" }), n({ id: "c", batch: "b_8" })];
    const unfinished = b("b_6", "2026-11-22T18:49:25.761Z", ended("Not done yet, and neither note is replied to."));
    const refused = b("b_8", "2026-11-22T19:30:00.000Z", { undelivered: { at: "2026-11-22T19:30:00.100Z", why: "Claude Code is not signed in" } });
    expect(sendAgainOffer([unfinished], notes)).toMatchObject({ count: 2, tone: "sent", text: "2 notes weren't answered: Not done yet, and neither note is replied to." });
    expect(sendAgainOffer([b("b_6", unfinished.sentAt, ended(null))], notes.slice(0, 1))).toMatchObject({ count: 1, text: "1 note wasn't answered before the run ended" });
    expect(sendAgainOffer([refused], notes)).toMatchObject({ count: 1, tone: "todo", text: "1 note didn't reach the agent: Claude Code is not signed in" });
    const both = sendAgainOffer([refused, unfinished], notes)!;
    expect(both).toMatchObject({ count: 3, tone: "todo", text: "3 notes are waiting to go to the agent again" });
    // Oldest first, as Send again hands them over.
    expect(both.batches.map((x) => x.id)).toEqual(["b_6", "b_8"]);
    expect(sendAgainOffer([b("b_9", "2026-11-22T19:00:00.000Z")], notes)).toBeNull();
  });
});

describe("unsentEdits", () => {
  const n = (over: Partial<Note>): Note => ({
    id: "n", stage: "script", video: null, version: null, on: "s1", scope: "whole", t: null, tOut: null, frame: null, text: "x",
    box: null, pin: null, grab: null, shot: null, marks: [], format: null, status: "todo", reply: "", replies: [], fixT: null, fixVersion: null, batch: null,
    createdAt: "2026-11-14T10:00:00.000Z", by: "user", ...over,
  });
  const base = { notes: [] as Note[], inPlay: new Set<string>(["hero"]), scriptTodo: 0, briefChanged: 0, storyboardChanged: 0 };
  it("counts what waits that is not a note: edited script lines, the brief's and the storyboard's changes", () => {
    expect(unsentEdits({ ...base, notes: [n({ id: "a" })], scriptTodo: 3, briefChanged: 1, storyboardChanged: 2 })).toBe(2 + 1 + 2);
  });
  it("is nothing when only notes wait", () => {
    expect(unsentEdits({ ...base, notes: [n({ id: "a" }), n({ id: "b" })], scriptTodo: 2 })).toBe(0);
  });
});

describe("the timeline's zoom (Red, 16 Nov)", () => {
  it("places a time across the stretch on screen, and a point back on the cut", () => {
    expect(viewPct(15, { start: 10, end: 20 })).toBe(50);
    expect(viewPct(0, { start: 10, end: 20 })).toBe(-10);
    expect(viewPct(40, { start: 10, end: 20 })).toBe(110);
    expect(viewTime(0.25, { start: 10, end: 30 })).toBe(15);
    expect(viewTime(2, { start: 10, end: 30 })).toBe(30);
  });

  it("zooms about the anchor, which keeps its place on screen", () => {
    const v = zoomView({ start: 0, end: 100 }, 100, 0.5, 25);
    expect(v).toEqual({ start: 12.5, end: 62.5 });
    expect(viewPct(25, v)).toBe(25);
  });

  it("never zooms in past two seconds, nor out past the cut", () => {
    expect(zoomView({ start: 10, end: 14 }, 100, 0.1, 12)).toEqual({ start: 11, end: 13 });
    expect(zoomView({ start: 40, end: 60 }, 100, 50)).toEqual(fullView(100));
    expect(isFull(zoomView({ start: 40, end: 60 }, 100, 50), 100)).toBe(true);
  });

  it("pans inside the cut, keeping the view's length", () => {
    expect(panView({ start: 80, end: 90 }, 100, 30)).toEqual({ start: 90, end: 100 });
    expect(panView({ start: 5, end: 15 }, 100, -30)).toEqual({ start: 0, end: 10 });
    expect(clampView({ start: -5, end: 1 }, 100)).toEqual({ start: 0, end: 6 });
  });

  it("pages to follow the playhead, as Premiere does", () => {
    const v = { start: 0, end: 10 };
    expect(followView(v, 100, 5)).toBe(v);
    expect(followView(v, 100, 10.5)).toEqual({ start: 10.5, end: 20.5 });
    expect(followView(v, 100, 96)).toEqual({ start: 90, end: 100 });
    expect(followView({ start: 50, end: 60 }, 100, 20)).toEqual({ start: 19, end: 29 });
  });
});
