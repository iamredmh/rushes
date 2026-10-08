import { describe, expect, it } from "vitest";
import { CUE_FILE_EXT, CUE_FILE_MAX, checkCueFile, cueFiles, isCueFile } from "../../src/core/cues.js";
import { InvalidError } from "../../src/core/errors.js";
import { addVariant } from "../../src/core/project.js";
import { CueSchema, ProjectSchema, type Project } from "../../src/core/schema.js";
import { OUTSIDE_MEDIA_EXT, contentType } from "../../src/server/files.js";

const empty = (): Project => ({ schema: 1, rev: 0, name: "demo", fps: 30, videos: [], lanes: [], files: [], autoProxy: false });

describe("cue files (§23.3)", () => {
  it("are audio files of at most 1024 characters", () => {
    for (const ok of ["sfx/thud_low_03.wav", "SFX/Whoosh.WAV", "/Volumes/Library Drive/sfx/pop.aiff", "a.mp3", "b.m4a", "c.aac", "d.aif", "e.flac", "f.ogg", "g.opus", `${"a".repeat(1020)}.wav`]) {
      expect(isCueFile(ok), ok).toBe(true);
    }
    for (const bad of ["", "notes.json", ".rushes/notes.json", "id_ed25519", "sfx/thud", ".wav", "render.mp4", "sheet.pdf", "a.wav\0.json", `${"a".repeat(1021)}.wav`]) {
      expect(isCueFile(bad), bad).toBe(false);
    }
    expect(CUE_FILE_MAX).toBe(1024);
  });

  it("are the audio half of §15.5's outside-the-project list, served as audio", () => {
    for (const ext of CUE_FILE_EXT) {
      expect(OUTSIDE_MEDIA_EXT.has(ext), ext).toBe(true);
      expect(contentType(`x.${ext}`), ext).toMatch(/^audio\//);
    }
  });

  it("checkCueFile returns the file, or says which cue and why", () => {
    expect(checkCueFile("thud", "sfx/thud.wav")).toBe("sfx/thud.wav");
    expect(() => checkCueFile("thud", "notes.json")).toThrow(InvalidError);
    expect(() => checkCueFile("thud", "notes.json")).toThrow('Cue "thud": "notes.json" isn\'t an audio file. Send a .wav, .mp3, .m4a, .aac, .aif, .aiff, .flac, .ogg or .opus.');
    expect(() => checkCueFile("thud", `${"a".repeat(1021)}.wav`)).toThrow('Cue "thud": its file path is over 1024 characters');
  });
});

describe("addVariant with cue files", () => {
  it("keeps a cue's file only when one is sent", () => {
    const p = empty();
    const { variant } = addVariant(p, { stage: "sfx", name: "Pass A", file: "pass.wav", cues: [{ name: "thud", t: 1, file: "sfx/thud.wav" }, { name: "click", t: 2 }] });
    expect(variant.cues).toEqual([{ id: "thud", name: "thud", t: 1, file: "sfx/thud.wav" }, { id: "click", name: "click", t: 2 }]);
    expect("file" in variant.cues[1]).toBe(false);
  });

  it("refuses a cue file that isn't audio before it touches the project, even a new lane", () => {
    const p = empty();
    expect(() => addVariant(p, { stage: "sfx", lane: "fx", name: "Pass B", file: "b.wav", cues: [{ name: "key", t: 1, file: "id_ed25519" }] })).toThrow(/Cue "key"/);
    expect(p.lanes).toEqual([]);
  });
});

describe("the stored field", () => {
  it("a 0.2.2 project's cues load and write back exactly as they were", () => {
    const saved = {
      ...empty(),
      lanes: [{ id: "sfx", stage: "sfx", name: "Sound effects", variants: [{ id: "pass-a", name: "Pass A", file: "audio/sfx/pass-a.wav", meta: {}, cues: [{ id: "swipe", name: "Swipe", t: 1.5 }] }] }],
    };
    const parsed = ProjectSchema.parse(JSON.parse(JSON.stringify(saved)));
    expect(JSON.stringify(parsed.lanes)).toBe(JSON.stringify(saved.lanes));
  });

  it("CueSchema takes an optional file of 1 to 1024 characters", () => {
    expect(CueSchema.parse({ id: "a", name: "a", t: 0, file: "sfx/a.wav" }).file).toBe("sfx/a.wav");
    // toEqual would pass with `file: undefined`; the key itself must be absent.
    expect(Object.keys(CueSchema.parse({ id: "a", name: "a", t: 0 }))).toEqual(["id", "name", "t"]);
    expect(CueSchema.safeParse({ id: "a", name: "a", t: 0, file: "" }).success).toBe(false);
    expect(CueSchema.safeParse({ id: "a", name: "a", t: 0, file: `${"a".repeat(1021)}.wav` }).success).toBe(false);
  });
});

describe("cueFiles", () => {
  it("lists each audio cue file once, in manifest order, and leaves out a hand-edited one that isn't audio", () => {
    const p = empty();
    addVariant(p, { stage: "sfx", name: "A", file: "a.wav", cues: [{ name: "thud", t: 1, file: "sfx/thud.wav" }, { name: "thud", t: 2, file: "sfx/thud.wav" }, { name: "pop", t: 3, file: "sfx/pop.wav" }] });
    addVariant(p, { stage: "sfx", name: "B", file: "b.wav", cues: [{ name: "tick", t: 1 }] });
    p.lanes[0].variants[1].cues[0].file = ".rushes/notes.json"; // a hand edit
    expect(cueFiles(p)).toEqual(["sfx/thud.wav", "sfx/pop.wav"]);
  });
});
