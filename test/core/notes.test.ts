import { describe, expect, it } from "vitest";
import { addNote, applyReply, applyUserEdit, checkNoteFormat, filterNotes, onLabel, type OnContext } from "../../src/core/notes.js";
import { markLabel, NoteSchema, type Note, type NotesFile, type Project } from "../../src/core/schema.js";
import { addFormat, addVersion } from "../../src/core/project.js";
import type { RushesError } from "../../src/core/errors.js";

const empty = (): NotesFile => ({ schema: 1, rev: 0, notes: [] });

describe("addNote", () => {
  it("adds a point note with defaults", () => {
    const f = empty();
    const n = addNote(f, { stage: "picture", video: "hero", version: "v3", scope: "point", t: 12.4, frame: 744, text: " Logo lands early. " }, new Date("2026-10-02T12:00:00Z"));
    expect(n).toMatchObject({ stage: "picture", scope: "point", t: 12.4, text: "Logo lands early.", status: "todo", reply: "", batch: null, by: "user", createdAt: "2026-10-02T12:00:00.000Z" });
    expect(n.id).toMatch(/^n_[0-9a-f]{6}$/);
    expect(f.notes).toHaveLength(1);
  });

  it("validates scope against times", () => {
    const f = empty();
    expect(() => addNote(f, { stage: "picture", scope: "point", text: "x" })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "picture", scope: "range", t: 10, tOut: 10, text: "x" })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "music", scope: "whole", t: 3, text: "x" })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "picture", scope: "point", t: -1, text: "x" })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "picture", scope: "point", t: 1, text: "   " })).toThrow(/invalid/i);
    expect(addNote(f, { stage: "music", scope: "whole", on: "a", text: "Make it 110 BPM" }).t).toBeNull();
    expect(f.notes).toHaveLength(1);
  });
});

describe("field ownership", () => {
  it("a reply changes only reply, status, fixT and fixVersion", () => {
    const f = empty();
    const n = addNote(f, { stage: "picture", scope: "point", t: 4.1, text: "Title too short" });
    applyReply(f, { id: n.id, reply: "Held 1.2 s longer.", status: "done", fixT: 4.6, fixVersion: "v4" });
    expect(f.notes[0]).toMatchObject({ text: "Title too short", t: 4.1, reply: "Held 1.2 s longer.", status: "done", fixT: 4.6, fixVersion: "v4" });
  });

  it("a user edit changes only user fields and is re-validated", () => {
    const f = empty();
    const n = addNote(f, { stage: "picture", scope: "point", t: 4.1, text: "First" });
    applyReply(f, { id: n.id, reply: "On it" });
    applyUserEdit(f, { id: n.id, text: "Second", scope: "range", tOut: 6 });
    expect(f.notes[0]).toMatchObject({ text: "Second", scope: "range", t: 4.1, tOut: 6, reply: "On it" });
    expect(() => applyUserEdit(f, { id: n.id, tOut: 2 })).toThrow(/invalid/i);
    expect(f.notes[0].tOut).toBe(6);
  });

  it("unknown ids throw not found", () => {
    expect(() => applyReply(empty(), { id: "n_nope", reply: "x" })).toThrow(/not found/);
  });
});

describe("reopening", () => {
  it("a note reopened by the user or the agent leaves its old batch so it can be sent again", () => {
    const f = empty();
    const a = addNote(f, { stage: "picture", scope: "point", t: 1, text: "a" });
    const b = addNote(f, { stage: "picture", scope: "point", t: 2, text: "b" });
    for (const n of [a, b]) Object.assign(n, { batch: "b_1", status: "done" });
    expect(applyUserEdit(f, { id: a.id, status: "todo" }).batch).toBeNull();
    expect(applyReply(f, { id: b.id, status: "todo", reply: "Not fixed yet" }).batch).toBeNull();
  });
  it("other edits keep the batch", () => {
    const f = empty();
    const a = addNote(f, { stage: "picture", scope: "point", t: 1, text: "a" });
    a.batch = "b_1";
    expect(applyUserEdit(f, { id: a.id, text: "a2" }).batch).toBe("b_1");
    expect(applyReply(f, { id: a.id, reply: "On it", status: "todo" }).batch).toBe("b_1");
    expect(applyReply(f, { id: a.id, status: "done" }).batch).toBe("b_1");
  });
});

