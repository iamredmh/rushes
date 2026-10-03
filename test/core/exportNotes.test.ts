import { describe, expect, it } from "vitest";
import { exportFileName, notesMarkdown } from "../../src/core/exportNotes.js";
import { addNote } from "../../src/core/notes.js";
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
        "- **Whole** · to do — Loudness check",
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

  it("is stable: the same input always produces the same string", () => {
    const p = project();
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4" });
    const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
    addNote(notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "A" });
    const now = new Date(2026, 9, 3, 9, 0);
    expect(notesMarkdown(p, notes.notes, now)).toBe(notesMarkdown(p, notes.notes, now));
  });
});
