// §38.3: the brief's At a glance card, from its own section or, without one, from the brief's other sections.
import { describe, expect, it } from "vitest";
import { glanceFallback, glanceIndex, parseGlance } from "../../src/core/glance.js";

describe("parseGlance", () => {
  it("groups `- Label: value` lines by label, in first-seen order", () => {
    const body = ["- Ask: Short films for X", "- Must: Every claim from the launch film", "- Length: 10–20 s", "- Must: en-GB spelling"].join("\n");
    expect(parseGlance(body)).toEqual([
      { label: "Ask", values: ["Short films for X"] },
      { label: "Must", values: ["Every claim from the launch film", "en-GB spelling"] },
      { label: "Length", values: ["10–20 s"] },
    ]);
  });

  it("keeps a line that is not `Label: value` as a plain item, and skips blank lines", () => {
    expect(parseGlance("- Ask: one\n\n* just a point\nplain text")).toEqual([
      { label: "Ask", values: ["one"] },
      { label: null, values: ["just a point"] },
      { label: null, values: ["plain text"] },
    ]);
  });

  it("reads bold labels and a value with a colon in it", () => {
    expect(parseGlance("- **Deliver:** 9:16 and 1:1")).toEqual([{ label: "Deliver", values: ["9:16 and 1:1"] }]);
  });

  it("does not take a long sentence with a colon as a label", () => {
    expect(parseGlance("- Everything the film says has to trace back to the approved copy: no exceptions")).toEqual([
      { label: null, values: ["Everything the film says has to trace back to the approved copy: no exceptions"] },
    ]);
  });
});

describe("glanceIndex", () => {
  it("finds the At a glance section whatever its case", () => {
    expect(glanceIndex([{ heading: "The ask" }, { heading: "at a glance" }])).toBe(1);
    expect(glanceIndex([{ heading: "The ask" }])).toBe(-1);
  });
});

describe("glanceFallback", () => {
  it("takes the first sentence of each of the first five sections", () => {
    const sections = ["A", "B", "C", "D", "E", "F"].map((h) => ({ heading: h, body: `First of ${h}. Second of ${h}.` }));
    expect(glanceFallback(sections)).toEqual(["A", "B", "C", "D", "E"].map((h) => ({ heading: h, sentence: `First of ${h}.` })));
  });

  it("reads through list markers and emphasis, and skips code fences and empty sections", () => {
    const sections = [
      { heading: "Rules", body: "- **Draft only.** Nothing gets posted." },
      { heading: "Code", body: "```\nnot this\n```\nThen this line" },
      { heading: "Empty", body: "" },
    ];
    expect(glanceFallback(sections)).toEqual([
      { heading: "Rules", sentence: "Draft only." },
      { heading: "Code", sentence: "Then this line" },
    ]);
  });

  it("leaves out an At a glance section and cuts a long sentence at 200 characters", () => {
    const long = "word ".repeat(80).trim();
    const out = glanceFallback([{ heading: "At a glance", body: "- Ask: x" }, { heading: "Long", body: long }]);
    expect(out).toHaveLength(1);
    expect(out[0].heading).toBe("Long");
    expect(out[0].sentence.length).toBeLessThanOrEqual(200);
    expect(out[0].sentence.endsWith("…")).toBe(true);
  });
});
