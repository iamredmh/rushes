import { describe, expect, it } from "vitest";
import { tabStates } from "../../src/core/tabs.js";
import { createBatch, latestBatch } from "../../src/core/batches.js";
import { addVariant, addVersion } from "../../src/core/project.js";
import { addTake, editSection, setSections } from "../../src/core/script.js";
import { addNote } from "../../src/core/notes.js";
import type { BatchesFile, NotesFile, Project, Script } from "../../src/core/schema.js";

function ctx() {
  const project: Project = { schema: 1, rev: 0, name: "spring-launch", fps: 30, videos: [], lanes: [], files: [] };
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
    addTake(c.script, "s1", { file: "t.wav" });
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

  it("points an audio-stage batch (voice, music, sfx, mix) at the picks and the notes' marks (§17.7)", () => {
    const c = ctx();
    for (const stage of ["voice", "music", "sfx", "mix"] as const) {
      addNote(c.notes, { stage, scope: "whole", text: "Fix it" });
      const b = createBatch(c, stage);
      expect(b.prompt).toContain(
        'Use rushes_get_batch and rushes_get_picks, fix each note (marks such as "Fall" or "Quieter 3 dB" are part of the note), register the new variant or take, then rushes_reply.',
      );
    }
  });

  it("keeps picture's own prompt wording (it doesn't go through picks)", () => {
    const c = ctx();
    addNote(c.notes, { stage: "picture", scope: "point", t: 1, text: "x" });
    const b = createBatch(c, "picture");
    expect(b.prompt).toContain("Use rushes_get_batch, fix each note, then rushes_reply with a fixT for each and rushes_add_version for the new cut.");
    expect(b.prompt).not.toContain("rushes_get_picks");
  });
});
