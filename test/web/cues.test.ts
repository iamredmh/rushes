import { describe, expect, it } from "vitest";
import { baseName, cardPosition, cueCount, cueKeys, cueLabel, cueLayers, cueName, cuesInTime, rovingIndex, tickLeft, tickPlace } from "../../web/src/cues.js";

const cue = (id: string, name: string, t: number, file?: string) => (file === undefined ? { id, name, t } : { id, name, t, file });

describe("cues in time (§23)", () => {
  it("sorts by time and keeps the sent order for cues at the same moment, without sorting in place", () => {
    const cues = [cue("b", "thud", 2), cue("a", "whoosh", 0.5), cue("c", "click", 2), cue("d", "pop", 1)];
    expect(cuesInTime(cues).map((c) => c.id)).toEqual(["a", "d", "b", "c"]);
    expect(cues.map((c) => c.id)).toEqual(["b", "a", "c", "d"]);
  });
});

describe("cueLayers: layers by sound (§23.2)", () => {
  const cues = [
    cue("thud-2", "thud", 3, "sfx/thud_low_03.wav"),
    cue("whoosh", "whoosh", 0.5, "sfx/whoosh_long_01.wav"),
    cue("thud", "thud", 1, "sfx/thud_low_03.wav"),
    cue("click", "click", 1.1),
    cue("thud-3", " thud ", 4.5, "sfx/thud_low_04.wav"),
    cue("thud-4", "Thud", 5),
    cue("blank", "   ", 6),
  ];
  const layers = cueLayers(cues);

  it("gives one layer per name, in order of first appearance in time, and repeats share it", () => {
    expect(layers.map((l) => l.name)).toEqual(["whoosh", "thud", "click", "Thud", "Untitled cue"]);
    expect(layers[1].cues.map((c) => c.id)).toEqual(["thud", "thud-2", "thud-3"]);
    expect(layers.map((l) => l.cues.length)).toEqual([1, 3, 1, 1, 1]);
  });

  it("names the first file a layer's cues send, and counts any others", () => {
    expect(layers[0]).toMatchObject({ file: "sfx/whoosh_long_01.wav", moreFiles: 0 });
    expect(layers[1]).toMatchObject({ file: "sfx/thud_low_03.wav", moreFiles: 1 });
    expect(layers[2]).toMatchObject({ file: null, moreFiles: 0 });
  });

  it("is empty for a pass with no cues", () => expect(cueLayers([])).toEqual([]));
});

describe("a cue's words", () => {
  it("names it by its trimmed name, says its time and place, and shortens a path to its file", () => {
    expect(cueName({ name: "  swoosh · end line " })).toBe("swoosh · end line");
    expect(cueName({ name: " " })).toBe("Untitled cue");
    expect(cueLabel({ name: "thud", t: 4.2 })).toBe("thud at 0:04.20");
    expect(cueCount(5, 80)).toBe("cue 5 of 80");
    expect(baseName("audio/sfx/samples/thud_low_03.wav")).toBe("thud_low_03.wav");
    expect(baseName("C:\\Library\\pop.wav")).toBe("pop.wav");
  });
});

describe("rovingIndex (§23.5 keyboard)", () => {
  it("steps left and right, jumps with Home and End, and never wraps", () => {
    expect(rovingIndex("ArrowRight", 0, 3)).toBe(1);
    expect(rovingIndex("ArrowRight", 2, 3)).toBe(2);
    expect(rovingIndex("ArrowLeft", 0, 3)).toBe(0);
    expect(rovingIndex("ArrowLeft", 2, 3)).toBe(1);
    expect(rovingIndex("Home", 2, 3)).toBe(0);
    expect(rovingIndex("End", 0, 3)).toBe(2);
  });
  it("leaves every other key alone, and does nothing with no cues", () => {
    for (const key of ["ArrowUp", "ArrowDown", "Enter", " ", "Escape", "Tab", "n"]) expect(rovingIndex(key, 1, 3)).toBeNull();
    expect(rovingIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("tickLeft", () => {
  it("is the time's share of the timeline, kept on the track", () => {
    expect(tickLeft(10, 40)).toBe("25.000%");
    expect(tickLeft(45, 40)).toBe("100.000%");
    expect(tickLeft(-1, 40)).toBe("0.000%");
    expect(tickLeft(3, 0)).toBe("0.000%");
  });
});

describe("tickPlace", () => {
  it("keeps a layer tick 5 px inside the track, so the first, the last and an after-the-end tick show whole", () => {
    expect(tickPlace(10, 40)).toBe("clamp(5px, 25.000%, calc(100% - 5px))");
    expect(tickPlace(0, 40)).toBe("clamp(5px, 0.000%, calc(100% - 5px))");
    expect(tickPlace(45, 40)).toBe("clamp(5px, 100.000%, calc(100% - 5px))");
  });
});

describe("cueKeys", () => {
  it("is each cue's id, with a suffix for a repeated id (Mix merges passes), so a replaced cue is a new element", () => {
    expect(cueKeys([{ id: "thud" }, { id: "whoosh" }, { id: "thud" }, { id: "thud" }])).toEqual(["thud", "whoosh", "thud#2", "thud#3"]);
    expect(cueKeys([{ id: "a" }, { id: "b" }])).not.toEqual(cueKeys([{ id: "a" }, { id: "c" }]));
  });
});

describe("cardPosition (§23.5, Review Focus 4)", () => {
  const view = { width: 1440, height: 900 };
  const card = { width: 240, height: 80 };
  it("sits under its cue, centred on it, 8 px away", () => {
    expect(cardPosition({ left: 600, top: 300, width: 6, height: 20 }, card, view)).toEqual({ left: 483, top: 328 });
  });
  it("goes above when there's no room below", () => {
    expect(cardPosition({ left: 600, top: 820, width: 6, height: 20 }, card, view)).toEqual({ left: 483, top: 732 });
  });
  it("stays 16 px inside the window at every edge", () => {
    expect(cardPosition({ left: 2, top: 300, width: 6, height: 20 }, card, view).left).toBe(16);
    expect(cardPosition({ left: 1436, top: 300, width: 6, height: 20 }, card, view).left).toBe(1440 - 16 - 240);
    expect(cardPosition({ left: 600, top: 4, width: 6, height: 20 }, { width: 240, height: 2000 }, view).top).toBe(16);
  });
});
