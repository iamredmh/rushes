import { describe, expect, it } from "vitest";
import { hashText, parseBrief, setSectionBody, setStatus } from "../../src/core/brief.js";
import { briefTemplate } from "../../src/cli/new.js";

const SAMPLE = `# Brief: Lumen launch film

Status: draft

Your agent drafts this with you.

## Title
Lumen launch film

## Purpose
Show that Lumen finds the best takes.
Second line.

## Tone
Calm and dry.
`;

describe("parseBrief", () => {
  it("reads the title, the status and the sections in order", () => {
    const p = parseBrief(SAMPLE);
    expect(p.title).toBe("Lumen launch film");
    expect(p.status).toBe("draft");
    expect(p.sections).toEqual([
      { heading: "Title", body: "Lumen launch film" },
      { heading: "Purpose", body: "Show that Lumen finds the best takes.\nSecond line." },
      { heading: "Tone", body: "Calm and dry." },
    ]);
  });
  it("reads every section of the template, with no status when there is no line", () => {
    const p = parseBrief(briefTemplate("X"));
    expect(p.sections.map((s) => s.heading)).toHaveLength(9);
    expect(parseBrief("# Brief\n\n## A\nx\n").status).toBeNull();
  });
  it("does not split on a ## inside a code fence, or on ###", () => {
    const p = parseBrief("# B\n\n## One\n```\n## not a heading\n```\n### sub\ntext\n\n## Two\nz\n");
    expect(p.sections.map((s) => s.heading)).toEqual(["One", "Two"]);
    expect(p.sections[0].body).toContain("## not a heading");
  });
  it("takes a file with no sections, no title or a Windows line ending without throwing", () => {
    expect(parseBrief("")).toEqual({ title: "", status: null, sections: [] });
    expect(parseBrief("just words").sections).toEqual([]);
    expect(parseBrief("# T\r\n\r\n## A\r\nx\r\n").sections).toEqual([{ heading: "A", body: "x" }]);
  });
});

describe("setSectionBody", () => {
  it("replaces one section and leaves every other byte alone", () => {
    const out = setSectionBody(SAMPLE, 1, "Purpose", "New purpose.");
    expect(out).toBe(SAMPLE.replace("Show that Lumen finds the best takes.\nSecond line.", "New purpose."));
  });
  it("keeps one blank line before the next heading and one newline at the end", () => {
    const out = setSectionBody(SAMPLE, 2, "Tone", "Warm.\n\n\n");
    expect(out.endsWith("## Tone\nWarm.\n")).toBe(true);
    expect(setSectionBody(SAMPLE, 0, "Title", "A\n\n\nB")).toContain("## Title\nA\n\n\nB\n\n## Purpose");
  });
  it("can empty a section", () => {
    expect(setSectionBody(SAMPLE, 1, "Purpose", "")).toContain("## Purpose\n\n## Tone");
  });
  it("refuses a heading that is not at that position", () => {
    expect(() => setSectionBody(SAMPLE, 1, "Tone", "x")).toThrow(/No section "Tone" at position 2/);
    expect(() => setSectionBody(SAMPLE, 9, "Purpose", "x")).toThrow();
  });
  it("keeps a Windows file's line endings", () => {
    const crlf = "# T\r\n\r\nStatus: draft\r\n\r\n## A\r\nx\r\n\r\n## B\r\ny\r\n";
    expect(setSectionBody(crlf, 0, "A", "new")).toBe("# T\r\n\r\nStatus: draft\r\n\r\n## A\r\nnew\r\n\r\n## B\r\ny\r\n");
    expect(setStatus(crlf, "approved")).toContain("Status: approved\r\n");
  });
  it("round trips: parsing the result gives the new body", () => {
    expect(parseBrief(setSectionBody(SAMPLE, 1, "Purpose", "Two\nlines")).sections[1].body).toBe("Two\nlines");
  });
});

describe("setStatus", () => {
  it("rewrites the status line in place", () => {
    expect(setStatus(SAMPLE, "approved")).toBe(SAMPLE.replace("Status: draft", "Status: approved"));
  });
  it("adds a status line under the title when there is none, or at the top when there is no title", () => {
    expect(setStatus("# Brief: X\n\n## A\nx\n", "approved")).toBe("# Brief: X\n\nStatus: approved\n\n## A\nx\n");
    expect(parseBrief(setStatus("## A\nx\n", "draft")).status).toBe("draft");
  });
  it("reads a Status line the agent wrote in bold, and replaces it rather than adding a second", () => {
    for (const line of ["**Status:** approved", "**Status**: approved", "_Status:_ approved"]) {
      const text = `# T\n\n${line}\n\n## A\nx\n`;
      expect(parseBrief(text).status).toBe("approved");
      const reopened = setStatus(text, "draft");
      expect(reopened).toBe("# T\n\nStatus: draft\n\n## A\nx\n");
      expect(parseBrief(reopened).status).toBe("draft");
    }
  });
  it("only looks above the first section", () => {
    const text = "# T\n\n## Notes\nStatus: draft\n";
    expect(parseBrief(setStatus(text, "approved")).status).toBe("approved");
    expect(setStatus(text, "approved")).toContain("## Notes\nStatus: draft");
  });
});

describe("hashText", () => {
  it("changes with any byte and is stable", () => {
    expect(hashText("a")).toBe(hashText("a"));
    expect(hashText("a")).not.toBe(hashText("a "));
    expect(hashText("a")).toMatch(/^[0-9a-f]{12}$/);
  });
});
