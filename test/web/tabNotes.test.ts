// §35.3: the Timeline lists the film's notes from every tab, labelled with their tab; the sound tabs' "All tabs".
import { describe, expect, it } from "vitest";
import { scopeState } from "../../web/src/lib.js";
import { allTabNotes, onTakeInUse, otherTabLabel, tabLabel, timelineNotes } from "../../web/src/tabNotes.js";
import type { Note, Project, State } from "../../web/src/types.js";

let seq = 0;
const note = (over: Partial<Note>): Note =>
  ({
    id: `n${++seq}`, stage: "picture", video: "v_a", version: null, on: null, scope: "point", t: 1, tOut: null, frame: null, text: "x", box: null, pin: null,
    grab: null, shot: null, marks: [], format: null, status: "todo", reply: "", replies: [], fixT: null, fixVersion: null, batch: null,
    createdAt: "2026-11-20T09:00:00.000Z", by: "user", ...over,
  }) as Note;

const lanes = [
  { id: "eliza", stage: "voice", name: "Eliza", variants: [{ id: "r3", name: "Eliza, read 3" }, { id: "r2", name: "Eliza, read 2" }] },
  { id: "beds", stage: "music", name: "Beds", variants: [{ id: "b", name: "Bed B" }] },
  { id: "fx", stage: "sfx", name: "Effects", variants: [{ id: "p2", name: "Pass 2" }] },
] as unknown as Project["lanes"];

describe("the Timeline's list (§35.3)", () => {
  // Two films: Five views (v_b) and Meet your agents (v_a).
  const pic = note({ stage: "picture", video: "v_b", text: "pic" });
  const mix = note({ stage: "mix", video: "v_b", text: "mix" });
  const voice = note({ stage: "voice", video: "v_b", on: "eliza/r3", text: "voice in use" });
  const voiceOld = note({ stage: "voice", video: "v_b", on: "eliza/r2", text: "voice not in use" });
  const music = note({ stage: "music", video: "v_b", on: "beds/b", text: "music" });
  const sfx = note({ stage: "sfx", video: "v_b", on: "fx/p2:c1", text: "sfx cue" });
  const visual = note({ stage: "visuals", video: null, text: "visual" });
  const script = note({ stage: "script", video: "v_b", text: "script" });
  const otherFilm = [note({ stage: "picture", video: "v_a" }), note({ stage: "voice", video: "v_a", on: "eliza/r3" }), note({ stage: "music", video: "v_a", on: "beds/b" })];
  const all = [pic, mix, voice, voiceOld, music, sfx, visual, script, ...otherFilm];
  const state = {
    project: { videos: [{ id: "v_a" }, { id: "v_b" }], lanes },
    notes: { notes: all },
    films: { v_b: { script: null, brief: null, storyboard: null, build: null, tabs: [], log: null } },
  } as unknown as State;

  it("includes every stage's notes for the film and none from other films; Script stays on Plan", () => {
    const film = scopeState(state, "v_b").notes.notes;
    const own = [pic, mix, voice];
    const listed = timelineNotes(own, film);
    expect(listed.map((n) => n.text)).toEqual(["pic", "mix", "voice in use", "voice not in use", "music", "sfx cue", "visual"]);
    for (const n of otherFilm) expect(listed).not.toContain(n);
    expect(listed).not.toContain(script);
    // None twice.
    expect(new Set(listed.map((n) => n.id)).size).toBe(listed.length);
  });

  it("labels each note with its tab; a take not in use says so; Picture carries none and Mix keeps its own", () => {
    const inUse = (n: Note) => n.id === voice.id;
    const own = (n: Note) => (n.stage === "mix" ? "Whole mix" : n.id === voice.id ? "Voice · Eliza, read 3" : null);
    expect(tabLabel(pic, lanes, inUse, own)).toBeNull();
    expect(tabLabel(mix, lanes, inUse, own)).toBe("Whole mix");
    expect(tabLabel(voice, lanes, inUse, own)).toBe("Voice · Eliza, read 3");
    expect(tabLabel(voiceOld, lanes, inUse, own)).toBe("Voice · Eliza, read 2 (not in use)");
    expect(tabLabel(music, lanes, inUse, own)).toBe("Music · Bed B (not in use)");
    expect(tabLabel(sfx, lanes, inUse, own)).toBe("Effects · Pass 2 (not in use)");
    expect(tabLabel(visual, lanes, inUse, own)).toBe("Visuals · Shared");
    // An older note whose `on` names no take: the tab alone.
    expect(tabLabel(note({ stage: "voice", on: "vo" }), lanes, inUse, own)).toBe("Voice");
  });

  it("the sound tabs' All tabs: the tab's own, then every other tab's for the film, labelled from there", () => {
    const film = scopeState(state, "v_b").notes.notes;
    const own = film.filter((n) => n.stage === "voice");
    expect(allTabNotes(own, film).map((n) => n.text)).toEqual(["voice in use", "voice not in use", "pic", "mix", "music", "sfx cue", "visual"]);
    const use = { voice: { lane: "eliza", variant: "r3" }, music: { lane: "beds", variant: "b" } };
    expect(otherTabLabel(pic, lanes, use)).toBe("Picture");
    expect(otherTabLabel(mix, lanes, use)).toBe("Mix");
    expect(otherTabLabel(music, lanes, use)).toBe("Music · Bed B");
    expect(otherTabLabel(sfx, lanes, use)).toBe("Effects · Pass 2 (not in use)");
    expect(onTakeInUse(voice, use)).toBe(true);
    expect(onTakeInUse(voiceOld, use)).toBe(false);
    expect(onTakeInUse(pic, use)).toBe(false);
  });
});
