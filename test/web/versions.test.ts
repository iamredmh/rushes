import { describe, expect, it } from "vitest";
import { ago, cutSubtitle, moveActive, shortLabel, typeAhead, versionMeta } from "../../web/src/versions.js";

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

describe("the version list's helpers (§22.8)", () => {
  const now = new Date(2026, 9, 7, 12, 0, 0);
  const before = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it("ago (R22)", () => {
    expect(ago(before(30_000), now)).toBe("just now");
    expect(ago(before(12 * 60_000), now)).toBe("12 min ago");
    expect(ago(before(2 * 3_600_000), now)).toBe("2 h ago");
    expect(ago(before(30 * 3_600_000), now)).toBe("yesterday");
    expect(ago(before(3 * 86_400_000), now)).toBe("3 days ago");
    expect(ago(new Date(2026, 8, 27, 9, 0).toISOString(), now)).toBe("27 Sep");
    expect(ago(new Date(2025, 9, 5, 9, 0).toISOString(), now)).toBe("5 Oct 2025");
    expect(ago("", now)).toBe("");
    expect(ago(before(-60_000), now)).toBe("just now"); // a clock a little ahead
  });
  it("ago's boundaries: 59 s, 60 s, 59 min, 1 h, 23 h, 24 h, 47 h, 48 h, 6 days, 7 days", () => {
    expect(ago(before(59_000), now)).toBe("just now");
    expect(ago(before(60_000), now)).toBe("1 min ago");
    expect(ago(before(59 * 60_000), now)).toBe("59 min ago");
    expect(ago(before(3_600_000), now)).toBe("1 h ago");
    expect(ago(before(23 * 3_600_000), now)).toBe("23 h ago");
    expect(ago(before(24 * 3_600_000), now)).toBe("yesterday");
    expect(ago(before(47 * 3_600_000), now)).toBe("yesterday");
    expect(ago(before(48 * 3_600_000), now)).toBe("2 days ago");
    expect(ago(before(6 * 86_400_000), now)).toBe("6 days ago");
    expect(ago(before(7 * 86_400_000), now)).toBe("30 Sep");
    expect(ago("not a date", now)).toBe("");
  });
  it("typeAhead finds the exact number first, then the newest that starts with it", () => {
    const ids = ["v12", "v11", "v10", "v2", "v1"];
    expect(typeAhead(ids, "1")).toBe("v1");
    expect(typeAhead(ids, "12")).toBe("v12");
    expect(typeAhead(ids, "10")).toBe("v10");
    expect(typeAhead(["v13", "v2"], "1")).toBe("v13");
    expect(typeAhead(ids, "3")).toBeNull();
    expect(typeAhead(["V4", "v3"], "4")).toBe("V4");
  });
  it("moveActive: arrows wrap, Home and End jump, sideways arrows only when asked", () => {
    expect(moveActive("ArrowDown", 0, 3)).toBe(1);
    expect(moveActive("ArrowDown", 2, 3)).toBe(0);
    expect(moveActive("ArrowUp", 0, 3)).toBe(2);
    expect(moveActive("Home", 2, 3)).toBe(0);
    expect(moveActive("End", 0, 3)).toBe(2);
    expect(moveActive("ArrowDown", -1, 3)).toBe(0);
    expect(moveActive("ArrowUp", -1, 3)).toBe(2);
    expect(moveActive("ArrowRight", 0, 3)).toBeNull();
    expect(moveActive("ArrowRight", 2, 3, true)).toBe(0);
    expect(moveActive("ArrowLeft", 0, 3, true)).toBe(2);
    expect(moveActive("a", 0, 3)).toBeNull();
    expect(moveActive("ArrowDown", 0, 0)).toBeNull();
  });
  it("versionMeta: the length when known, the shots and how long ago", () => {
    expect(versionMeta({ duration: 39.7, shots: new Array(11).fill(0), addedAt: before(2 * 3_600_000) }, now)).toBe("39.7 s · 11 shots · 2 h ago");
    expect(versionMeta({ duration: null, shots: [0], addedAt: before(1000) }, now)).toBe("1 shot · just now");
    expect(versionMeta({ duration: 4, shots: [], addedAt: "" }, now)).toBe("4.0 s · no shots");
  });
});
