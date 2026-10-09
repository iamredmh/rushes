import { describe, expect, it } from "vitest";
import { addTake, editSection, fit, isChanged, isTakeStale, setSections } from "../../src/core/script.js";
import type { Script } from "../../src/core/schema.js";

const empty = (): Script => ({ schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] });

describe("fit", () => {
  it("counts words and compares reading time to the slot", () => {
    expect(fit("Your work lives on one laptop.", 13, 2.6)).toMatchObject({ words: 6, state: "ok" });
    const tight = fit("one two three four five six seven eight nine ten", 4.5, 2.6);
    expect(tight.state).toBe("tight");
    expect(fit("a b c d e f g h i j k l m n o p q r s t u v w", 8, 2.6).state).toBe("over");
  });
  it("treats an empty line as zero words that fit", () => {
    expect(fit("   ", 5, 2.6)).toMatchObject({ words: 0, seconds: 0, state: "ok" });
  });
});

describe("setSections", () => {
  it("sorts by start, numbers new sections s1, s2 and rejects overlaps", () => {
    const s = empty();
    setSections(s, [
      { start: 13, end: 30, current: "B" },
      { start: 0, end: 13, current: "A" },
    ]);
    expect(s.sections.map((x) => [x.id, x.current])).toEqual([["s1", "A"], ["s2", "B"]]);
    expect(() => setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 9, end: 20, current: "B" }])).toThrow(/overlap/);
    expect(() => setSections(s, [{ start: 5, end: 5, current: "A" }])).toThrow(/end after/);
  });

  it("refuses a new section id that would read as the read, a take or a variant in a note's `on` (I3)", () => {
    const s = empty();
    for (const id of ["vo", "s1:t1", "music/a"]) {
      expect(() => setSections(s, [{ id, start: 0, end: 5, current: "A" }])).toThrow(/can't be "vo"/);
    }
    expect(s.sections).toEqual([]);
    // A script saved before the rule still loads, and its odd id can still be updated.
    s.sections = [{ id: "a:b", start: 0, end: 5, current: "A", proposed: null, direction: "", status: "draft", takes: [] }];
    setSections(s, [{ id: "a:b", start: 0, end: 6, current: "B" }]);
    expect(s.sections[0]).toMatchObject({ id: "a:b", end: 6, current: "B" });
  });

  it("keeps the user's proposal, direction and takes when the agent re-sends a section", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "Old line." }]);
    editSection(s, "s1", { proposed: "New line.", direction: "Lighter", status: "flagged" });
    addTake(s, "s1", { file: "t1.wav" });
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "Old line." }]);
    expect(s.sections[0]).toMatchObject({ proposed: "New line.", direction: "Lighter", status: "flagged" });
    expect(s.sections[0].takes).toHaveLength(1);
  });

  it("merges by id by default: sections left out stay as they are, takes included", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }, { start: 20, end: 30, current: "C" }]);
    editSection(s, "s1", { proposed: "A2", direction: "Warm" });
    addTake(s, "s1", { file: "a.wav" });
    addTake(s, "s3", { file: "c.wav" });
    setSections(s, [{ id: "s2", start: 10, end: 19, current: "B, shorter" }]);
    expect(s.sections.map((x) => [x.id, x.start, x.end, x.current])).toEqual([
      ["s1", 0, 10, "A"], ["s2", 10, 19, "B, shorter"], ["s3", 20, 30, "C"],
    ]);
    expect(s.sections[0]).toMatchObject({ proposed: "A2", direction: "Warm" });
    expect(s.sections[0].takes).toHaveLength(1);
    expect(s.sections[2].takes).toHaveLength(1);
  });

  it("merge treats an input with no id as a new section with an s<n> id nobody has", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }]);
    const out = setSections(s, [{ start: 20, end: 30, current: "C" }, { id: "intro", start: 30, end: 40, current: "D" }]);
    expect(out.map((x) => x.id)).toEqual(["s1", "s2", "s3", "intro"]);
    // A gap in the numbering is not reused when the id at that position is taken.
    setSections(s, [{ start: 40, end: 41, current: "E" }]);
    expect(s.sections.map((x) => x.id)).toEqual(["s1", "s2", "s3", "intro", "s5"]);
    setSections(s, [{ start: 50, end: 51, current: "F" }, { start: 52, end: 53, current: "G" }]);
    expect(new Set(s.sections.map((x) => x.id)).size).toBe(s.sections.length);
    expect(s.sections.every((x) => /^s\d+$|^intro$/.test(x.id))).toBe(true);
  });

  describe("an id that was handed out is never handed out again", () => {
    // Notes and picks name a section by id. If a removed section's id came back for new words, an
    // old note would quietly attach to a line it was never about.
    it("a section dropped by a replace leaves its id unused", () => {
      const s = empty();
      setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }, { start: 20, end: 30, current: "C" }]);
      setSections(s, [{ id: "s1", start: 0, end: 10, current: "A" }], { replace: true });
      setSections(s, [{ start: 10, end: 20, current: "D" }]);
      expect(s.sections.map((x) => [x.id, x.current])).toEqual([["s1", "A"], ["s4", "D"]]);
    });

    it("a replace with no ids at all starts after the old numbers, not back at s1", () => {
      const s = empty();
      setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }]);
      setSections(s, [{ start: 0, end: 10, current: "A2" }, { start: 10, end: 20, current: "B2" }], { replace: true });
      expect(s.sections.map((x) => x.id)).toEqual(["s3", "s4"]);
    });

    it("works out the numbers already used for a script saved before it kept a count", () => {
      const s: Script = { schema: 1, rev: 3, wordsPerSecond: 2.6, sections: ["s1", "s2", "s3"].map((id, i) => ({ id, start: i * 10, end: i * 10 + 10, current: id, proposed: null, direction: "", status: "draft" as const, takes: [] })) };
      setSections(s, [{ start: 0, end: 10, current: "New" }], { replace: true });
      expect(s.sections.map((x) => x.id)).toEqual(["s4"]);
    });

    it("keeps the count when the script is written and read back", async () => {
      const { ScriptSchema } = await import("../../src/core/schema.js");
      const s = empty();
      setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }]);
      const back = ScriptSchema.parse(JSON.parse(JSON.stringify(s)));
      setSections(back, [{ start: 0, end: 10, current: "A2" }], { replace: true });
      expect(back.sections.map((x) => x.id)).toEqual(["s3"]);
    });
  });

  it("merge checks overlaps against the resulting list and keeps it sorted", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 20, end: 30, current: "C" }]);
    expect(() => setSections(s, [{ start: 25, end: 35, current: "X" }])).toThrow(/overlap/);
    expect(() => setSections(s, [{ id: "s1", start: 0, end: 21, current: "A" }])).toThrow(/overlap/);
    expect(s.sections).toHaveLength(2);
    setSections(s, [{ start: 10, end: 20, current: "B" }]);
    expect(s.sections.map((x) => x.current)).toEqual(["A", "B", "C"]);
  });

  it("rejects duplicate ids in the input, in both modes", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "A" }]);
    const dup = [{ id: "s1", start: 0, end: 5, current: "A" }, { id: "s1", start: 5, end: 10, current: "B" }];
    expect(() => setSections(s, dup)).toThrow(/twice/);
    expect(() => setSections(s, dup, { replace: true })).toThrow(/twice/);
  });

  it("replace: true makes the input the whole list and keeps retained ids' edits", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }]);
    editSection(s, "s2", { proposed: "B2", direction: "Slow" });
    addTake(s, "s2", { file: "b.wav" });
    setSections(s, [{ id: "s2", start: 0, end: 12, current: "B" }], { replace: true });
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0]).toMatchObject({ id: "s2", start: 0, end: 12, proposed: "B2", direction: "Slow" });
    expect(s.sections[0].takes).toHaveLength(1);
  });

  it("a flagged section goes back to draft when the agent changes its line", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }]);
    editSection(s, "s1", { status: "flagged" });
    editSection(s, "s2", { status: "flagged" });
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "A, reworked" }, { id: "s2", start: 10, end: 20, current: "B" }]);
    expect(s.sections.map((x) => x.status)).toEqual(["draft", "flagged"]);
    editSection(s, "s1", { status: "flagged" });
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "A, again" }], { replace: true });
    expect(s.sections[0].status).toBe("draft");
  });

  it("an approved section goes back to draft when the agent changes its line, since the approval was for the old words", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "A" }, { start: 10, end: 20, current: "B" }, { start: 20, end: 30, current: "C" }]);
    for (const id of ["s1", "s2", "s3"]) editSection(s, id, { status: "approved" });
    setSections(s, [
      { id: "s1", start: 0, end: 10, current: "A, reworked" },
      { id: "s2", start: 10, end: 20, current: "  B " }, // same words, different spacing: still the line the user approved
      { id: "s3", start: 20, end: 30, current: "C" },
    ]);
    expect(s.sections.map((x) => x.status)).toEqual(["draft", "approved", "approved"]);
    editSection(s, "s2", { status: "approved" });
    setSections(s, [{ id: "s2", start: 10, end: 20, current: "B, again" }], { replace: true });
    expect(s.sections[0].status).toBe("draft");
  });

  it("clears the proposal once the agent adopts it as the current line", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "Old line." }]);
    editSection(s, "s1", { proposed: "New line.", status: "flagged" });
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "New line." }]);
    expect(s.sections[0]).toMatchObject({ current: "New line.", proposed: null, status: "draft" });
    expect(isChanged(s.sections[0])).toBe(false);
  });
});

describe("takes", () => {
  it("marks a take stale when the line changes after it was read", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "Line one." }]);
    const take = addTake(s, "s1", { file: "a.wav", duration: 3.2 });
    expect(take).toMatchObject({ id: "t1", forText: "Line one.", duration: 3.2 });
    expect(isTakeStale(take, s.sections[0])).toBe(false);
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "Line one, rewritten." }]);
    expect(isTakeStale(s.sections[0].takes[0], s.sections[0])).toBe(true);
  });
  it("throws for an unknown section", () => {
    expect(() => addTake(empty(), "nope", { file: "a.wav" })).toThrow(/section "nope" not found/);
  });
});
