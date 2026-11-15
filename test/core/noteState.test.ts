import { describe, expect, it } from "vitest";
import { canMove, markSent, moveNote, NOTE_STATE_LABEL, NOTE_TRANSITIONS, noteState, withState } from "../../src/core/noteState.js";
import type { Note } from "../../src/core/schema.js";

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1", stage: "picture", video: null, version: null, on: null, scope: "point", t: 1, tOut: null, frame: null,
  text: "Hold longer", box: null, pin: null, grab: null, shot: null, marks: [], format: null,
  status: "todo", reply: "", fixT: null, fixVersion: null, batch: null, createdAt: "2026-11-15T10:00:00.000Z", by: "user",
  ...over,
});

describe("a note's state", () => {
  it("is read from the two stored fields: done wins, then a batch means the agent has it", () => {
    expect(noteState({ status: "todo", batch: null })).toBe("todo");
    expect(noteState({ status: "todo", batch: "b_1" })).toBe("sent");
    expect(noteState({ status: "done", batch: "b_1" })).toBe("done");
    expect(noteState({ status: "done", batch: null })).toBe("done");
    expect(NOTE_STATE_LABEL).toEqual({ todo: "To do", sent: "With your agent", done: "Done" });
  });

  it("moves only along the table: send a to-do, resolve a to-do or a sent note, reopen a done one", () => {
    expect(NOTE_TRANSITIONS).toEqual({ todo: { send: "sent", resolve: "done" }, sent: { resolve: "done" }, done: { reopen: "todo" } });
    expect(canMove("todo", "send")).toBe(true);
    expect(canMove("sent", "send")).toBe(false);
    expect(canMove("done", "send")).toBe(false);
    expect(canMove("sent", "reopen")).toBe(false);
    expect(canMove("done", "resolve")).toBe(false);
  });

  it("sending files a to-do note in the batch; anything else can't be sent", () => {
    const n = note();
    moveNote(n, { type: "send", batch: "b_2" });
    expect(n).toMatchObject({ status: "todo", batch: "b_2" });
    expect(() => moveNote(n, { type: "send", batch: "b_3" })).toThrow(/can't send a note that is sent/);
    expect(() => moveNote(note({ status: "done" }), { type: "send", batch: "b_3" })).toThrow(/can't send a note that is done/);
  });

  it("resolving keeps the batch it was sent in; reopening clears it, so the next Send takes it again", () => {
    const n = note({ batch: "b_1" });
    moveNote(n, { type: "resolve" });
    expect(n).toMatchObject({ status: "done", batch: "b_1" });
    moveNote(n, { type: "reopen" });
    expect(n).toMatchObject({ status: "todo", batch: null });
    expect(noteState(n)).toBe("todo");
  });

  it("markSent files only the batch's notes that are still to do and unsent", () => {
    const notes = [note({ id: "a" }), note({ id: "b", batch: "b_1" }), note({ id: "c", status: "done" }), note({ id: "d" })];
    markSent(notes, { id: "b_2", noteIds: ["a", "b", "c"] });
    expect(notes.map((n) => [n.id, n.batch])).toEqual([["a", "b_2"], ["b", "b_1"], ["c", null], ["d", null]]);
  });

  it("withState adds the state to a copy and leaves the note as it was", () => {
    const n = note({ batch: "b_1" });
    expect(withState(n)).toMatchObject({ id: "n1", state: "sent" });
    expect("state" in n).toBe(false);
  });
});
