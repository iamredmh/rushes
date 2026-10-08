import { describe, expect, it } from "vitest";
import { BY_UI, FILTERS, footText, groupByDay, isFilter, jumpOf, newCount, problemText, recall, remember, rowName, storageKey } from "../../web/src/changelog.js";
import type { LogLine } from "../../src/core/logText.js";

const line = (over: Partial<LogLine>): LogLine => ({ id: "l_1", at: new Date(2026, 9, 7, 14, 32).toISOString(), area: "picture", kind: "cut", text: "x", video: null, version: null, ref: null, by: "agent", tab: null, ...over });
const project = {
  videos: [{ id: "hero", versions: [{ id: "v1" }, { id: "v2" }] }],
  lanes: [{ id: "night-drive", stage: "music" as const }],
};

describe("the drawer's helpers (§22.8)", () => {
  it("filters are the mockup's chips, in order", () => {
    expect(FILTERS.map(([, l]) => l)).toEqual(["All", "Picture", "Voice", "Music", "Sound effects", "Mix", "Notes", "Files"]);
    expect(isFilter("music")).toBe(true);
    expect(isFilter("project")).toBe(false);
    expect(isFilter(null)).toBe(false);
    expect(BY_UI).toEqual({ user: "added by you", agent: "agent", rushes: "Rushes" });
  });

  it("groups by local day under Today, Yesterday and the date", () => {
    const now = new Date(2026, 9, 7, 15, 0);
    const g = groupByDay([
      line({ id: "a", at: new Date(2026, 9, 7, 14, 0).toISOString() }),
      line({ id: "b", at: new Date(2026, 9, 7, 9, 0).toISOString() }),
      line({ id: "c", at: new Date(2026, 9, 6, 17, 0).toISOString() }),
      line({ id: "d", at: new Date(2026, 9, 5, 18, 0).toISOString() }),
    ], now);
    expect(g.map((x) => [x.heading, x.entries.map((e) => e.id)])).toEqual([["Today", ["a", "b"]], ["Yesterday", ["c"]], ["Mon 5 Oct", ["d"]]]);
  });

  it("jumpOf: a cut opens its film and version, a variant its tab and row, a Notes line its tab (R18)", () => {
    expect(jumpOf(line({ video: "hero", version: "v1" }), project)).toEqual({ tab: "picture", video: "hero", version: "v1" });
    expect(jumpOf(line({ area: "music", kind: "variant", ref: "night-drive/bed" }), project)).toEqual({ tab: "music", row: "night-drive/bed" });
    expect(jumpOf(line({ area: "notes", kind: "notes-sent", tab: "voice" }), project)).toEqual({ tab: "voice" });
    expect(jumpOf(line({ area: "assets", kind: "files" }), project)).toEqual({ tab: "assets" });
    expect(jumpOf(line({ area: "script", kind: "script" }), project)).toEqual({ tab: "script" });
  });

  it("jumpOf goes as far as it can when things have gone, and nowhere for a plain line (Review Focus 4, R14)", () => {
    expect(jumpOf(line({ video: "hero", version: "v9" }), project)).toEqual({ tab: "picture", video: "hero" });
    expect(jumpOf(line({ video: "gone", version: "v1" }), project)).toEqual({ tab: "picture" });
    expect(jumpOf(line({ area: "music", kind: "variant", ref: "gone/bed" }), project)).toEqual({ tab: "music" });
    expect(jumpOf(line({ area: "notes", kind: "replies", tab: null }), project)).toBeNull();
    expect(jumpOf(line({ area: "project", kind: "entry" }), project)).toBeNull();
    expect(jumpOf(line({ area: "picture", kind: "entry" }), project)).toBeNull();
    expect(jumpOf(line({ area: "picture", kind: "entry", video: "hero", version: "v2" }), project)).toEqual({ tab: "picture", video: "hero", version: "v2" });
  });

  it("newCount counts new and updated lines; footText says how many and when there are more (Review Focus 5)", () => {
    const shown = [line({ id: "a", at: "2026-10-07T10:00:00.000Z" }), line({ id: "b", at: "2026-10-07T09:00:00.000Z" })];
    expect(newCount(shown, [line({ id: "c" }), line({ id: "a", at: "2026-10-07T10:01:00.000Z" }), ...shown.slice(1)])).toBe(2);
    expect(newCount(shown, shown)).toBe(0);
    expect(footText({ entries: [1, 2, 3], earlier: 0, dropped: 0 })).toBe("3 entries");
    expect(footText({ entries: [1], earlier: 0, dropped: 0 })).toBe("1 entry");
    expect(footText({ entries: new Array(1000), earlier: 4000, dropped: 7 })).toBe("Showing the newest 1000 of 5000 · Earlier entries were removed");
  });

  it("a row's accessible name is full words: the text, then area, time and who", () => {
    expect(rowName(line({ text: "v6 added: launch 1.45x slower" }), "14:32")).toBe("v6 added: launch 1.45x slower (Picture, 14:32, by the agent)");
    expect(rowName(line({ text: "Slowed the zooms", by: "user", area: "sfx" }), "09:05")).toBe("Slowed the zooms (Sound effects, 09:05, added by you)");
    expect(rowName(line({ by: "rushes", area: "assets" }), "18:10")).toBe("x (Files, 18:10, by Rushes)");
  });

  it("problems are plain words, never the raw error (§22.8)", () => {
    const raw = "EISDIR: illegal operation on a directory, read";
    const server = Object.assign(new Error(raw), { status: 500 });
    const refused = Object.assign(new Error("Invalid input: expected string"), { status: 400 });
    const offline = new TypeError("Load failed");
    const all = [
      problemText("read", server), problemText("read", refused), problemText("read", offline), problemText("read", new SyntaxError("Unexpected token <")),
      problemText("add", server), problemText("add", refused), problemText("add", offline),
      problemText("export", server), problemText("export", offline),
    ];
    for (const m of all) {
      expect(m).not.toMatch(/EISDIR|Invalid input|Load failed|Unexpected token|undefined|\[object/);
      expect(m).toMatch(/^[A-Z][^]*\.$/);
    }
    expect(problemText("read", server)).toBe("The Change Log couldn't be read. Run rushes doctor to see why.");
    expect(problemText("add", refused)).toBe("That line wasn't added: it needs a few words of text.");
    expect(problemText("add", server)).toBe("That line wasn't added: the Change Log couldn't be written. Run rushes doctor to see why.");
    expect(problemText("read", offline)).toBe("The Change Log couldn't be loaded: Rushes didn't answer. Check it's still running, then try again.");
    expect(new Set(all).size).toBeGreaterThan(5);
  });

  it("storage never throws: blocked, missing or full storage reads as nothing", () => {
    const boom = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(recall(boom, "k")).toBeNull();
    expect(() => remember(boom, "k", "v")).not.toThrow();
    expect(recall(undefined, "k")).toBeNull();
    const map = new Map<string, string>();
    const ok = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    remember(ok, storageKey("k7m2q9ab", "log-filter"), "music");
    expect(recall(ok, "rushes:k7m2q9ab:log-filter")).toBe("music");
  });
});
