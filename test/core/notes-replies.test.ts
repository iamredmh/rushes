import { describe, expect, it } from "vitest";
import { applyReply } from "../../src/core/notes.js";
import { NoteSchema, NotesFileSchema, type NotesFile } from "../../src/core/schema.js";

const base = { id: "n1", stage: "picture", scope: "point", t: 1, text: "Move the title", createdAt: "2026-11-01T10:00:00.000Z" };
const sentNote = NoteSchema.parse({ ...base, batch: "b_1" });
const file = (notes: unknown[]): NotesFile => ({ schema: 1, rev: 0, notes: notes.map((n) => structuredClone(n)) as NotesFile["notes"] });

describe("reply threads", () => {
  it("an old note with reply text loads with it as the first thread entry", () => {
    const n = NoteSchema.parse({ ...base, reply: "Moved the title.", createdAt: "2026-11-01T10:00:00.000Z" });
    expect(n.replies).toEqual([{ by: "agent", text: "Moved the title.", at: "2026-11-01T10:00:00.000Z" }]);
  });
  it("an old note with no reply loads with an empty thread", () => {
    expect(NoteSchema.parse({ ...base, reply: "" }).replies).toEqual([]);
  });
  it("rushes_reply appends to the thread and reply mirrors the latest agent reply", () => {
    const f = file([sentNote]);
    applyReply(f, { id: "n1", reply: "Couldn't find the font." });
    applyReply(f, { id: "n1", reply: "Done, no full stop.", status: "done", fixVersion: "v8" });
    expect(f.notes[0].replies.map((r) => [r.by, r.text])).toEqual([["agent", "Couldn't find the font."], ["agent", "Done, no full stop."]]);
    expect(f.notes[0].reply).toBe("Done, no full stop.");
  });
  it("a reply with only a status adds nothing to the thread", () => {
    const f = file([sentNote]);
    applyReply(f, { id: "n1", status: "done" });
    expect(f.notes[0].replies).toEqual([]);
  });
  it("an empty reply string clears reply and adds nothing", () => {
    const f = file([{ ...sentNote, reply: "old" }]);
    applyReply(f, { id: "n1", reply: "" });
    expect(f.notes[0].reply).toBe("");
    expect(f.notes[0].replies).toEqual([]);
  });
  it("an old note with a 5000-character reply still loads, as the first thread entry", () => {
    const long = "a".repeat(5000);
    expect(NoteSchema.parse({ ...base, reply: long }).replies).toEqual([{ by: "agent", text: long, at: base.createdAt }]);
  });
  it("an agent reply of 5000 characters is stored and the notes file still parses", () => {
    const f = file([sentNote]);
    const long = "b".repeat(5000);
    applyReply(f, { id: "n1", reply: long }, new Date("2026-11-02T09:00:00Z"));
    expect(f.notes[0].replies[0]).toEqual({ by: "agent", text: long, at: "2026-11-02T09:00:00.000Z" });
    expect(NotesFileSchema.safeParse(f).success).toBe(true);
  });
  it("an answer a user wrote before §35 still loads (by: user), so old files read", () => {
    const n = NoteSchema.parse({ ...base, batch: "b_1", replies: [{ by: "agent", text: "Which?", at: base.createdAt }, { by: "user", text: "The left", at: base.createdAt }] });
    expect(n.replies.map((r) => r.by)).toEqual(["agent", "user"]);
  });
});
