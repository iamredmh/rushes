import { describe, expect, it } from "vitest";
import { assetOnFilm, filmFilterOn, filmFromSearch, FOLDERS, noteOnFilm, scopeState, withFilm, briefPrompt, ROOT_PLAN } from "../../web/src/lib.js";
import type { State } from "../../web/src/types.js";

// §31.5: the desk follows the selected film.

const videos = [{ id: "a" }, { id: "b" }];

describe("the film in the URL", () => {
  it("reads ?film= and writes it back, keeping the rest of the query", () => {
    expect(filmFromSearch("?test=1&film=five-views")).toBe("five-views");
    expect(filmFromSearch("?test=1")).toBeNull();
    expect(withFilm("?test=1", "b")).toBe("?test=1&film=b");
    expect(withFilm("?film=a&test=1", "b")).toBe("?film=b&test=1");
  });
});

describe("what shows on a film", () => {
  it("a note: its own film's, a visual's on every film, one naming none on the first film", () => {
    expect(noteOnFilm({ stage: "picture", video: "b" }, "b", videos)).toBe(true);
    expect(noteOnFilm({ stage: "picture", video: "b" }, "a", videos)).toBe(false);
    expect(noteOnFilm({ stage: "script", video: null }, "a", videos)).toBe(true);
    expect(noteOnFilm({ stage: "script", video: null }, "b", videos)).toBe(false);
    expect(noteOnFilm({ stage: "visuals", video: null }, "b", videos)).toBe(true);
  });

  it("a file in Assets: shared visuals on every film, a bed on each of its films, one naming none on the first", () => {
    expect(assetOnFilm({ shared: true }, "b", videos)).toBe(true);
    expect(assetOnFilm({ videos: ["a", "b"] }, "b", videos)).toBe(true);
    expect(assetOnFilm({ video: "a" }, "b", videos)).toBe(false);
    expect(assetOnFilm({}, "a", videos)).toBe(true);
    expect(assetOnFilm({}, "b", videos)).toBe(false);
  });

  it("offers the Film filter on every folder with several films, and only where it always was with one (§31.7)", () => {
    const music = FOLDERS.find((f) => f.id === "music")!;
    expect(filmFilterOn(music, 2)).toBe(true);
    expect(filmFilterOn(music, 1)).toBe(false);
    expect(filmFilterOn(FOLDERS.find((f) => f.id === "cut")!, 1)).toBe(true);
  });

  it("scopes the state to a film's plan, tabs, Activity head and notes", () => {
    const plan = (title: string) => ({ script: { wordsPerSecond: 2.6, sections: [] }, brief: { title } as never, storyboard: {} as never, build: {} as never, tabs: [], log: { rev: 1, mark: title, total: 3 } });
    const state = {
      project: { videos },
      notes: { schema: 1, rev: 0, notes: [{ id: "1", stage: "picture", video: "a" }, { id: "2", stage: "picture", video: "b" }, { id: "3", stage: "visuals", video: null }] },
      brief: { title: "root" },
      films: { a: plan("A"), b: plan("B") },
    } as unknown as State;
    const b = scopeState(state, "b");
    expect((b.brief as { title: string }).title).toBe("B");
    expect(b.log?.mark).toBe("B");
    expect(b.notes.notes.map((n) => n.id)).toEqual(["2", "3"]);
    expect(scopeState(state, null)).toBe(state);
  });

  it("names a film's own plan files in its prompts, and the root ones as before", () => {
    expect(briefPrompt("P", "Five", { brief: "films/b/brief.md", storyboard: "films/b/storyboard.md" })).toContain("write films/b/brief.md");
    expect(briefPrompt("P", null, ROOT_PLAN)).toContain("write brief.md");
  });
});