describe("NoteSchema", () => {
  it("a Plan 2 note with no shot validates, with shot: null", () => {
    const plan2Fixture = {
      id: "n_abc123",
      stage: "picture",
      scope: "point",
      t: 4.1,
      text: "Title too short",
      createdAt: "2026-10-02T12:00:00.000Z",
    };
    const parsed = NoteSchema.parse(plan2Fixture);
    expect(parsed.shot).toBeNull();
  });

  it("a note with no marks (Plan 1-2) still loads, with marks: []", () => {
    const oldFixture = {
      id: "n_abc123",
      stage: "music",
      scope: "whole",
      text: "Tempo feels slow",
      createdAt: "2026-10-02T12:00:00.000Z",
    };
    expect(NoteSchema.parse(oldFixture).marks).toEqual([]);
  });
});

describe("marks (§14.5)", () => {
  const base = { stage: "music" as const, scope: "whole" as const, text: "x" };

  it("accepts rise and fall with no db, and louder/quieter with one", () => {
    const f = empty();
    expect(addNote(f, { ...base, marks: [{ kind: "rise" }] }).marks).toEqual([{ kind: "rise" }]);
    expect(addNote(f, { ...base, marks: [{ kind: "fall" }] }).marks).toEqual([{ kind: "fall" }]);
    expect(addNote(f, { ...base, marks: [{ kind: "louder", db: 3 }] }).marks).toEqual([{ kind: "louder", db: 3 }]);
    expect(addNote(f, { ...base, marks: [{ kind: "quieter", db: 6 }] }).marks).toEqual([{ kind: "quieter", db: 6 }]);
  });

  it("rejects louder/quieter with no db", () => {
    const f = empty();
    expect(() => addNote(f, { ...base, marks: [{ kind: "louder" }] })).toThrow(/invalid/i);
    expect(() => addNote(f, { ...base, marks: [{ kind: "quieter" }] })).toThrow(/invalid/i);
  });

  it("rejects rise/fall with a db amount", () => {
    const f = empty();
    expect(() => addNote(f, { ...base, marks: [{ kind: "rise", db: 3 }] })).toThrow(/invalid/i);
    expect(() => addNote(f, { ...base, marks: [{ kind: "fall", db: 3 }] })).toThrow(/invalid/i);
  });

  it("rejects duplicate kinds", () => {
    const f = empty();
    expect(() => addNote(f, { ...base, marks: [{ kind: "rise" }, { kind: "rise" }] })).toThrow(/invalid/i);
    expect(() => addNote(f, { ...base, marks: [{ kind: "louder", db: 3 }, { kind: "louder", db: 6 }] })).toThrow(/invalid/i);
  });

  it("allows up to four distinct marks", () => {
    const f = empty();
    const n = addNote(f, { ...base, marks: [{ kind: "rise" }, { kind: "fall" }, { kind: "louder", db: 3 }, { kind: "quieter", db: 3 }] });
    expect(n.marks).toHaveLength(4);
  });

  it("marks only apply on voice, music, sfx and mix", () => {
    const f = empty();
    for (const stage of ["voice", "music", "sfx", "mix"] as const) {
      expect(addNote(f, { stage, scope: "whole", text: "x", marks: [{ kind: "rise" }] }).marks).toEqual([{ kind: "rise" }]);
    }
    expect(() => addNote(f, { stage: "picture", scope: "point", t: 1, text: "x", marks: [{ kind: "rise" }] })).toThrow(/invalid/i);
    expect(() => addNote(f, { stage: "script", scope: "whole", text: "x", marks: [{ kind: "rise" }] })).toThrow(/invalid/i);
  });

  it("marks are user-owned: applyUserEdit can set them, applyReply can't touch them", () => {
    const f = empty();
    const n = addNote(f, { stage: "music", scope: "whole", text: "Tempo" });
    applyUserEdit(f, { id: n.id, marks: [{ kind: "fall" }] });
    expect(f.notes[0].marks).toEqual([{ kind: "fall" }]);
    applyReply(f, { id: n.id, reply: "Done", status: "done" });
    expect(f.notes[0].marks).toEqual([{ kind: "fall" }]);
  });
});

describe("markLabel", () => {
  it("labels rise and fall with no amount, louder/quieter with their dB", () => {
    expect(markLabel({ kind: "rise" })).toBe("Rise");
    expect(markLabel({ kind: "fall" })).toBe("Fall");
    expect(markLabel({ kind: "louder", db: 3 })).toBe("Louder 3 dB");
    expect(markLabel({ kind: "quieter", db: 3 })).toBe("Quieter 3 dB");
    expect(markLabel({ kind: "quieter", db: 9 })).toBe("Quieter 9 dB");
  });
});

