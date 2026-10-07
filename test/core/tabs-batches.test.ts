import { describe, expect, it } from "vitest";
import { tabStates } from "../../src/core/tabs.js";
import { createBatch, formatLines, latestBatch } from "../../src/core/batches.js";
import { addFormat, addVariant, addVersion } from "../../src/core/project.js";
import { addTake, editSection, setSections } from "../../src/core/script.js";
import { addNote } from "../../src/core/notes.js";
import type { BatchesFile, NotesFile, Project, Script } from "../../src/core/schema.js";

function ctx() {
  const project: Project = { schema: 1, rev: 0, name: "spring-launch", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
  const script: Script = { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] };
  const notes: NotesFile = { schema: 1, rev: 0, notes: [] };
  const batches: BatchesFile = { schema: 1, rev: 0, batches: [] };
  return { project, script, notes, batches };
}
const unlocked = (c: ReturnType<typeof ctx>) =>
  Object.fromEntries(tabStates(c.project, c.script, c.notes).map((t) => [t.stage, t.unlocked]));

describe("tabStates", () => {
  it("starts with every tab locked, in workflow order", () => {
    const c = ctx();
    const tabs = tabStates(c.project, c.script, c.notes);
    expect(tabs.map((t) => t.stage)).toEqual(["script", "picture", "voice", "music", "sfx", "mix"]);
    expect(tabs.every((t) => !t.unlocked)).toBe(true);
  });

  it("unlocks each tab as its element arrives, and mix only with picture plus audio", () => {
    const c = ctx();
    setSections(c.script, [{ start: 0, end: 10, current: "Line" }]);
    expect(unlocked(c)).toMatchObject({ script: true, picture: false, mix: false });
    addVariant(c.project, { stage: "music", name: "A", file: "a.wav" });
    expect(unlocked(c)).toMatchObject({ music: true, mix: false });
    addVersion(c.project, { video: "Hero", file: "v1.mp4" });
    expect(unlocked(c)).toMatchObject({ picture: true, mix: true, voice: false, sfx: false });
    addVariant(c.project, { stage: "voice", name: "Gerald", file: "g.wav", round: "Round 1" });
    expect(unlocked(c).voice).toBe(true);
  });

  it("does not unlock Voiceover from script takes alone; only a voice lane with a read does (§18.4)", () => {
    const c = ctx();
    setSections(c.script, [{ start: 0, end: 10, current: "Line" }]);
    addTake(c.script, "s1", { file: "t.wav" });
    expect(unlocked(c).voice).toBe(false);
    addVariant(c.project, { stage: "voice", name: "Gerald", file: "g.wav", round: "Round 1" });
    expect(unlocked(c).voice).toBe(true);
  });

  it("does not unlock picture for a video with no versions, or music for an empty lane", () => {
    const c = ctx();
    c.project.videos.push({ id: "x", name: "X", versions: [], lockedVersion: null });
    c.project.lanes.push({ id: "music", stage: "music", name: "Music", variants: [] });
    expect(unlocked(c)).toMatchObject({ picture: false, music: false });
  });

  it("counts to-do notes per tab, and changed or flagged sections on script", () => {
    const c = ctx();
    setSections(c.script, [{ start: 0, end: 5, current: "A" }, { start: 5, end: 9, current: "B" }]);
    editSection(c.script, "s1", { proposed: "A2" });
    editSection(c.script, "s2", { status: "flagged" });
    addNote(c.notes, { stage: "picture", scope: "point", t: 1, text: "x" });
    addNote(c.notes, { stage: "picture", scope: "point", t: 2, text: "y" });
    const todo = Object.fromEntries(tabStates(c.project, c.script, c.notes).map((t) => [t.stage, t.todo]));
    expect(todo).toMatchObject({ script: 2, picture: 2, music: 0 });
  });
});

