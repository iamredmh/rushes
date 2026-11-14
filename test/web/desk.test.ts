import { describe, expect, it } from "vitest";
import { deskPlace, nextHint, type NextInput, rulerMarks, takeCount, takeGroups, deskView, viewForKey, viewForTab } from "../../web/src/desk.js";
import type { Lane, Note, Variant } from "../../web/src/types.js";

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

describe("nextHint", () => {
  const settled = { started: true, fresh: 0, inUse: true, stale: false };
  const base: NextInput = { plan: { exists: true, approved: true }, hasCut: true, unsent: 0, openNotes: 0, locked: true, sound: { voice: settled, music: settled, sfx: settled } };
  const sound = (stage: "voice" | "music" | "sfx", change: Partial<typeof settled>) => ({ ...base, sound: { ...base.sound, [stage]: { ...settled, ...change } } });

  it("has nothing to say when everything is settled", () => {
    expect(nextHint(base)).toEqual({ text: "nothing to do", go: null });
  });
  it("starts with the plan when there is no cut", () => {
    expect(nextHint({ ...base, hasCut: false, plan: { exists: true, approved: false } })).toEqual({ text: "approve the plan", go: "script" });
    expect(nextHint({ ...base, hasCut: false })).toEqual({ text: "ask for cut 1", go: null });
    expect(nextHint({ ...base, hasCut: false, plan: { exists: false, approved: false } })).toEqual({ text: "ask for cut 1", go: null });
  });
  it("does not send someone with a cut back to an unapproved plan", () => {
    expect(nextHint({ ...base, plan: { exists: true, approved: false } })).toEqual({ text: "nothing to do", go: null });
  });
  it("says to send what is waiting, counted", () => {
    expect(nextHint({ ...base, unsent: 1, openNotes: 1 })).toEqual({ text: "send 1 note", go: null });
    expect(nextHint({ ...base, unsent: 3, openNotes: 5 })).toEqual({ text: "send 3 notes", go: null });
  });
  it("says notes are open once they are sent", () => {
    expect(nextHint({ ...base, openNotes: 1 })).toEqual({ text: "1 note open", go: "picture" });
    expect(nextHint({ ...base, openNotes: 4, locked: false })).toEqual({ text: "4 notes open", go: "picture" });
  });
  it("says to lock picture when no note is open", () => {
    expect(nextHint({ ...base, locked: false })).toEqual({ text: "lock picture", go: "picture" });
  });
  it("takes the sounds one at a time: voice, then music, then effects", () => {
    expect(nextHint(sound("voice", { started: false, inUse: false }))).toEqual({ text: "ask for a voiceover", go: null });
    expect(nextHint(sound("music", { started: false, inUse: false }))).toEqual({ text: "ask for music", go: null });
    expect(nextHint(sound("sfx", { started: false, inUse: false }))).toEqual({ text: "ask for sound effects", go: null });
    expect(nextHint(sound("voice", { fresh: 2 }))).toEqual({ text: "choose a read", go: "voice" });
    expect(nextHint(sound("music", { fresh: 3 }))).toEqual({ text: "choose a bed", go: "music" });
    expect(nextHint(sound("sfx", { fresh: 1 }))).toEqual({ text: "choose an effects pass", go: "sfx" });
    expect(nextHint(sound("voice", { stale: true }))).toEqual({ text: "the read in use was made for an older cut", go: "voice" });
    expect(nextHint(sound("music", { stale: true }))).toEqual({ text: "the bed in use was made for an older cut", go: "music" });
    expect(nextHint(sound("sfx", { stale: true }))).toEqual({ text: "the effects pass in use was made for an older cut", go: "sfx" });
  });
  it("settles voice before it asks for music", () => {
    const i = { ...base, sound: { voice: { ...settled, fresh: 2 }, music: { started: false, fresh: 0, inUse: false, stale: false }, sfx: settled } };
    expect(nextHint(i)).toEqual({ text: "choose a read", go: "voice" });
  });
  it("leaves the sounds alone until picture is locked", () => {
    expect(nextHint({ ...sound("voice", { fresh: 2 }), locked: false })).toEqual({ text: "lock picture", go: "picture" });
  });
});

describe("rulerMarks", () => {
  const note = (id: string, t: number, tOut: number | null = null, status: "todo" | "done" = "todo"): Note => ({
    id, stage: "picture", video: "hero", version: "v1", on: null, scope: tOut === null ? "point" : "range", t, tOut, frame: null, text: "Tighter.",
    box: null, pin: null, grab: null, shot: null, marks: [], format: null, status, reply: "", fixT: null, fixVersion: null, batch: null,
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
  it("keeps a done note's status", () => {
    expect(rulerMarks([note("a", 1, null, "done")], 4)[0].status).toBe("done");
  });
  it("leaves out a note with no time, and places nothing on a cut of no length", () => {
    expect(rulerMarks([{ ...note("a", 1), t: null, scope: "whole" }], 4)).toEqual([]);
    expect(rulerMarks([note("a", 1)], 0)).toEqual([{ id: "a", left: 0, width: null, status: "todo" }]);
  });
});
