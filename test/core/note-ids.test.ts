import { beforeEach, describe, expect, it, vi } from "vitest";

// A generator that hands out the same id twice, as a 24-bit random id eventually does (about a 3%
// chance by the thousandth note): a second note must never take an id a note already has, or a
// reply meant for one lands on the other.
const queue: string[] = [];
vi.mock("../../src/core/ids.js", async (real) => ({
  ...(await real<typeof import("../../src/core/ids.js")>()),
  newId: (prefix: string) => queue.shift() ?? `${prefix}_fresh${queue.length}${Math.random().toString(36).slice(2, 6)}`,
}));

const { addNote, applyReply } = await import("../../src/core/notes.js");
import type { NotesFile } from "../../src/core/schema.js";

const empty = (): NotesFile => ({ schema: 1, rev: 0, notes: [] });
const point = (text: string) => ({ stage: "picture" as const, video: "hero", version: "v1", scope: "point" as const, t: 1, frame: 30, text });

describe("note ids are unique in the file", () => {
  beforeEach(() => {
    queue.length = 0;
  });

  it("an id already in the file is drawn again", () => {
    const f = empty();
    queue.push("n_aaaaaa", "n_aaaaaa", "n_aaaaaa", "n_bbbbbb");
    const a = addNote(f, point("First"));
    const b = addNote(f, point("Second"));
    expect([a.id, b.id]).toEqual(["n_aaaaaa", "n_bbbbbb"]);
    expect(f.notes.map((n) => n.id)).toEqual(["n_aaaaaa", "n_bbbbbb"]);
  });

  it("so a reply reaches the note it names and no other", () => {
    const f = empty();
    queue.push("n_cccccc", "n_cccccc", "n_dddddd");
    addNote(f, point("First"));
    const second = addNote(f, point("Second"));
    applyReply(f, { id: second.id, reply: "Done", status: "done" });
    expect(f.notes.map((n) => [n.text, n.status, n.reply])).toEqual([
      ["First", "todo", ""],
      ["Second", "done", "Done"],
    ]);
  });
});