describe("createBatch", () => {
  it("batches this tab's unsent to-do notes and builds a prompt", () => {
    const c = ctx();
    const a = addNote(c.notes, { stage: "picture", scope: "point", t: 1, text: "a" });
    addNote(c.notes, { stage: "music", scope: "whole", text: "m" });
    const b = createBatch(c, "picture", new Date("2026-10-02T13:00:00Z"));
    expect(b).toMatchObject({ id: "b_1", stage: "picture", noteIds: [a.id], sectionIds: [], sentAt: "2026-10-02T13:00:00.000Z" });
    expect(b.prompt).toContain("picture batch b_1 on spring-launch: 1 note.");
    expect(b.prompt).toContain("rushes_reply");
    expect(c.notes.notes[0].batch).toBe("b_1");
    expect(c.notes.notes[1].batch).toBeNull();
    expect(latestBatch(c.batches)?.id).toBe("b_1");
  });

  it("does not resend notes that are already in a batch", () => {
    const c = ctx();
    addNote(c.notes, { stage: "picture", scope: "point", t: 1, text: "a" });
    createBatch(c, "picture");
    expect(() => createBatch(c, "picture")).toThrow(/Nothing open/);
    const n2 = addNote(c.notes, { stage: "picture", scope: "point", t: 2, text: "b" });
    expect(createBatch(c, "picture")).toMatchObject({ id: "b_2", noteIds: [n2.id] });
  });

  it("a Picture batch on a cut with formats lists them and the notes by format, and how to fix them (§21.5)", () => {
    const c = ctx();
    addVersion(c.project, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addFormat(c.project, { video: "hero", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
    addFormat(c.project, { video: "hero", file: "renders/hero_v1_1x1.mp4", width: 1080, height: 1080, duration: 8, fps: 30 });
    addNote(c.notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "a" });
    addNote(c.notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 2, text: "b", format: "9x16" });
    addNote(c.notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 3, text: "c", format: "9x16" });
    const b = createBatch(c, "picture");
    expect(b.prompt).toContain("Hero v1 has 3 formats: 16:9 (main), 9:16, 1:1. Notes: 1 for all formats, 2 for 9:16.");
    expect(b.prompt).toContain(
      "A note with a format is for that format only: fix it there and leave the others. An all-format note is for every format: say in your reply which formats you fixed. Register every shape of the new cut (rushes_add_version with formats, or rushes_add_format).",
    );
  });

  it("a one-format Picture batch's prompt says nothing about formats", () => {
    const c = ctx();
    addVersion(c.project, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addNote(c.notes, { stage: "picture", video: "hero", version: "v1", scope: "point", t: 1, text: "a" });
    expect(createBatch(c, "picture").prompt).not.toMatch(/format/i);
  });

  it("only a Picture batch speaks of formats, and a cut with formats but no notes in the batch is left out", () => {
    const c = ctx();
    addVersion(c.project, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addFormat(c.project, { video: "hero", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
    addVersion(c.project, { video: "Solo", file: "renders/solo_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addNote(c.notes, { stage: "music", scope: "whole", text: "m" });
    expect(createBatch(c, "music").prompt).not.toMatch(/format/i);
    addNote(c.notes, { stage: "picture", video: "solo", version: "v1", scope: "point", t: 1, text: "a" });
    expect(createBatch(c, "picture").prompt).not.toMatch(/format/i);
  });

  it("formatLines puts the main shape first, the rest in chip order, and counts each cut's notes (§21.5)", () => {
    const c = ctx();
    addVersion(c.project, { video: "Hero", file: "renders/hero_v1.mp4", duration: 8, width: 1920, height: 1080 });
    addFormat(c.project, { video: "hero", file: "renders/hero_v1_1x1.mp4", width: 1080, height: 1080, duration: 8, fps: 30 });
    addFormat(c.project, { video: "hero", file: "renders/hero_v1_9x16.mp4", width: 1080, height: 1920, duration: 8, fps: 30 });
    const note = (format: string | null) => ({ video: "hero", version: "v1", format });
    const lines = formatLines(c.project, [note("1x1"), note("1x1"), note("16x9"), note(null)]);
    expect(lines[0]).toBe("Hero v1 has 3 formats: 16:9 (main), 9:16, 1:1. Notes: 1 for all formats, 1 for 16:9, 2 for 1:1.");
    expect(lines).toHaveLength(2);
    expect(formatLines(c.project, [])).toEqual([]);
  });

  it("puts changed and flagged sections in a script batch", () => {
    const c = ctx();
    setSections(c.script, [{ start: 0, end: 5, current: "A" }, { start: 5, end: 9, current: "B" }, { start: 9, end: 12, current: "C" }]);
    editSection(c.script, "s1", { proposed: "A2" });
    editSection(c.script, "s3", { status: "flagged" });
    const b = createBatch(c, "script");
    expect(b.sectionIds).toEqual(["s1", "s3"]);
    expect(b.prompt).toContain("2 script sections");
    expect(b.prompt).toContain("rushes_set_script");
  });

  it("points an audio-stage batch (music, sfx, mix) at the picks and the notes' marks (§17.7)", () => {
    const c = ctx();
    for (const stage of ["music", "sfx", "mix"] as const) {
      addNote(c.notes, { stage, scope: "whole", text: "Fix it" });
      const b = createBatch(c, stage);
      expect(b.prompt).toContain(
        'Use rushes_get_batch and rushes_get_picks, fix each note (marks such as "Fall" or "Quieter 3 dB" are part of the note), register the new variant, then rushes_reply.',
      );
      expect(b.prompt).not.toContain("take");
    }
  });

  it("also points the Mix batch at the levels: where the user wants each lane to sit (§19.6)", () => {
    const c = ctx();
    addNote(c.notes, { stage: "mix", scope: "whole", text: "Bring the music up" });
    const b = createBatch(c, "mix");
    expect(b.prompt).toContain("levels");
    // Music and sfx get the shared audio-stage wording and nothing about levels.
    for (const stage of ["music", "sfx"] as const) {
      addNote(c.notes, { stage, scope: "whole", text: "Fix it" });
      expect(createBatch(c, stage).prompt).not.toContain("levels");
    }
  });

  it("points a voice batch at new whole reads by round, not at old marks-based fixes (§18.5)", () => {
    const c = ctx();
    addNote(c.notes, { stage: "voice", scope: "whole", text: "More sombre" });
    const b = createBatch(c, "voice");
    expect(b.prompt).toContain("new whole read");
    expect(b.prompt).toContain("rushes_add_variant with stage voice and round");
    expect(b.prompt).toContain("rushes_reply");
  });

  it("keeps picture's own prompt wording (it doesn't go through picks)", () => {
    const c = ctx();
    addNote(c.notes, { stage: "picture", scope: "point", t: 1, text: "x" });
    const b = createBatch(c, "picture");
    expect(b.prompt).toContain("Use rushes_get_batch, fix each note, then rushes_reply with a fixT for each and rushes_add_version for the new cut.");
    expect(b.prompt).not.toContain("rushes_get_picks");
  });

  it("tells the script agent to re-record the picked voice as a new round when VO already exists (§18.5)", () => {
    const c = ctx();
    setSections(c.script, [{ start: 0, end: 5, current: "A" }]);
    editSection(c.script, "s1", { proposed: "A2" });
    const b = createBatch(c, "script");
    expect(b.prompt).toContain("re-record the picked voice");
  });
});
