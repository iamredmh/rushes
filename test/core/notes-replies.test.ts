import { describe, expect, it } from "vitest";
import { addUserReply, applyReply } from "../../src/core/notes.js";
import { NoteSchema, type NotesFile } from "../../src/core/schema.js";
import { InvalidError } from "../../src/core/errors.js";

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
    applyReply(f, { id: "n1", reply: "Should the full stop show?" });
    addUserReply(f, "n1", "No full stop.");
    applyReply(f, { id: "n1", reply: "Done, no full stop.", status: "done", fixVersion: "v8" });
    expect(f.notes[0].replies.map((r) => [r.by, r.text])).toEqual([["agent", "Should the full stop show?"], ["user", "No full stop."], ["agent", "Done, no full stop."]]);
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
  it("addUserReply refuses an empty answer", () => {
    expect(() => addUserReply(file([sentNote]), "n1", "  ")).toThrow(InvalidError);
  });
});
