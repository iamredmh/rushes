import { describe, expect, it } from "vitest";
import { isNewTake, madeForStale } from "../../src/core/takes.js";
import type { Video } from "../../src/core/schema.js";

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
