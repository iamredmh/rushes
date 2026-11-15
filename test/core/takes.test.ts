import { describe, expect, it } from "vitest";
import { filmTakes, isNewTake, madeForStale, takeState } from "../../src/core/takes.js";
import type { Lane, Picks, Project, Variant, Video } from "../../src/core/schema.js";

const video = (id: string, ...versions: string[]) => ({ id, versions: versions.map((v) => ({ id: v })) }) as unknown as Video;

describe("madeForStale", () => {
  it("is false for a take made for the current cut", () => { expect(madeForStale({ madeFor: { hero: "v9" } }, video("hero", "v7", "v9"))).toBe(false); });
  it("is true once the film has a later cut", () => { expect(madeForStale({ madeFor: { hero: "v7" } }, video("hero", "v7", "v9"))).toBe(true); });
  it("is false for an older take that recorded nothing", () => { expect(madeForStale({}, video("hero", "v9"))).toBe(false); });
  it("is false for a take added before the film had a cut", () => { expect(madeForStale({ madeFor: {} }, video("hero", "v1"))).toBe(false); });
});
describe("isNewTake", () => {
  it("is new when added after the pick", () => { expect(isNewTake({ addedAt: "2026-11-14T12:00:00.000Z" }, { at: "2026-11-14T11:00:00.000Z" })).toBe(true); });
  it("is not new when added before the pick", () => { expect(isNewTake({ addedAt: "2026-11-14T10:00:00.000Z" }, { at: "2026-11-14T11:00:00.000Z" })).toBe(false); });
  it("is new when nothing is in use yet", () => { expect(isNewTake({ addedAt: "2026-11-14T10:00:00.000Z" }, undefined)).toBe(true); });
  it("is new against a pick that was worked out, not stored", () => { expect(isNewTake({ addedAt: "2026-11-14T10:00:00.000Z" }, { at: "" })).toBe(true); });
  it("is never new once put away, or with no date", () => {
    expect(isNewTake({ addedAt: "2026-11-14T12:00:00.000Z", putAway: "2026-11-14T12:30:00.000Z" }, undefined)).toBe(false);
    expect(isNewTake({}, undefined)).toBe(false);
  });
});

describe("a take's state", () => {
  const use = { lane: "r2", variant: "b", at: "2026-11-14T11:00:00.000Z", seen: {} };
  it("is in use first, then put away, then new, then earlier", () => {
    expect(takeState({ id: "b", addedAt: "2026-11-14T10:00:00.000Z" }, "r2", use)).toBe("in-use");
    expect(takeState({ id: "b", addedAt: "2026-11-14T12:00:00.000Z", putAway: "2026-11-14T12:30:00.000Z" }, "r1", use)).toBe("put-away");
    expect(takeState({ id: "c", addedAt: "2026-11-14T12:00:00.000Z" }, "r2", use)).toBe("new");
    expect(takeState({ id: "a", addedAt: "2026-11-14T10:00:00.000Z" }, "r1", use)).toBe("earlier");
    expect(takeState({ id: "a" }, "r1", undefined)).toBe("earlier");
    expect(takeState({ id: "a", addedAt: "2026-11-14T10:00:00.000Z" }, "r1", undefined)).toBe("new");
  });
});

describe("filmTakes", () => {
  const variant = (id: string, over: Partial<Variant> = {}): Variant => ({ id, name: `Bed ${id}`, file: `audio/${id}.wav`, meta: {}, cues: [], videos: ["hero"], ...over });
  const project = (lanes: Lane[], videos: { id: string; versions: { id: string }[] }[]) => ({ lanes, videos }) as unknown as Project;
  it("lists every take one film hears, by sound, newest round first, each with its state and the cut it was made for", () => {
    const p = project(
      [
        { id: "r1", stage: "music", name: "Round 1", variants: [variant("a", { addedAt: "2026-11-14T09:00:00.000Z", madeFor: { hero: "v1" } })] },
        { id: "r2", stage: "music", name: "Round 2", variants: [variant("b", { addedAt: "2026-11-14T10:00:00.000Z", madeFor: { hero: "v2" } }), variant("c", { addedAt: "2026-11-14T12:00:00.000Z", madeFor: { hero: "v2" } }), variant("d", { putAway: "2026-11-14T13:00:00.000Z" })] },
        { id: "vo1", stage: "voice", name: "Round 1 · Gerald", variants: [variant("e", { videos: ["teaser"] })] },
      ],
      [{ id: "hero", versions: [{ id: "v1" }, { id: "v2" }] }, { id: "teaser", versions: [] }],
    );
    const picks = { lanes: {}, levels: {}, sections: {}, videos: { hero: { lanes: { r2: "b" }, levels: {}, use: { music: { lane: "r2", variant: "b", at: "2026-11-14T11:00:00.000Z", seen: { r2: "b" } } } } } } as unknown as Picks;
    const takes = filmTakes(p, picks, "hero");
    expect(takes.voice).toEqual([]);
    expect(takes.sfx).toEqual([]);
    expect(takes.music.map((t) => [t.lane, t.variant, t.round, t.state, t.madeFor, t.stale])).toEqual([
      ["r2", "b", "Round 2", "in-use", "v2", false],
      ["r2", "c", "Round 2", "new", "v2", false],
      ["r2", "d", "Round 2", "put-away", null, false],
      ["r1", "a", "Round 1", "earlier", "v1", true],
    ]);
    expect(takes.music[0].name).toBe("Bed b");
  });
});
