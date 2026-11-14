import { describe, expect, it } from "vitest";
import { inUse, inUseVariant, setInUse } from "../../src/core/picks.js";
import type { InUse } from "../../src/core/schema.js";

const lane = (id: string, stage: "voice" | "music" | "sfx", ...takes: string[]) => ({ id, stage, name: id, variants: takes.map((t) => ({ id: t, name: t, file: `${t}.wav`, meta: {}, cues: [] })) });
const project = { lanes: [lane("round-1", "voice", "george", "eliza"), lane("round-2", "voice", "george-slow"), lane("beds-a", "music", "pulse"), lane("beds-b", "music", "drift")] };

describe("inUse", () => {
  it("keeps a stored take that still matches its lane's pick", () => {
    const seen = { "round-1": "eliza", "round-2": "george-slow" };
    const picks = { lanes: { ...seen }, use: { voice: { lane: "round-1", variant: "eliza", at: "2026-11-14T10:00:00.000Z", seen } } };
    expect(inUse(project, picks).voice).toEqual({ lane: "round-1", variant: "eliza", at: "2026-11-14T10:00:00.000Z", seen });
  });
  it("works it out from the newest picked lane when nothing is stored", () => {
    expect(inUse(project, { lanes: { "round-1": "george", "round-2": "george-slow" }, use: {} }).voice).toEqual({ lane: "round-2", variant: "george-slow", at: "", seen: {} });
  });
  it("uses one bed when an older project picked in two music lanes", () => {
    const got = inUse(project, { lanes: { "beds-a": "pulse", "beds-b": "drift" }, use: {} });
    expect(got.music).toEqual({ lane: "beds-b", variant: "drift", at: "", seen: {} });
  });
  it("falls back when the stored take no longer exists", () => {
    const picks = { lanes: { "beds-a": "pulse" }, use: { music: { lane: "beds-b", variant: "gone", at: "x", seen: { "beds-a": "pulse" } } } };
    expect(inUse(project, picks).music).toEqual({ lane: "beds-a", variant: "pulse", at: "", seen: {} });
  });
  it("lets a pick made by an older Rushes win", () => {
    // 0.9 had brought George back from round 1; then 0.8.1 picked "eliza" in round 1 and knows nothing of `use`.
    const picks = { lanes: { "round-1": "eliza", "round-2": "george-slow" }, use: { voice: { lane: "round-1", variant: "george", at: "x", seen: { "round-1": "george", "round-2": "george-slow" } } } };
    expect(inUse(project, picks).voice).toEqual({ lane: "round-2", variant: "george-slow", at: "", seen: {} }); // 0.8's own rule: newest picked round
  });
  it("has nothing in use for a sound with no pick", () => {
    expect(inUse(project, { lanes: {}, use: {} })).toEqual({});
  });
});

describe("setInUse", () => {
  it("picks a take and records when", () => {
    const own = { lanes: {} as Record<string, string>, use: {} as InUse };
    setInUse(own, project.lanes, { id: "round-1", stage: "voice" }, "eliza", new Date("2026-11-14T10:00:00.000Z"));
    expect(own).toEqual({ lanes: { "round-1": "eliza" }, use: { voice: { lane: "round-1", variant: "eliza", at: "2026-11-14T10:00:00.000Z", seen: { "round-1": "eliza" } } } });
  });
  it("bringing back an earlier take leaves the newer lane's pick alone but changes what is in use", () => {
    const own = { lanes: { "round-2": "george-slow" } as Record<string, string>, use: { voice: { lane: "round-2", variant: "george-slow", at: "a", seen: { "round-2": "george-slow" } } } as InUse };
    setInUse(own, project.lanes, { id: "round-1", stage: "voice" }, "george", new Date("2026-11-14T11:00:00.000Z"));
    expect(own.lanes).toEqual({ "round-1": "george", "round-2": "george-slow" });
    expect(inUse(project, own).voice).toMatchObject({ lane: "round-1", variant: "george" });
  });
  it("unpicking in another round does not change what is in use", () => {
    const own = { lanes: { "round-1": "george", "round-2": "george-slow" } as Record<string, string>, use: { voice: { lane: "round-1", variant: "george", at: "a", seen: { "round-1": "george", "round-2": "george-slow" } } } as InUse };
    setInUse(own, project.lanes, { id: "round-2", stage: "voice" }, null, new Date());
    expect(inUse(project, own).voice).toMatchObject({ lane: "round-1", variant: "george" });
  });
  it("unpicking the take in use clears it", () => {
    const own = { lanes: { "beds-a": "pulse" } as Record<string, string>, use: { music: { lane: "beds-a", variant: "pulse", at: "a", seen: { "beds-a": "pulse" } } } as InUse };
    setInUse(own, project.lanes, { id: "beds-a", stage: "music" }, null, new Date());
    expect(own).toEqual({ lanes: {}, use: {} });
  });
});

describe("inUseVariant", () => {
  it("gives the lane and take for a sound, or null", () => {
    const use = inUse(project, { lanes: { "beds-a": "pulse" }, use: {} });
    expect(inUseVariant(project, use, "music")?.variant.file).toBe("pulse.wav");
    expect(inUseVariant(project, use, "voice")).toBeNull();
  });
});
