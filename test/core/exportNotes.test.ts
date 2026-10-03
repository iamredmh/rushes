import { describe, expect, it } from "vitest";
import { exportFileName, notesMarkdown } from "../../src/core/exportNotes.js";
import { addNote, onLabel } from "../../src/core/notes.js";
import { voiceOnLabel, voiceRounds } from "../../web/src/lib.js";
import type { Lane } from "../../web/src/types.js";
import { addVersion } from "../../src/core/project.js";
import type { NotesFile, Project } from "../../src/core/schema.js";

const project = (): Project => ({ schema: 1, rev: 0, name: "Spring Launch", fps: 30, videos: [], lanes: [], files: [] });

describe("exportFileName", () => {
  it("slugs the project name and dates it YYYY-MM-DD", () => {
    expect(exportFileName("Spring Launch!", new Date("2026-10-03T14:05:00"))).toBe("spring-launch-notes-2026-10-03.md");
  });
  it("pads single-digit months and days", () => {
    expect(exportFileName("demo", new Date(2026, 0, 5))).toBe("demo-notes-2026-01-05.md");
  });
});

describe("notesMarkdown", () => {
  it("is a title, export date, then one section per stage with notes, in workflow order -- never script", () => {
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "mix", scope: "whole", text: "Loudness check" });
    addNote(notes, { stage: "music", scope: "whole", on: "deep-house", text: "Tempo feels slow" });
    const md = notesMarkdown(project(), notes.notes, new Date(2026, 9, 3, 14, 5));
    expect(md).toBe(
      [
        "# Spring Launch — notes",
        "Exported 2026-10-03 14:05",
        "",
        "## Music",
        "- **Whole** · to do — Tempo feels slow",
        "",
        "## Mix",
        "- **Whole** · Whole mix · to do — Loudness check",
        "",
      ].join("\n"),
    );
  });

  it("groups Picture notes under a heading per film and version, in the project's own order, sorted by time within a group (whole notes last)", () => {
    const p = project();
    addVersion(p, { video: "Hero 60s", file: "renders/hero_v1.mp4" });
    addVersion(p, { video: "Hero 60s", file: "renders/hero_v2.mp4" });
    addVersion(p, { video: "Teaser", file: "renders/teaser_v1.mp4" });
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "picture", video: "hero-60s", version: "v2", scope: "point", t: 12.4, text: "Logo hold is too short" });
    // Hero 60s · v1 gets three notes, added out of timecode order and with a whole-track note
    // in the middle, to prove sorting runs by t (whole last) rather than creation order.
    addNote(notes, { stage: "picture", video: "hero-60s", version: "v1", scope: "range", t: 31.05, tOut: 33.1, text: "Music swells too early" });
    addNote(notes, { stage: "picture", video: "hero-60s", version: "v1", scope: "whole", text: "Overall pacing feels slow" });
    addNote(notes, { stage: "picture", video: "hero-60s", version: "v1", scope: "point", t: 5, text: "Opening logo too dark" });
    addNote(notes, { stage: "picture", video: "teaser", version: "v1", scope: "whole", text: "Needs a stronger open" });

    const md = notesMarkdown(p, notes.notes, new Date(2026, 9, 3, 9, 0));
    expect(md).toBe(
      [
        "# Spring Launch — notes",
        "Exported 2026-10-03 09:00",
        "",
        "## Picture",
        "",
        "### Hero 60s · v1",
        "- **0:05.00** · to do — Opening logo too dark",
        "- **0:31.05–0:33.10** · to do — Music swells too early",
        "- **Whole** · to do — Overall pacing feels slow",
        "",
        "### Hero 60s · v2",
        "- **0:12.40** · to do — Logo hold is too short",
        "",
        "### Teaser · v1",
        "- **Whole** · to do — Needs a stronger open",
        "",
      ].join("\n"),
    );
  });

  it("includes shot, status, reply and screenshot path", () => {
    const p = project();
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4" });
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    const n = addNote(notes, {
      stage: "picture",
      video: "hero",
      version: "v1",
      scope: "point",
      t: 12.4,
      text: "Logo hold is too short",
      shot: { n: 2, name: "Logo reveal" },
      grab: "screenshots/hero_v1_00m12.40s_f372.png",
    });
    notes.notes[0].reply = "Held 1s longer";
    notes.notes[0].status = "done";
    void n;
    const md = notesMarkdown(p, notes.notes, new Date(2026, 9, 3, 9, 0));
    expect(md).toContain("- **0:12.40** · shot 02 · done — Logo hold is too short");
    expect(md).toContain("  - Reply: Held 1s longer");
    expect(md).toContain("  - Screenshot: screenshots/hero_v1_00m12.40s_f372.png");
  });

  it("shows marks after the timecode (§17.7)", () => {
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, {
      stage: "music",
      scope: "range",
      t: 12,
      tOut: 15,
      text: "Bring the bed down here",
      marks: [{ kind: "fall" }, { kind: "quieter", db: 3 }],
    });
    const md = notesMarkdown(project(), notes.notes, new Date(2026, 9, 3, 9, 0));
    expect(md).toContain("- **0:12.00–0:15.00** · Fall · Quieter 3 dB · to do — Bring the bed down here");
  });

  it("says what each audio note is on: lane and variant, cue, take, section or the whole mix (M4)", () => {
    const p: Project = {
      ...project(),
      lanes: [
        { id: "music", stage: "music", name: "Music", variants: [{ id: "warm-keys", name: "Warm keys", file: "m.wav", meta: {}, cues: [] }] },
        { id: "sfx", stage: "sfx", name: "Sound effects", variants: [{ id: "pass-a", name: "Pass A", file: "s.wav", meta: {}, cues: [{ id: "swipe", name: "Swipe", t: 1.5 }] }] },
      ],
    };
    const script = { sections: [{ id: "s2", start: 3, end: 7, current: "x", proposed: null, direction: "", status: "draft" as const, takes: [{ id: "t1", file: "t.wav", duration: 2, forText: "x" }] }] };
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "music", on: "music/warm-keys", scope: "range", t: 12, tOut: 15, text: "Bed", marks: [{ kind: "fall" }] });
    addNote(notes, { stage: "sfx", on: "sfx/pass-a:swipe", scope: "point", t: 1.5, text: "Cue" });
    addNote(notes, { stage: "voice", on: "s2:t1", scope: "point", t: 4, text: "Take" });
    addNote(notes, { stage: "voice", on: "s2", scope: "whole", text: "Section" });
    addNote(notes, { stage: "mix", on: "sfx/pass-a", scope: "whole", text: "Lane" });
    const md = notesMarkdown(p, notes.notes, new Date(2026, 9, 3, 9, 0), script);
    expect(md).toContain("- **0:12.00–0:15.00** · Music · Warm keys · Fall · to do — Bed");
    expect(md).toContain("- **0:01.50** · Sound effects · Pass A · Cue · Swipe · to do — Cue");
    expect(md).toContain("- **0:04.00** · S2 · Take 1 · to do — Take");
    expect(md).toContain("- **Whole** · S2 · to do — Section");
    expect(md).toContain("- **Whole** · Sound effects · Pass A · to do — Lane");
  });

  it("names a voice round's read by its round and name (§18.5)", () => {
    const p: Project = {
      ...project(),
      lanes: [{ id: "round-2", stage: "voice", name: "Round 2 · Gerald", variants: [{ id: "sombre", name: "more sombre", file: "s.wav", meta: {}, cues: [] }] }],
    };
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "voice", on: "round-2/sombre", scope: "whole", text: "Loved this one" });
    const md = notesMarkdown(p, notes.notes, new Date(2026, 9, 3, 9, 0));
    expect(md).toContain("- **Whole** · Round 2 · Gerald · more sombre · to do — Loved this one");
  });

  it("labels older voice notes as the dashboard lists them: no on, the read, a section, a take, a missing take (parity, M4)", () => {
    const p: Project = {
      ...project(),
      lanes: [{ id: "round-1", stage: "voice", name: "Round 1", variants: [{ id: "dry", name: "Dry", file: "d.wav", meta: {}, cues: [] }] }],
    };
    const take = (id: string) => ({ id, file: `${id}.wav`, duration: 2, forText: "x" });
    const sections = [
      { id: "s1", start: 0, end: 3, current: "x", proposed: null, direction: "", status: "draft" as const, takes: [take("t1")] },
      { id: "s2", start: 3, end: 7, current: "x", proposed: null, direction: "", status: "draft" as const, takes: [take("t1"), take("t2")] },
    ];
    const ons = [null, "vo", "s2", "s1:t1", "s2:t2", "s2:t9", "s9:t1", "s9", "nowhere"];
    const web = { rounds: voiceRounds(p.lanes as Lane[], {}), sections };
    for (const on of ons) {
      expect(voiceOnLabel(web, on), String(on)).toBe(onLabel({ stage: "voice", on }, { project: p, script: { sections } }));
    }
    expect(voiceOnLabel(web, null)).toBe("Assembled read");
    expect(voiceOnLabel(web, "s2:t2")).toBe("S2 · Take 2");
    expect(voiceOnLabel(web, "s2:t9")).toBeNull();
    // And the export says the same.
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "voice", on: null, scope: "whole", text: "No on" });
    addNote(notes, { stage: "voice", on: "s2:t9", scope: "point", t: 4, text: "Gone take" });
    const md = notesMarkdown(p, notes.notes, new Date(2026, 9, 3, 9, 0), { sections });
    expect(md).toContain("- **Whole** · Assembled read · to do — No on");
    expect(md).toContain("- **0:04.00** · to do — Gone take");
  });

  it("escapes nothing -- HTML, ampersands, Markdown emphasis and backticks all appear verbatim", () => {
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    const text = "Logo has <b>bold</b> & *stars* and a `code` span";
    addNote(notes, { stage: "mix", scope: "whole", text });
    const md = notesMarkdown(project(), notes.notes, new Date(2026, 9, 3, 9, 0));
    expect(md).toContain(text);
  });

  it("is empty but valid when there are no notes", () => {
    const md = notesMarkdown(project(), [], new Date(2026, 9, 3, 9, 0));
    expect(md).toBe("# Spring Launch — notes\nExported 2026-10-03 09:00\n");
  });

  it("indents a multi-line note and reply so they stay part of the list (M2)", () => {
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "music", scope: "whole", text: "Line one\nLine two" });
    notes.notes[0].reply = "Fixed in\nthe next pass";
    const md = notesMarkdown(project(), notes.notes, new Date(2026, 9, 3, 9, 0));
    expect(md).toContain("- **Whole** · to do — Line one\n  Line two");
    expect(md).toContain("  - Reply: Fixed in\n    the next pass");
  });

  it("exports an orphaned note (its version no longer exists) under a (removed) group instead of dropping it (M3)", () => {
    const p = project();
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4" });
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "Still here" });
    addNote(notes, { stage: "picture", video: "hero", version: "v2", scope: "point", t: 3, text: "Its cut was deleted" });
    const md = notesMarkdown(p, notes.notes, new Date(2026, 9, 3, 9, 0));
    expect(md).toBe(
      [
        "# Spring Launch — notes",
        "Exported 2026-10-03 09:00",
        "",
        "## Picture",
        "",
        "### Hero · v1",
        "- **0:01.00** · to do — Still here",
        "",
        "### Hero · v2 (removed)",
        "- **0:03.00** · to do — Its cut was deleted",
        "",
      ].join("\n"),
    );
  });

  it("exports an orphaned note whose whole film no longer exists, under its own id (M3)", () => {
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "picture", video: "gone-film", version: "v1", scope: "whole", text: "Film was removed entirely" });
    const md = notesMarkdown(project(), notes.notes, new Date(2026, 9, 3, 9, 0));
    expect(md).toContain("### gone-film · v1 (removed)");
    expect(md).toContain("- **Whole** · to do — Film was removed entirely");
  });

  it("is stable: the same input always produces the same string", () => {
    const p = project();
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4" });
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "A" });
    const now = new Date(2026, 9, 3, 9, 0);
    expect(notesMarkdown(p, notes.notes, now)).toBe(notesMarkdown(p, notes.notes, now));
  });
});
