import { describe, expect, it } from "vitest";
import { tmpProject } from "../helpers/tmp.js";
import { createApp } from "../../src/server/app.js";

describe("POST /api/versions label (§22.4, §22.9)", () => {
  it("takes a label of 48 characters at most, trimmed, and refuses a longer one with the limit", async () => {
    const { store } = await tmpProject("labels");
    const app = createApp(store);
    const post = (json: unknown) =>
      app.request("/api/versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
    const ok = await post({ video: "Hero", file: "renders/hero.mp4", note: "v1: the detail", label: " Launch slower " });
    expect(ok.status).toBe(201);
    expect((await ok.json()).version).toMatchObject({ label: "Launch slower", note: "v1: the detail" });
    expect((await post({ video: "Hero", file: "renders/hero.mp4", label: "x".repeat(48) })).status).toBe(201);
    const long = await post({ video: "Hero", file: "renders/hero.mp4", label: "x".repeat(49) });
    expect(long.status).toBe(400);
    expect(JSON.stringify(await long.json())).toContain("label is 48 characters at most: put the detail in note");
    const state = await (await app.request("/api/state")).json();
    expect(state.project.videos[0].versions.map((x: { label: string }) => x.label)).toEqual(["Launch slower", "x".repeat(48)]);
  });

  it("measures the label after trimming, in characters, and treats an invisible one as none", async () => {
    const { store } = await tmpProject("labels");
    const app = createApp(store);
    const post = (json: unknown) =>
      app.request("/api/versions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(json) });
    const padded = await post({ video: "Hero", file: "renders/hero.mp4", label: `  ${"x".repeat(48)}  ` });
    expect(padded.status).toBe(201);
    expect((await padded.json()).version.label).toBe("x".repeat(48));
    const astral = "\u{1F3AC}".repeat(48);
    expect((await (await post({ video: "Hero", file: "renders/hero.mp4", label: astral })).json()).version.label).toBe(astral);
    expect((await post({ video: "Hero", file: "renders/hero.mp4", label: `${astral}\u{1F3AC}` })).status).toBe(400);
    const blank = await post({ video: "Hero", file: "renders/hero.mp4", note: "v4: kept", label: "\u200b\u200b\u202e" });
    expect(blank.status).toBe(201);
    expect((await blank.json()).version.label).toBe("");
    const lines = await post({ video: "Hero", file: "renders/hero.mp4", label: "one\ntwo" });
    expect((await lines.json()).version.label).toBe("one two");
  });
});
