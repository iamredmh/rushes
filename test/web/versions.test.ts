import { describe, expect, it } from "vitest";
import { cutSubtitle, shortLabel } from "../../web/src/versions.js";

describe("versions.ts (§22.4)", () => {
  it("re-exports the server's shortLabel, so both sides say the same", () => {
    expect(shortLabel({ id: "v6", note: "v6: launch 1.45x slower; more", file: "a.mp4" })).toBe("launch 1.45x slower");
  });
  it("cutSubtitle is the short label, or nothing for a cut with no label and no note", () => {
    expect(cutSubtitle({ id: "v1", note: "v1: first pass; rough", file: "a.mp4", label: "" })).toBe("first pass");
    expect(cutSubtitle({ id: "v1", note: "", file: "a.mp4", label: "Agent's" })).toBe("Agent's");
    expect(cutSubtitle({ id: "v1", note: "  ", file: "a.mp4", label: "" })).toBeNull();
    expect(cutSubtitle(undefined)).toBeNull();
  });
});
