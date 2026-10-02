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

  it("keeps the user's proposal, direction and takes when the agent re-sends a section", () => {
    const s = empty();
    setSections(s, [{ start: 0, end: 10, current: "Old line." }]);
    editSection(s, "s1", { proposed: "New line.", direction: "Lighter", status: "flagged" });
    addTake(s, "s1", { file: "t1.wav" });
    setSections(s, [{ id: "s1", start: 0, end: 10, current: "Old line." }]);
    expect(s.sections[0]).toMatchObject({ proposed: "New line.", direction: "Lighter", status: "flagged" });
    expect(s.sections[0].takes).toHaveLength(1);
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
