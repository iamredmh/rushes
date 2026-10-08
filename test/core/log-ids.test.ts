import { beforeEach, describe, expect, it, vi } from "vitest";

// A generator that keeps handing out the same few ids, as a 24-bit random id eventually does in a
// long log: appendEvent and backfillLog must never store two lines with one id (Task 6 keys rows by it).
const queue: string[] = [];
vi.mock("../../src/core/ids.js", async (real) => ({
  ...(await real<typeof import("../../src/core/ids.js")>()),
  newId: (prefix: string) => queue.shift() ?? `${prefix}_fresh${queue.length}${Math.random().toString(36).slice(2, 6)}`,
}));

const { appendEvent, backfillLog } = await import("../../src/core/log.js");
const { lineEvent } = await import("../../src/core/logEvents.js");
const { addVersion } = await import("../../src/core/project.js");
import type { LogFile, Project } from "../../src/core/schema.js";

const empty = (): LogFile => ({ schema: 1, rev: 0, backfilled: true, undated: [], dropped: 0, entries: [] });
const T0 = Date.UTC(2026, 9, 7, 9, 0);
const at = (min: number) => new Date(T0 + min * 60_000);

describe("log ids are unique in the file (I1)", () => {
  beforeEach(() => {
    queue.length = 0;
  });
  it("a generated id already in the file is drawn again", () => {
    const f = empty();
    queue.push("l_aaaaaa", "l_aaaaaa", "l_aaaaaa", "l_bbbbbb");
    appendEvent(f, lineEvent("One", "project"), "agent", at(0));
    appendEvent(f, lineEvent("Two", "project"), "agent", at(10));
    expect(f.entries.map((e) => e.id)).toEqual(["l_aaaaaa", "l_bbbbbb"]);
  });
  it("an id passed in that's already taken is replaced too", () => {
    const f = empty();
    appendEvent(f, lineEvent("One", "project"), "agent", at(0), "l_same");
    queue.push("l_cccccc");
    expect(appendEvent(f, lineEvent("Two", "project"), "agent", at(10), "l_same").id).toBe("l_cccccc");
  });
  it("backfilled lines never share an id with a line already in the log", () => {
    const f: LogFile = { ...empty(), backfilled: false };
    queue.push("l_dddddd");
    appendEvent(f, lineEvent("Live", "project"), "agent", at(5));
    const p: Project = { schema: 1, rev: 0, name: "Lumen launch film", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", note: "v1: first pass" }, at(-300));
    addVersion(p, { video: "Hero", file: "renders/hero_v2.mp4", note: "v2: second pass" }, at(-200));
    queue.push("l_dddddd", "l_dddddd", "l_eeeeee");
    backfillLog(f, { project: p, batches: { schema: 1, rev: 0, batches: [] }, script: { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [] } }, T0);
    const ids = f.entries.map((e) => e.id);
    expect(f.entries.map((e) => e.text)).toEqual(["v1 added: first pass", "v2 added: second pass", "Live"]);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain("l_dddddd");
  });
});
