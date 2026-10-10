import { describe, expect, it } from "vitest";
import { cutShots, editShot, parseStoryboard, stillPath } from "../../src/core/storyboard.js";

const SAMPLE = `# Storyboard: Lumen launch film

## Shot 01 · Cold open
Tag: ESTABLISH
Length: 3
Still: storyboard/shot-01.png
Status: draft
Direction:

The headline sits on a pale card.
Nothing moves.

## Shot 02 · Drop a folder
Tag: ACTION
Length: 5
Still: storyboard/shot-02.png
Status: approved
Direction: From the right.

A folder of clips lands in the window.

## Notes
Not a shot.
`;

describe("stillPath", () => {
  it("accepts a relative picture inside the project and nothing else", () => {
    expect(stillPath("storyboard/a.png")).toBe("storyboard/a.png");
    expect(stillPath("./storyboard/a.JPG")).toBe("storyboard/a.JPG");
    for (const bad of ["", "/etc/x.png", "~/x.png", "C:/x.png", "../x.png", "a/../x.png", "a//x.png", "a\\x.png", "x.svg", "x.html", "x.png.exe", "dir/"]) expect(stillPath(bad), bad).toBeNull();
  });
});

describe("parseStoryboard", () => {
  it("reads the title and each shot's facts and description, and skips sections that are not shots", () => {
    const p = parseStoryboard(SAMPLE);
    expect(p.title).toBe("Lumen launch film");
    expect(p.shots).toEqual([
      { index: 0, heading: "Shot 01 · Cold open", n: 1, name: "Cold open", tag: "ESTABLISH", length: 3, still: "storyboard/shot-01.png", status: "draft", direction: "", description: "The headline sits on a pale card.\nNothing moves." },
      { index: 1, heading: "Shot 02 · Drop a folder", n: 2, name: "Drop a folder", tag: "ACTION", length: 5, still: "storyboard/shot-02.png", status: "approved", direction: "From the right.", description: "A folder of clips lands in the window." },
    ]);
  });
  it("takes a shot with no facts, no blank line, odd casing, another separator, or a bad length", () => {
    const p = parseStoryboard("## shot 3 - Name\njust words\n\n## Shot 04: B\ntag: x\nLENGTH: nope\nStill: ../x.png\nwords");
    expect(p.shots[0]).toMatchObject({ n: 3, name: "Name", tag: "", length: null, still: null, status: "draft", description: "just words" });
    expect(p.shots[1]).toMatchObject({ n: 4, name: "B", tag: "x", length: null, still: null, description: "words" });
  });
  it("takes an empty file, and Windows line endings", () => {
    expect(parseStoryboard("")).toEqual({ title: "", shots: [] });
    expect(parseStoryboard("# S\r\n\r\n## Shot 1 · A\r\nLength: 2\r\n\r\nWords\r\n").shots[0]).toMatchObject({ length: 2, description: "Words" });
  });
});

describe("editShot", () => {
  it("changes only the description and leaves the facts and every other byte alone", () => {
    const out = editShot(SAMPLE, 0, "Shot 01 · Cold open", { description: "New words." });
    expect(out).toBe(SAMPLE.replace("The headline sits on a pale card.\nNothing moves.", "New words."));
  });
  it("sets a direction or a status in place, and adds a fact line that was missing", () => {
    expect(editShot(SAMPLE, 0, "Shot 01 · Cold open", { direction: "Slower." })).toContain("Status: draft\nDirection: Slower.\n\nThe headline");
    expect(editShot(SAMPLE, 0, "Shot 01 · Cold open", { status: "approved" })).toContain("Status: approved");
    const bare = "## Shot 1 · A\nLength: 2\n\nWords\n";
    expect(editShot(bare, 0, "Shot 1 · A", { status: "approved" })).toBe("## Shot 1 · A\nLength: 2\nStatus: approved\n\nWords\n");
  });
  it("keeps a direction on one line, and can empty one", () => {
    expect(editShot(SAMPLE, 1, "Shot 02 · Drop a folder", { direction: "a\nb" })).toContain("Direction: a b\n");
    expect(editShot(SAMPLE, 1, "Shot 02 · Drop a folder", { direction: "" })).toContain("Direction:\n");
  });
  it("can change several fields in one edit, and round trips", () => {
    const out = editShot(SAMPLE, 1, "Shot 02 · Drop a folder", { description: "Two\nlines", direction: "D", status: "draft" });
    expect(parseStoryboard(out).shots[1]).toMatchObject({ description: "Two\nlines", direction: "D", status: "draft" });
  });
  it("refuses a heading that is not at that position, and a section that is not a shot", () => {
    expect(() => editShot(SAMPLE, 1, "Shot 01 · Cold open", {})).toThrow(/No shot/);
    expect(() => editShot(SAMPLE, 2, "Notes", { description: "x" })).toThrow(/No shot/);
    expect(() => editShot(SAMPLE, 9, "Shot 01 · Cold open", {})).toThrow();
  });
});

describe("cutShots", () => {
  it("starts each shot where the lengths before it end, and counts a missing length as a second", () => {
    expect(cutShots([{ name: "A", tag: "T", length: 3 }, { name: "B", tag: "", length: null }, { name: "C", tag: "", length: 2.5 }])).toEqual([
      { name: "A", start: 0, tag: "T" },
      { name: "B", start: 3, tag: "" },
      { name: "C", start: 4, tag: "" },
    ]);
  });
  it("cuts a long name and tag to what a shot allows", () => {
    const [s] = cutShots([{ name: "n".repeat(100), tag: "t".repeat(40), length: 1 }]);
    expect(s.name).toHaveLength(80);
    expect(s.tag).toHaveLength(24);
  });
});