describe("filterNotes", () => {
  it("filters by stage, status, batch and version", () => {
    const f = empty();
    addNote(f, { stage: "picture", version: "v3", scope: "point", t: 1, text: "a" });
    const b = addNote(f, { stage: "picture", version: "v2", scope: "point", t: 2, text: "b" });
    addNote(f, { stage: "music", scope: "whole", text: "c" });
    applyReply(f, { id: b.id, status: "done" });
    expect(filterNotes(f.notes, { stage: "picture" })).toHaveLength(2);
    expect(filterNotes(f.notes, { stage: "picture", status: "todo" }).map((n) => n.text)).toEqual(["a"]);
    expect(filterNotes(f.notes, { version: "v2" }).map((n) => n.text)).toEqual(["b"]);
    expect(filterNotes(f.notes)).toHaveLength(3);
  });
});

describe("onLabel (what an audio note is on, for export and the CLI)", () => {
  const take = (id: string) => ({ id, file: `${id}.wav`, duration: 2, forText: "x" });
  const ctx: OnContext = {
    project: {
      lanes: [
        { id: "music", stage: "music", name: "Music", variants: [{ id: "option-a", name: "Option A", file: "m.wav", meta: {}, cues: [] }] },
        { id: "sting", stage: "music", name: "Sting", variants: [{ id: "a", name: "A", file: "s.wav", meta: {}, cues: [] }] },
        { id: "sfx", stage: "sfx", name: "Sound effects", variants: [
          { id: "option-a", name: "Option A", file: "x.wav", meta: {}, cues: [{ id: "swipe", name: "Swipe", t: 1 }] },
        ] },
        { id: "alt", stage: "voice", name: "Alt reads", variants: [{ id: "vo", name: "VO", file: "v.wav", meta: {}, cues: [] }] },
      ],
    },
    script: { sections: [{ id: "s2", start: 0, end: 4, current: "x", proposed: null, direction: "", status: "draft", takes: [take("t1"), take("t2")] }] },
    picks: { lanes: { sfx: "option-a" } },
  };
  const label = (stage: Note["stage"], on: string | null) => onLabel({ stage, on }, ctx);

  it("names a lane-qualified variant or cue by its lane and name", () => {
    expect(label("music", "music/option-a")).toBe("Music · Option A");
    expect(label("music", "sting/a")).toBe("Sting · A");
    expect(label("sfx", "sfx/option-a")).toBe("Sound effects · Option A");
    expect(label("sfx", "sfx/option-a:swipe")).toBe("Sound effects · Option A · Cue · Swipe");
    expect(label("mix", "sfx/option-a")).toBe("Sound effects · Option A");
    expect(label("voice", "alt/vo")).toBe("Alt reads · VO");
  });
  it("names the read, takes and sections on Voiceover, and the whole mix and VO lane on Mix", () => {
    expect(label("voice", "vo")).toBe("Assembled read");
    expect(label("voice", null)).toBe("Assembled read");
    expect(label("voice", "s2:t2")).toBe("S2 · Take 2");
    expect(label("voice", "s2")).toBe("S2");
    expect(label("mix", null)).toBe("Whole mix");
    expect(label("mix", "vo")).toBe("Voiceover");
  });
  it("still names an older note's bare id", () => {
    expect(label("music", "a")).toBe("Sting · A");
    expect(label("sfx", "option-a:swipe")).toBe("Sound effects · Option A · Cue · Swipe");
    expect(label("sfx", "swipe")).toBe("Sound effects · Option A · Cue · Swipe");
    // On Mix, a bare id shared by two stages prefers the picked one, as the dashboard prefers one being heard.
    expect(label("mix", "option-a")).toBe("Sound effects · Option A");
  });
  it("names a round and its read by the round's name and the variant's name (§18.4)", () => {
    const roundCtx: OnContext = {
      project: {
        lanes: [
          { id: "round-1", stage: "voice", name: "Round 1", variants: [{ id: "gerald", name: "Gerald", file: "g.wav", meta: {}, cues: [] }] },
          { id: "round-2", stage: "voice", name: "Round 2 · Gerald", variants: [{ id: "sombre", name: "more sombre", file: "s.wav", meta: {}, cues: [] }] },
        ],
      },
      script: { sections: [{ id: "s2", start: 0, end: 4, current: "x", proposed: null, direction: "", status: "draft", takes: [take("t1")] }] },
    };
    expect(onLabel({ stage: "voice", on: "round-2/sombre" }, roundCtx)).toBe("Round 2 · Gerald · more sombre");
    // A legacy take-scoped note keeps its old label, unaffected by rounds existing elsewhere.
    expect(onLabel({ stage: "voice", on: "s2:t1" }, roundCtx)).toBe("S2 · Take 1");
  });

  it("says nothing for Picture, or for something that's gone", () => {
    expect(label("picture", null)).toBeNull();
    expect(label("music", "music/gone")).toBeNull();
    expect(label("sfx", "sfx/option-a:gone")).toBeNull();
    expect(label("voice", "s9")).toBeNull();
  });
});

