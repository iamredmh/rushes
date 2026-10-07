import { describe, expect, it } from "vitest";
import { ago, agoSpoken, cutSubtitle, dayDiff, moveActive, oneLineOf, shortLabel, typeAhead, versionMeta } from "../../web/src/versions.js";

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
  it("ago's boundaries: 59 s, 60 s, 59 min, 1 h, midnight, 23 h, 24 h, 47 h, 48 h, 6 days, 7 days", () => {
    expect(ago(before(59_000), now)).toBe("just now");
    expect(ago(before(60_000), now)).toBe("1 min ago");
    expect(ago(before(59 * 60_000), now)).toBe("59 min ago");
    expect(ago(before(3_600_000), now)).toBe("1 h ago");
    expect(ago(before(12 * 3_600_000), now)).toBe("12 h ago"); // midnight today
    expect(ago(before(12 * 3_600_000 + 60_000), now)).toBe("yesterday"); // 23:59 the day before
    expect(ago(before(23 * 3_600_000), now)).toBe("yesterday");
    expect(ago(before(24 * 3_600_000), now)).toBe("yesterday");
    expect(ago(before(47 * 3_600_000), now)).toBe("2 days ago");
    expect(ago(before(48 * 3_600_000), now)).toBe("2 days ago");
    expect(ago(before(6 * 86_400_000), now)).toBe("6 days ago");
    expect(ago(before(7 * 86_400_000), now)).toBe("30 Sep");
    expect(ago("not a date", now)).toBe("");
  });
  it("ago: 'yesterday' is the previous calendar day, not 24 to 48 hours (M3 ruling)", () => {
    const justAfterMidnight = new Date(2026, 9, 7, 0, 30);
    expect(ago(new Date(2026, 9, 6, 23, 50).toISOString(), justAfterMidnight)).toBe("40 min ago");
    expect(ago(new Date(2026, 9, 6, 22, 0).toISOString(), justAfterMidnight)).toBe("yesterday");
    expect(ago(new Date(2026, 9, 5, 23, 59).toISOString(), justAfterMidnight)).toBe("2 days ago");
    const lateEvening = new Date(2026, 9, 7, 23, 59);
    expect(ago(new Date(2026, 9, 6, 0, 1).toISOString(), lateEvening)).toBe("yesterday"); // 47 h 58 min
    expect(ago(new Date(2026, 9, 7, 0, 1).toISOString(), lateEvening)).toBe("23 h ago");
  });
  it("dayDiff counts calendar days in local time", () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
    expect(dayDiff(at(7, 0, 0), new Date(2026, 9, 7, 23, 59))).toBe(0);
    expect(dayDiff(at(6, 23, 59), new Date(2026, 9, 7, 0, 0))).toBe(1);
    expect(dayDiff(at(1, 12), new Date(2026, 9, 7, 12))).toBe(6);
    expect(dayDiff(new Date(2025, 11, 31, 23).toISOString(), new Date(2026, 0, 1, 1))).toBe(1); // over a new year
    expect(dayDiff(at(8, 1), new Date(2026, 9, 7, 23))).toBe(-1); // a clock ahead
    expect(dayDiff("", new Date())).toBeNull();
    expect(dayDiff("not a date", new Date())).toBeNull();
  });
  it("agoSpoken says the same in full words, for a row's accessible name (M4)", () => {
    expect(agoSpoken(before(30_000), now)).toBe("just now");
    expect(agoSpoken(before(60_000), now)).toBe("1 minute ago");
    expect(agoSpoken(before(12 * 60_000), now)).toBe("12 minutes ago");
    expect(agoSpoken(before(3_600_000), now)).toBe("1 hour ago");
    expect(agoSpoken(before(2 * 3_600_000), now)).toBe("2 hours ago");
    expect(agoSpoken(before(30 * 3_600_000), now)).toBe("yesterday");
    expect(agoSpoken(before(3 * 86_400_000), now)).toBe("3 days ago");
    expect(agoSpoken(new Date(2026, 8, 27, 9, 0).toISOString(), now)).toBe("27 September");
    expect(agoSpoken(new Date(2025, 9, 5, 9, 0).toISOString(), now)).toBe("5 October 2025");
    expect(agoSpoken("", now)).toBe("");
  });
  it("re-exports oneLineOf, so a note made only of invisible characters reads as none (M2)", () => {
    expect(oneLineOf("​")).toBe("");
    expect(oneLineOf("  first line\nsecond\tline ")).toBe("first line second line");
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
