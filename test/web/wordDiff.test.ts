// §38.6: the word diff every Plan page shows under an edit.
import { describe, expect, it } from "vitest";
import { wordDiff, type DiffRun } from "../../web/src/lib.js";

const join = (runs: DiffRun[], keep: "del" | "ins") => runs.filter((r) => r.kind === "same" || r.kind === keep).map((r) => r.text).join("");

describe("wordDiff", () => {
  it("is one same run when nothing changed", () => {
    expect(wordDiff("the cat sat", "the cat sat")).toEqual([{ kind: "same", text: "the cat sat" }]);
  });

  it("marks a swapped word", () => {
    expect(wordDiff("the cat sat", "the dog sat")).toEqual([
      { kind: "same", text: "the " },
      { kind: "del", text: "cat" },
      { kind: "ins", text: "dog" },
      { kind: "same", text: " sat" },
    ]);
  });

  it("is all added when before is empty, all removed when after is", () => {
    expect(wordDiff("", "new words")).toEqual([{ kind: "ins", text: "new words" }]);
    expect(wordDiff("old words", "")).toEqual([{ kind: "del", text: "old words" }]);
    expect(wordDiff("", "")).toEqual([]);
  });

  it("rebuilds both texts exactly, whitespace and line breaks kept", () => {
    const a = "One line.\n\nTwo  spaces here, and a tail";
    const b = "One new line.\n\nTwo spaces here and a longer tail.";
    const runs = wordDiff(a, b);
    expect(join(runs, "del")).toBe(a);
    expect(join(runs, "ins")).toBe(b);
  });

  it("gives up word by word past 2,000 words a side", () => {
    const long = Array.from({ length: 2001 }, (_, i) => `w${i}`).join(" ");
    const runs = wordDiff(long, long + " more");
    expect(runs.map((r) => r.kind)).toEqual(["del", "ins"]);
  });

  it("reads a rewritten phrase as one removal and one addition, not word by word", () => {
    expect(wordDiff("a b c", "x y z")).toEqual([
      { kind: "del", text: "a b c" },
      { kind: "ins", text: "x y z" },
    ]);
    expect(wordDiff("keep a b c end", "keep x y z end")).toEqual([
      { kind: "same", text: "keep " },
      { kind: "del", text: "a b c" },
      { kind: "ins", text: "x y z" },
      { kind: "same", text: " end" },
    ]);
  });
});