describe("notes and formats (§21.2, §21.3)", () => {
  const project = (): Project => {
    const p: Project = { schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addFormat(p, { video: "hero", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
    addVersion(p, { video: "Solo", file: "renders/solo_v1.mp4", duration: 8, width: 1920, height: 1080 });
    return p;
  };
  const next = (over: Partial<Pick<Note, "stage" | "video" | "version" | "format" | "box">> = {}) =>
    ({ stage: "picture" as const, video: "hero", version: "v1", format: null, box: null, ...over });
  const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
  const code = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return (e as RushesError).code;
    }
  };

  it("a format must be one of the note's own cut's, and only Picture notes have one", () => {
    expect(code(() => checkNoteFormat({ next: next({ format: "9x16" }) }, project()))).toBeNull();
    expect(code(() => checkNoteFormat({ next: next({ format: "16x9" }) }, project()))).toBeNull();
    expect(() => checkNoteFormat({ next: next({ format: "4x5" }) }, project())).toThrow("v1 has no 4:5 format.");
    expect(code(() => checkNoteFormat({ next: next({ format: "9x16", stage: "music" }) }, project()))).toBe("format_not_picture");
  });

  it("a box needs a format on a cut with formats, and keeps the one it was drawn on (R7)", () => {
    expect(code(() => checkNoteFormat({ next: next({ box }) }, project()))).toBe("box_needs_format");
    expect(code(() => checkNoteFormat({ next: next({ box, format: "9x16" }) }, project()))).toBeNull();
    expect(code(() => checkNoteFormat({ next: next({ box, video: "solo" }) }, project()))).toBeNull();
    expect(code(() => checkNoteFormat({ next: next({ box, format: "16x9" }), prev: { box, format: "9x16" } }, project()))).toBe("box_fixes_format");
    // Review Focus 1: a note from before formats drew its box on the primary, so it narrows to the primary only.
    expect(code(() => checkNoteFormat({ next: next({ box, format: "16x9" }), prev: { box, format: null } }, project()))).toBeNull();
    expect(code(() => checkNoteFormat({ next: next({ box, format: "9x16" }), prev: { box, format: null } }, project()))).toBe("box_fixes_format");
    // A box drawn again in the same edit belongs to the format it's drawn on now.
    expect(code(() => checkNoteFormat({ next: next({ box, format: "16x9" }), prev: { box, format: "9x16" }, boxRedrawn: true }, project()))).toBeNull();
  });

  it("applyUserEdit carries format, and runs the check before changing anything", () => {
    const f = empty();
    const p = project();
    const check = (nx: Note, pv: Note) => checkNoteFormat({ next: nx, prev: pv }, p);
    const boxed = addNote(f, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "x", format: "9x16", box });
    expect(() => applyUserEdit(f, { id: boxed.id, format: null }, check)).toThrow(/box/);
    expect(f.notes[0].format).toBe("9x16");
    const plain = addNote(f, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "y", format: "9x16" });
    applyUserEdit(f, { id: plain.id, format: null }, check);
    expect(f.notes[1].format).toBeNull();
  });

  it("filterNotes takes a format: its notes and the all-format ones, or only its own (R14)", () => {
    const f = empty();
    addNote(f, { stage: "picture", scope: "point", t: 1, text: "all" });
    addNote(f, { stage: "picture", scope: "point", t: 2, text: "tall", format: "9x16" });
    addNote(f, { stage: "picture", scope: "point", t: 3, text: "wide", format: "16x9" });
    addNote(f, { stage: "music", scope: "whole", text: "bed" });
    expect(filterNotes(f.notes, { format: "9x16" }).map((n) => n.text)).toEqual(["all", "tall"]);
    expect(filterNotes(f.notes, { format: "9x16", onlyThisFormat: true }).map((n) => n.text)).toEqual(["tall"]);
  });

  it("a format that isn't an id is refused by the schema", () => {
    expect(() => addNote(empty(), { stage: "picture", scope: "point", t: 1, text: "x", format: "portrait" })).toThrow(/invalid/i);
  });
});
