import { describe, expect, it } from "vitest";
import { addNote, applyReply, applyUserEdit, filterNotes } from "../../src/core/notes.js";
import { NoteSchema, type NotesFile } from "../../src/core/schema.js";

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
