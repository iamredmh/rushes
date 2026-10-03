import { describe, expect, it } from "vitest";
import {
  boxFrom, cueRoom, defaultVersion, extOf, firstTab, fit, FOLDERS, fmt, folderItems, formatBytes, frameAt, groupByFilm,
  isChanged, isPreviewable, latest, metaLine, neighbourVideo, noteTime, OPEN_SAFE_EXT, placeNote, shotAt, shotLabel, shotSeek, snap, stepFrame,
} from "../../web/src/lib.js";
import type { Asset, Note, Section, Shot, TabState, Video } from "../../web/src/types.js";
// Only this test imports the server's own list, so the web copy (ruling 1) is never pulled
// into the web bundle -- this is purely to assert the two stay equal.
import { OPEN_SAFE_EXT as SERVER_OPEN_SAFE_EXT } from "../../src/server/reveal.js";
import { markLabel as serverMarkLabel, type Mark } from "../../src/core/schema.js";
import {
  AUDIO_CHIPS, BUILT, blindOrder, laneSelection, markLabel, marksLabel, scopeOptions, setMarkDb, testFlags, toggleMark, variantMeta,
  variantNoteRow, variantNoteTarget, variantOnLabel, variantOnOptions, variantRows,
} from "../../web/src/lib.js";
import type { Lane } from "../../web/src/types.js";
import { mixInputs } from "../../src/server/loudness.js";
import type { Picks, Project } from "../../src/core/schema.js";
import { tmpProject } from "../helpers/tmp.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  heardVoice, onOptionGroups, sectionLabel, voiceDefaultRead, voiceListening, voiceNoteRows, voiceOnLabel, voiceOnOptions, voiceRounds,
} from "../../web/src/lib.js";

/** A read with only an id: its name is the id, its file `media/<id>.wav`. */
const v = (id: string) => ({ id, name: id, file: `media/${id}.wav`, meta: {}, cues: [] });

const note = (over: Partial<Note>): Note => ({
  id: "n_1", stage: "picture", video: "hero", version: "v3", on: null, scope: "point", t: 12.4, tOut: null, frame: null,
  text: "x", box: null, grab: null, shot: null, marks: [], status: "todo", reply: "", fixT: null, fixVersion: null, batch: null,
  createdAt: "2026-10-02T00:00:00Z", by: "user", ...over,
});

describe("timecode", () => {
  it("formats minutes, seconds and hundredths", () => {
    expect(fmt(0)).toBe("0:00.00");
    expect(fmt(12.4)).toBe("0:12.40");
    expect(fmt(72.456)).toBe("1:12.46");
    expect(fmt(-3)).toBe("0:00.00");
  });
  it("carries into the next minute instead of showing 60 seconds", () => {
    expect(fmt(59.999)).toBe("1:00.00");
    expect(fmt(119.996)).toBe("2:00.00");
    expect(fmt(3599.999)).toBe("60:00.00");
    expect(fmt(59.994)).toBe("0:59.99");
  });
  it("finds frames and steps by one frame, clamped", () => {
    expect(frameAt(12.4, 60)).toBe(744);
    expect(stepFrame(12.4, 60, 1, 60)).toBeCloseTo(745 / 60, 6);
    expect(stepFrame(0, 30, -1, 10)).toBe(0);
    expect(stepFrame(9.99, 30, 5, 10)).toBe(10);
  });
  it("snaps a time to the start of its frame", () => {
    expect(snap(0.9666667, 30)).toBe(0.966667);
    expect(snap(1.01, 30)).toBe(1);
    expect(snap(12.4, 60)).toBe(12.4);
  });
  it("labels points, ranges and whole-track notes", () => {
    expect(noteTime(31.05, 33.1)).toBe("0:31.05–0:33.10");
    expect(noteTime(4.6, null)).toBe("0:04.60");
    expect(noteTime(null, null)).toBe("Whole");
  });
});

describe("placeNote", () => {
  it("leaves a note on the version being watched where it is", () => {
    expect(placeNote(note({}), "v3")).toEqual({ t: 12.4, tOut: null, from: null });
  });
  it("moves a fixed note from an older cut to where the fix landed, keeping a range's length", () => {
    const n = note({ version: "v2", t: 4.1, tOut: 5.1, scope: "range", fixT: 4.6, fixVersion: "v3" });
    const placed = placeNote(n, "v3");
    expect(placed.t).toBe(4.6);
    expect(placed.tOut).toBeCloseTo(5.6, 6);
    expect(placed.from).toBe("v2 at 0:04.10");
  });
  it("keeps an unfixed note from an older cut at its old time, and says where it's from", () => {
    expect(placeNote(note({ version: "v1", t: 2 }), "v3")).toEqual({ t: 2, tOut: null, from: "v1 at 0:02.00" });
  });
  it("has no time for a whole-track note", () => {
    expect(placeNote(note({ scope: "whole", t: null }), "v3")).toEqual({ t: null, tOut: null, from: null });
  });
});

describe("fit", () => {
  it("matches the server's thresholds", () => {
    expect(fit("one two three", 13, 2.6).state).toBe("ok");
    expect(fit("one two three four five six seven eight nine ten", 4.5, 2.6).state).toBe("tight");
    expect(fit("a b c d e f g h i j k l m n o p q r s t u v w", 8, 2.6).state).toBe("over");
  });
});

describe("firstTab", () => {
  const tabs = (unlocked: string[]): TabState[] =>
    (["script", "picture", "voice", "music", "sfx", "mix"] as const).map((stage) => ({ stage, unlocked: unlocked.includes(stage), todo: 0 }));
  it("prefers Picture, then the first unlocked tab, then Picture", () => {
    expect(firstTab(tabs(["script", "picture"]))).toBe("picture");
    expect(firstTab(tabs(["script"]))).toBe("script");
    expect(firstTab(tabs([]))).toBe("picture");
  });
});

describe("boxFrom", () => {
  it("normalises a drag in any direction and clamps it to the frame", () => {
    expect(boxFrom(100, 50, 300, 150, 400, 200)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom(300, 150, 100, 50, 400, 200)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom(-50, -50, 500, 300, 400, 200)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("isChanged and latest", () => {
  const sec = (current: string, proposed: string | null): Section =>
    ({ id: "s1", start: 0, end: 5, current, proposed, direction: "", status: "draft", takes: [] });
  it("counts a row as changed only when your version differs, ignoring surrounding spaces", () => {
    expect(isChanged(sec("Line.", null))).toBe(false);
    expect(isChanged(sec("Line.", " Line. "))).toBe(false);
    expect(isChanged(sec("Line.", "New line."))).toBe(true);
  });
  it("picks a video's newest version", () => {
    const v = (id: string) => ({ id, file: `${id}.mp4`, duration: null, fps: null, addedAt: "", note: "", shots: [] });
    expect(latest({ id: "hero", name: "Hero", versions: [v("v1"), v("v2")], lockedVersion: null })?.id).toBe("v2");
    expect(latest({ id: "hero", name: "Hero", versions: [], lockedVersion: null })).toBeUndefined();
    expect(latest(undefined)).toBeUndefined();
  });
});

describe("defaultVersion", () => {
  const v = (id: string) => ({ id, file: `${id}.mp4`, duration: null, fps: null, addedAt: "", note: "", shots: [] });
  it("follows the newest version when nothing is locked", () => {
    const video: Video = { id: "hero", name: "Hero", versions: [v("v1"), v("v2")], lockedVersion: null };
    expect(defaultVersion(video)?.id).toBe("v2");
  });
  it("opens on the locked version instead of the newest", () => {
    const video: Video = { id: "hero", name: "Hero", versions: [v("v1"), v("v2"), v("v3")], lockedVersion: "v1" };
    expect(defaultVersion(video)?.id).toBe("v1");
  });
  it("falls back to the newest if the locked version no longer exists", () => {
    const video: Video = { id: "hero", name: "Hero", versions: [v("v1"), v("v2")], lockedVersion: "v9" };
    expect(defaultVersion(video)?.id).toBe("v2");
  });
  it("is undefined for a video with no versions, locked or not", () => {
    expect(defaultVersion({ id: "hero", name: "Hero", versions: [], lockedVersion: null })).toBeUndefined();
    expect(defaultVersion(undefined)).toBeUndefined();
  });
});

describe("shotLabel", () => {
  it("zero-pads to 2 digits", () => {
    expect(shotLabel(2)).toBe("02");
    expect(shotLabel(12)).toBe("12");
  });
  it("widens to 3 digits once n reaches 100", () => {
    expect(shotLabel(100)).toBe("100");
  });
});

describe("shotSeek", () => {
  it("seeks to the first frame at or after a shot's start, not the frame before it", () => {
    // 1.71s falls between frame 51 (1.7) and 52 (1.7333...) at 30fps: the frame before it
    // (1.7) is still the previous shot, so the seek must land on 52, not snap back to 51.
    expect(shotSeek(1.71, 30)).toBeCloseTo(52 / 30, 6);
  });
  it("leaves an exact frame boundary alone, rather than pushing it a frame later", () => {
    expect(shotSeek(1.7, 30)).toBeCloseTo(51 / 30, 6);
    expect(shotSeek(0, 30)).toBeCloseTo(0, 6);
  });
});

describe("shotAt (web)", () => {
  const shots: Shot[] = [
    { n: 1, name: "Wide", start: 2, tag: "" },
    { n: 2, name: "Close", start: 5, tag: "" },
  ];
  it("returns null when t is before the first shot's start", () => {
    expect(shotAt(shots, 1)).toBeNull();
  });
  it("returns a shot exactly at its start", () => {
    expect(shotAt(shots, 5)).toEqual({ n: 2, name: "Close" });
  });
  it("returns the last shot when t is after the last start", () => {
    expect(shotAt(shots, 99)).toEqual({ n: 2, name: "Close" });
  });
  it("returns null for an empty list", () => {
    expect(shotAt([], 5)).toBeNull();
  });
});

describe("formatBytes", () => {
  it("prints bytes under 1 KB as a whole number", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });
  it("prints KB as a whole number, rounded", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1600)).toBe("2 KB");
  });
  it("prints MB and GB with one decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

describe("metaLine", () => {
  it("joins the lane name with each meta entry, a numeric one gaining its key as a unit suffix", () => {
    expect(metaLine("Main bed", { bpm: 120, key: "A minor" })).toBe("Main bed · 120 BPM · A minor");
  });
  it("is just the lane name when there's no meta", () => {
    expect(metaLine("Main bed")).toBe("Main bed");
    expect(metaLine("Main bed", {})).toBe("Main bed");
  });
  it("is just the meta when there's no lane name", () => {
    expect(metaLine(undefined, { bpm: 120 })).toBe("120 BPM");
  });
  it("is null when there's neither", () => {
    expect(metaLine()).toBeNull();
  });
});

describe("extOf / isPreviewable", () => {
  it("lower-cases an extension and drops the dot", () => {
    expect(extOf("a.MP4")).toBe("mp4");
    expect(extOf("brief.md")).toBe("md");
  });
  it("is empty for a name with no extension", () => {
    expect(extOf("noext")).toBe("");
  });
  it("is previewable only for md, txt, srt and vtt", () => {
    expect(isPreviewable({ path: "script.md" })).toBe(true);
    expect(isPreviewable({ path: "notes.txt" })).toBe(true);
    expect(isPreviewable({ path: "en.srt" })).toBe(true);
    expect(isPreviewable({ path: "en.vtt" })).toBe(true);
    expect(isPreviewable({ path: "brief.pdf" })).toBe(false);
    expect(isPreviewable({ path: "x.command" })).toBe(false);
  });
  it("reads the extension from path, not a registered file's display name (I2)", () => {
    // A registered file's display name can be anything ("Creative brief") and carries no
    // extension at all once it's shown under `label` instead of `name` -- isPreviewable must
    // never be fooled into thinking it's a non-previewable type (or vice versa).
    expect(isPreviewable({ path: "docs/brief.md" })).toBe(true);
  });
});

describe("OPEN_SAFE_EXT (web copy)", () => {
  it("matches the server's OPEN_SAFE_EXT (src/server/reveal.ts) exactly, with no svg", () => {
    expect([...OPEN_SAFE_EXT].sort()).toEqual([...SERVER_OPEN_SAFE_EXT].sort());
    expect(OPEN_SAFE_EXT.has("svg")).toBe(false);
  });
});

describe("FOLDERS", () => {
  it("lists the §16.1 folders in order, with Exports film-filter-free and Cuts/Delivery/Screenshots film-filtered", () => {
    expect(FOLDERS.map((f) => f.title)).toEqual([
      "Screenshots", "Cuts", "Voiceover", "Music", "Sound effects",
      "Scripts & docs", "Images", "Captions", "Exports", "Delivery", "Edit files",
    ]);
    expect(FOLDERS.find((f) => f.id === "export")?.filmFilter).toBe(false);
    expect(FOLDERS.find((f) => f.id === "cut")?.filmFilter).toBe(true);
    expect(FOLDERS.find((f) => f.id === "delivery")?.filmFilter).toBe(true);
  });
  it("only offers the grid/list toggle for Screenshots, Images, Cuts and Delivery (I5)", () => {
    const withToggle = FOLDERS.filter((f) => f.gridToggle).map((f) => f.id).sort();
    expect(withToggle).toEqual(["cut", "delivery", "image", "screenshot"].sort());
    expect(FOLDERS.find((f) => f.id === "music")?.gridToggle).toBe(false);
  });
});

describe("folderItems", () => {
  const asset = (over: Partial<Asset>): Asset => ({
    kind: "screenshot",
    path: "screenshots/a.png",
    abs: "/tmp/a.png",
    name: "a.png",
    size: 100,
    modified: "2026-10-02T00:00:00Z",
    missing: false,
    ...over,
  });
  const videos: Video[] = [
    { id: "hero", name: "Hero", versions: [{ id: "v1", file: "renders/hero_v1.mp4", duration: null, fps: null, addedAt: "2026-10-01T00:00:00Z", note: "First pass", shots: [] }], lockedVersion: null },
    { id: "cutdown", name: "Cutdown", versions: [], lockedVersion: null },
  ];

  it("narrows to one folder's kinds", () => {
    const assets = [asset({ kind: "screenshot" }), asset({ kind: "cut", name: "c.mp4" })];
    const folder = FOLDERS.find((f) => f.id === "screenshot")!;
    expect(folderItems(assets, folder).map((a) => a.kind)).toEqual(["screenshot"]);
  });

  it("filters by film (video id)", () => {
    const assets = [
      asset({ kind: "screenshot", name: "h.png", video: "hero" }),
      asset({ kind: "screenshot", name: "c.png", video: "cutdown" }),
    ];
    const folder = FOLDERS.find((f) => f.id === "screenshot")!;
    expect(folderItems(assets, folder, { film: "hero" }).map((a) => a.name)).toEqual(["h.png"]);
    expect(folderItems(assets, folder, { film: null }).map((a) => a.name)).toEqual(["h.png", "c.png"]);
  });

  it("searches by name, path, the file's own note, the version note and the film name", () => {
    const folder = FOLDERS.find((f) => f.id === "cut")!;
    const assets = [
      asset({ kind: "cut", name: "hero_v1.mp4", path: "renders/hero_v1.mp4", video: "hero", version: "v1" }),
      asset({ kind: "cut", name: "cutdown_v1.mp4", path: "renders/cutdown_v1.mp4", video: "cutdown", version: "v9" }),
    ];
    expect(folderItems(assets, folder, { query: "hero_v1", videos }).map((a) => a.name)).toEqual(["hero_v1.mp4"]);
    expect(folderItems(assets, folder, { query: "renders/cutdown", videos }).map((a) => a.name)).toEqual(["cutdown_v1.mp4"]);
    expect(folderItems(assets, folder, { query: "first pass", videos }).map((a) => a.name)).toEqual(["hero_v1.mp4"]);
    expect(folderItems(assets, folder, { query: "Hero", videos }).map((a) => a.name)).toEqual(["hero_v1.mp4"]);
  });

  it("searches a registered file's own note", () => {
    const folder = FOLDERS.find((f) => f.id === "doc")!;
    const assets = [asset({ kind: "doc", name: "brief.md", note: "Client-facing brief" })];
    expect(folderItems(assets, folder, { query: "client-facing" }).map((a) => a.name)).toEqual(["brief.md"]);
    expect(folderItems(assets, folder, { query: "nope" })).toEqual([]);
  });

  it("sorts newest first by default, oldest first, or by name", () => {
    const folder = FOLDERS.find((f) => f.id === "doc")!;
    const assets = [
      asset({ kind: "doc", name: "b.md", modified: "2026-10-02T00:00:00Z" }),
      asset({ kind: "doc", name: "a.md", modified: "2026-10-03T00:00:00Z" }),
    ];
    expect(folderItems(assets, folder).map((a) => a.name)).toEqual(["a.md", "b.md"]);
    expect(folderItems(assets, folder, { sort: "oldest" }).map((a) => a.name)).toEqual(["b.md", "a.md"]);
    expect(folderItems(assets, folder, { sort: "name" }).map((a) => a.name)).toEqual(["a.md", "b.md"]);
  });
});

describe("groupByFilm", () => {
  const asset = (over: Partial<Asset>): Asset => ({
    kind: "screenshot",
    path: "screenshots/a.png",
    abs: "/tmp/a.png",
    name: "a.png",
    size: 100,
    modified: "2026-10-02T00:00:00Z",
    missing: false,
    ...over,
  });
  const videos: Video[] = [
    { id: "hero", name: "Hero", versions: [], lockedVersion: null },
    { id: "cutdown", name: "Cutdown", versions: [], lockedVersion: null },
  ];

  it("builds 'Film · vN' headings, keeping consecutive same-film-and-version items together", () => {
    const items = [
      asset({ name: "h1.png", video: "hero", version: "v1" }),
      asset({ name: "h2.png", video: "hero", version: "v1" }),
      asset({ name: "c1.png", video: "cutdown", version: "v2" }),
    ];
    const groups = groupByFilm(items, videos);
    expect(groups.map((g) => g.heading)).toEqual(["Hero · v1", "Cutdown · v2"]);
    expect(groups[0].items.map((a) => a.name)).toEqual(["h1.png", "h2.png"]);
    expect(groups[1].items.map((a) => a.name)).toEqual(["c1.png"]);
  });

  it("merges every item under one heading even when they're not adjacent, rather than fragmenting into repeated groups", () => {
    // Newest-first input: h1 (newest Hero·v1), c1 (Cutdown·v2) interleaved between two more
    // Hero·v1 items. Fragmenting on adjacency alone would produce three groups (Hero·v1,
    // Cutdown·v2, Hero·v1 again); grouping by heading must produce exactly two, the Hero one
    // ordered first because its newest item (h1) came first in the input.
    const items = [
      asset({ name: "h1.png", video: "hero", version: "v1" }),
      asset({ name: "c1.png", video: "cutdown", version: "v2" }),
      asset({ name: "h2.png", video: "hero", version: "v1" }),
      asset({ name: "c2.png", video: "cutdown", version: "v2" }),
      asset({ name: "h3.png", video: "hero", version: "v1" }),
    ];
    const groups = groupByFilm(items, videos);
    expect(groups.map((g) => g.heading)).toEqual(["Hero · v1", "Cutdown · v2"]);
    expect(groups[0].items.map((a) => a.name)).toEqual(["h1.png", "h2.png", "h3.png"]);
    expect(groups[1].items.map((a) => a.name)).toEqual(["c1.png", "c2.png"]);
  });

  it("gives an item with no film/version a null heading", () => {
    const groups = groupByFilm([asset({ name: "x.png" })], videos);
    expect(groups).toEqual([{ heading: null, items: [expect.objectContaining({ name: "x.png" })] }]);
  });
});

describe("neighbourVideo", () => {
  const videos: Video[] = [
    { id: "hero", name: "Hero", versions: [], lockedVersion: null },
    { id: "cutdown", name: "Cutdown", versions: [], lockedVersion: null },
    { id: "teaser", name: "Teaser", versions: [], lockedVersion: null },
  ];
  it("steps to the next and previous film", () => {
    expect(neighbourVideo(videos, "hero", 1)).toBe("cutdown");
    expect(neighbourVideo(videos, "cutdown", 1)).toBe("teaser");
    expect(neighbourVideo(videos, "cutdown", -1)).toBe("hero");
  });
  it("doesn't wrap at either end", () => {
    expect(neighbourVideo(videos, "hero", -1)).toBeNull();
    expect(neighbourVideo(videos, "teaser", 1)).toBeNull();
  });
  it("is null when the current id isn't found", () => {
    expect(neighbourVideo(videos, "nope", 1)).toBeNull();
    expect(neighbourVideo(videos, null, 1)).toBeNull();
  });
});

describe("audio tabs: marks", () => {
  it("labels marks exactly as the server does", () => {
    const all: Mark[] = [{ kind: "rise" }, { kind: "fall" }, { kind: "louder", db: 3 }, { kind: "quieter", db: 6 }, { kind: "quieter", db: 1.5 }];
    for (const m of all) expect(markLabel(m)).toBe(serverMarkLabel(m));
    expect(marksLabel([{ kind: "fall" }, { kind: "quieter", db: 3 }])).toBe("Fall · Quieter 3 dB");
    expect(marksLabel([])).toBeNull();
    expect(marksLabel(undefined)).toBeNull();
  });
  it("toggles marks, keeping Rise/Fall and Louder/Quieter exclusive but combinable", () => {
    let m = toggleMark([], "fall");
    expect(m).toEqual([{ kind: "fall" }]);
    m = toggleMark(m, "quieter");
    expect(m).toEqual([{ kind: "fall" }, { kind: "quieter", db: 3 }]);
    m = toggleMark(m, "rise");
    expect(m).toEqual([{ kind: "rise" }, { kind: "quieter", db: 3 }]);
    m = toggleMark(m, "louder", 6);
    expect(m).toEqual([{ kind: "rise" }, { kind: "louder", db: 6 }]);
    m = toggleMark(m, "louder");
    expect(m).toEqual([{ kind: "rise" }]);
    expect(toggleMark(m, "rise")).toEqual([]);
  });
  it("changes the dB on an active Louder or Quieter only", () => {
    const m: Mark[] = [{ kind: "fall" }, { kind: "quieter", db: 3 }];
    expect(setMarkDb(m, "quieter", 9)).toEqual([{ kind: "fall" }, { kind: "quieter", db: 9 }]);
    expect(setMarkDb(m, "fall", 9)).toEqual(m);
  });
});

describe("scopeOptions", () => {
  it("keeps the given order and drops unknown scopes", () => {
    expect(scopeOptions(["whole", "point"])).toEqual([{ value: "whole", label: "Whole" }, { value: "point", label: "Point" }]);
    expect(scopeOptions(undefined).map((s) => s.value)).toEqual(["point", "range", "whole"]);
  });
});

describe("audio tabs: lanes", () => {
  const lanes: Lane[] = [
    { id: "music", stage: "music", name: "Music", variants: [
      { id: "a", name: "A · Deep house", file: "a.wav", meta: { bpm: 120, key: "A minor" }, cues: [] },
      { id: "b", name: "B · Warm keys", file: "b.wav", meta: { description: "Soft and warm", bpm: 104 }, cues: [] },
    ] },
    { id: "sfx", stage: "sfx", name: "Sound effects", variants: [
      { id: "pass-a", name: "Pass A", file: "pa.wav", meta: { description: "Subtle" }, cues: [{ id: "swipe", name: "Swipe", t: 1.5 }, { id: "tap", name: "Tap", t: 0.5 }] },
      { id: "pass-b", name: "Pass B", file: "pb.wav", meta: {}, cues: [{ id: "swipe", name: "Swipe", t: 1.6 }] },
    ] },
  ];
  it("turns on Music and Sound effects", () => {
    expect(BUILT.music).toBe(true);
    expect(BUILT.sfx).toBe(true);
    expect(AUDIO_CHIPS.music).toEqual(["Tempo", "Key", "Energy", "Ending"]);
    expect(AUDIO_CHIPS.sfx).toEqual(["Timing", "Level", "Swap sound", "Remove"]);
  });
  it("makes one row per variant in manifest order, with description or BPM · key", () => {
    const rows = variantRows(lanes, "music");
    expect(rows.map((r) => r.key)).toEqual(["music/a", "music/b"]);
    expect(rows.map((r) => r.meta)).toEqual(["120 BPM · A minor", "Soft and warm"]);
    expect(variantRows(lanes, "sfx").map((r) => r.meta)).toEqual(["Subtle · 2 cues", "1 cue"]);
    expect(variantMeta(undefined)).toBeNull();
  });
  it("lists passes then cues in the On menu, telling same-named cues apart", () => {
    const rows = variantRows(lanes, "sfx");
    const opts = variantOnOptions(rows, (r) => r.name, true);
    expect(opts.map((o) => o.label)).toEqual(["Pass A", "Pass B", "Cue · Swipe", "Cue · Tap", "Cue · Swipe · Pass B"]);
    // Lane-qualified (I3): "<lane>/<pass>" for a pass, "<lane>/<pass>:<cue>" for a cue.
    expect(opts[0]).toMatchObject({ on: "sfx/pass-a", row: "sfx/pass-a" });
    expect(opts[2]).toMatchObject({ on: "sfx/pass-a:swipe", t: 1.5, row: "sfx/pass-a" });
    expect(opts[4]).toMatchObject({ on: "sfx/pass-b:swipe", t: 1.6, row: "sfx/pass-b" });
    expect(variantOnOptions(rows, (r) => r.name).length).toBe(2);
  });
  it("draws a lane-qualified note on its exact variant or cue", () => {
    const sfx = variantRows(lanes, "sfx");
    expect(variantNoteRow(sfx, "sfx/pass-b")).toBe("sfx/pass-b");
    expect(variantNoteTarget(sfx, "sfx/pass-b:swipe")).toEqual({ row: "sfx/pass-b", cue: "swipe" });
    expect(variantNoteTarget(sfx, "sfx/pass-a:tap")).toEqual({ row: "sfx/pass-a", cue: "tap" });
    // A qualified cue the pass no longer has, or an unknown lane, is never drawn on some other pass.
    expect(variantNoteRow(sfx, "sfx/pass-b:tap")).toBeNull();
    expect(variantNoteRow(sfx, "other/pass-b")).toBeNull();
  });
  it("tells apart same-named variants on two lanes of one stage (I3)", () => {
    const two: Lane[] = [
      { id: "bed", stage: "music", name: "Bed", variants: [{ id: "a", name: "A", file: "bed-a.wav", meta: {}, cues: [] }] },
      { id: "sting", stage: "music", name: "Sting", variants: [{ id: "a", name: "A", file: "sting-a.wav", meta: {}, cues: [] }] },
    ];
    const rows = variantRows(two, "music");
    expect(variantOnOptions(rows, (r) => r.laneName).map((o) => o.on)).toEqual(["bed/a", "sting/a"]);
    expect(variantNoteRow(rows, "sting/a")).toBe("sting/a");
    expect(variantNoteRow(rows, "bed/a")).toBe("bed/a");
    // A legacy bare id still draws where it always did: the first row with it.
    expect(variantNoteRow(rows, "a")).toBe("bed/a");
  });
  it("still draws an older note's bare variant id, bare pass:cue or bare cue where it always did", () => {
    const sfx = variantRows(lanes, "sfx");
    expect(variantNoteRow(sfx, "pass-b")).toBe("sfx/pass-b");
    expect(variantNoteRow(sfx, "pass-b:swipe")).toBe("sfx/pass-b");
    expect(variantNoteRow(sfx, "pass-a:swipe")).toBe("sfx/pass-a");
    // An older bare cue id: the first pass holding it.
    expect(variantNoteRow(sfx, "tap")).toBe("sfx/pass-a");
    expect(variantNoteRow(sfx, "swipe")).toBe("sfx/pass-a");
    // A pass-qualified cue the pass no longer has is not drawn on some other pass.
    expect(variantNoteRow(sfx, "pass-b:tap")).toBeNull();
    expect(variantNoteRow(sfx, null)).toBeNull();
    expect(variantNoteRow(sfx, "nope")).toBeNull();
  });
  it("labels what a note is on, naming the pass when two share a cue", () => {
    const sfx = variantRows(lanes, "sfx");
    const opts = variantOnOptions(sfx, (r) => r.name, true);
    expect(variantOnLabel(sfx, opts, "sfx/pass-b:swipe")).toBe("Cue · Swipe · Pass B");
    expect(variantOnLabel(sfx, opts, "sfx/pass-a:swipe")).toBe("Cue · Swipe");
    expect(variantOnLabel(sfx, opts, "sfx/pass-b")).toBe("Pass B");
    expect(variantOnLabel(sfx, opts, "pass-b:swipe")).toBe("Cue · Swipe · Pass B");
    expect(variantOnLabel(sfx, opts, "pass-a:swipe")).toBe("Cue · Swipe");
    expect(variantOnLabel(sfx, opts, "swipe")).toBe("Cue · Swipe");
    expect(variantOnLabel(sfx, opts, "pass-b")).toBe("Pass B");
    expect(variantOnLabel(sfx, opts, "gone")).toBeNull();
    expect(variantNoteTarget(sfx, "pass-b:swipe")).toEqual({ row: "sfx/pass-b", cue: "swipe" });
  });
  it("falls back to the first in manifest order, whatever the display order", () => {
    const shown = [
      { key: "c", audition: { lane: "m", clip: "c" }, order: 2 },
      { key: "a", audition: { lane: "m", clip: "a" }, order: 0 },
      { key: "b", audition: { lane: "m", clip: "b" }, order: 1 },
    ];
    expect(laneSelection(shown, null)).toEqual({ m: "a" });
    expect(laneSelection([{ ...shown[0] }, { ...shown[2], picked: true }, shown[1]], null)).toEqual({ m: "b" });
  });
  it("hears the selected row, else the pick, else the first, per engine lane", () => {
    const rows = [
      { key: "a", audition: { lane: "m", clip: "a" } },
      { key: "b", audition: { lane: "m", clip: "b" }, picked: true },
      { key: "x", audition: { lane: "s", clip: "x" } },
      { key: "read" },
    ];
    expect(laneSelection(rows, null)).toEqual({ m: "b", s: "x" });
    expect(laneSelection(rows, "a")).toEqual({ m: "a", s: "x" });
    expect(laneSelection(rows, "read")).toEqual({ m: "b", s: "x" });
  });
  it("shuffles for Blind stably, as a permutation", () => {
    const keys = ["a", "b", "c", "d", "e", "f"];
    const one = blindOrder(keys, 7);
    expect([...one].sort()).toEqual(keys);
    expect(blindOrder(keys, 7)).toEqual(one);
    const seeds = [1, 2, 3, 4, 5].map((s) => blindOrder(keys, s).join(""));
    expect(new Set(seeds).size).toBeGreaterThan(1);
  });
  it("reads the test switches only with test=1", () => {
    expect(testFlags("")).toEqual({ test: false, streamOver: false });
    expect(testFlags("?test=1")).toEqual({ test: true, streamOver: false });
    expect(testFlags("?test=1&streamOver=1")).toEqual({ test: true, streamOver: true });
    expect(testFlags("?streamOver=1")).toEqual({ test: false, streamOver: false });
  });
});

describe("Voiceover", () => {
  it("turns on Voiceover", () => {
    expect(BUILT.voice).toBe(true);
  });
  it("keeps Voiceover's chips as the Whole chips Voice shows (§18.3), not the old §17.1 set", () => {
    expect(AUDIO_CHIPS.voice).toEqual(["Speaker", "Pacing", "Tone", "Overall"]);
  });
  it("names sections, for older notes", () => {
    expect(sectionLabel("s2")).toBe("S2");
  });
});

describe("voiceRounds (§18.2)", () => {
  const lanes = [
    { id: "round-1", stage: "voice", name: "Round 1 · Voices", variants: [v("jane"), v("louise"), v("gerald")] },
    { id: "music", stage: "music", name: "Music", variants: [v("a")] },
    { id: "round-2", stage: "voice", name: "Round 2 · Gerald, tone", variants: [v("excited"), v("sombre")] },
  ] as Lane[];
  it("orders rounds by creation and marks the last current", () => {
    const r = voiceRounds(lanes, { "round-1": "gerald" });
    expect(r.map((x) => [x.id, x.current, x.pick])).toEqual([["round-1", false, "gerald"], ["round-2", true, null]]);
  });
  it("hears the newest round's pick, walking back past rounds with none", () => {
    expect(heardVoice(voiceRounds(lanes, { "round-1": "gerald" }))?.variant).toBe("gerald");
    expect(heardVoice(voiceRounds(lanes, { "round-1": "gerald", "round-2": "sombre" }))?.variant).toBe("sombre");
    expect(heardVoice(voiceRounds(lanes, {}))).toBeNull();
  });
  it("defaults to the current round's pick, else its first read", () => {
    expect(voiceDefaultRead(voiceRounds(lanes, {}))?.variant).toBe("excited");
    expect(voiceDefaultRead(voiceRounds(lanes, { "round-2": "sombre" }))?.variant).toBe("sombre");
  });
  it("labels legacy take and section notes without drawing them", () => {
    const m = { rounds: voiceRounds(lanes, {}) };
    expect(voiceNoteRows(m, { on: "s2:t1" } as Note)).toBeNull();
    expect(voiceOnLabel(m, "vo")).toBe("Assembled read");
  });

  it("treats a pick naming a read that's gone as no pick, and skips voice lanes with no reads", () => {
    const withEmpty = [...lanes, { id: "round-3", stage: "voice", name: "Round 3", variants: [] }] as Lane[];
    const r = voiceRounds(withEmpty, { "round-2": "gone" });
    expect(r.map((x) => x.id)).toEqual(["round-1", "round-2"]);
    expect(r[1]).toMatchObject({ current: true, pick: null });
    expect(heardVoice(r)).toBeNull();
    expect(voiceDefaultRead([])).toBeNull();
  });
  it("plays one read at a time, each in its own engine lane: the selected one, else the default", () => {
    const rounds = voiceRounds(lanes, { "round-1": "gerald" });
    const none = voiceListening(rounds, null);
    expect(Object.keys(none.select)).toEqual([
      "var:round-1/jane", "var:round-1/louise", "var:round-1/gerald", "var:round-2/excited", "var:round-2/sombre",
    ]);
    expect(none.select["var:round-2/sombre"]).toBe("round-2/sombre");
    // Nothing picked in the current round: its first read, not the older round's pick.
    expect(Object.entries(none.gains).filter(([, g]) => g === 1).map(([k]) => k)).toEqual(["var:round-2/excited"]);
    const jane = voiceListening(rounds, "round-1/jane");
    expect(Object.entries(jane.gains).filter(([, g]) => g === 1).map(([k]) => k)).toEqual(["var:round-1/jane"]);
    // The selection never changes, only the gains: switching is a ramp, never a restart.
    expect(jane.select).toEqual(none.select);
  });
  it("draws a note on its read, by lane-qualified id or (legacy) a bare variant id", () => {
    const m = { rounds: voiceRounds(lanes, {}), sections: ["s1", "s2"] };
    expect(voiceNoteRows(m, { on: "round-2/sombre" })).toBe("round-2/sombre");
    expect(voiceNoteRows(m, { on: "jane" })).toBe("round-1/jane");
    for (const on of [null, "vo", "s2", "s2:t1", "round-2/gone", "nowhere"]) expect(voiceNoteRows(m, { on })).toBeNull();
  });
  it("never reads a section id or 'vo' as a read named like it", () => {
    const clash = voiceRounds([{ id: "r", stage: "voice", name: "R", variants: [v("vo"), v("s2")] }] as Lane[], {});
    const m = { rounds: clash, sections: ["s2"] };
    expect(voiceNoteRows(m, { on: "vo" })).toBeNull();
    expect(voiceNoteRows(m, { on: "s2" })).toBeNull();
    expect(voiceNoteRows(m, { on: "r/s2" })).toBe("r/s2");
    expect(voiceOnLabel(m, "s2")).toBe("S2");
  });
  it("offers each read in the On menu, the current round first, labelled by name with the round in full", () => {
    const opts = voiceOnOptions(voiceRounds(lanes, {}));
    expect(opts.map((o) => [o.value, o.label, o.full, o.on])).toEqual([
      ["v:round-2/excited", "excited", "Round 2 · Gerald, tone · excited", "round-2/excited"],
      ["v:round-2/sombre", "sombre", "Round 2 · Gerald, tone · sombre", "round-2/sombre"],
      ["v:round-1/jane", "jane", "Round 1 · Voices · jane", "round-1/jane"],
      ["v:round-1/louise", "louise", "Round 1 · Voices · louise", "round-1/louise"],
      ["v:round-1/gerald", "gerald", "Round 1 · Voices · gerald", "round-1/gerald"],
    ]);
    expect(voiceOnOptions(voiceRounds(lanes, {}), () => "Read").map((o) => o.label)).toEqual(Array(5).fill("Read"));
  });
  it("groups the On menu by round, so two reads with one name stay apart (§18.3: the round is shown by the group)", () => {
    const twice = [
      { id: "round-1", stage: "voice", name: "Round 1 · Voices", variants: [v("jane"), v("gerald")] },
      { id: "round-3", stage: "voice", name: "Round 3 · Gerald, fixes", variants: [v("gerald")] },
    ] as Lane[];
    const opts = voiceOnOptions(voiceRounds(twice, {}));
    expect(opts.map((o) => [o.group, o.label])).toEqual([
      ["Round 3 · Gerald, fixes", "gerald"],
      ["Round 1 · Voices", "jane"],
      ["Round 1 · Voices", "gerald"],
    ]);
    expect(onOptionGroups(opts).map((g) => [g.group, g.options.map((o) => o.value)])).toEqual([
      ["Round 3 · Gerald, fixes", ["v:round-3/gerald"]],
      ["Round 1 · Voices", ["v:round-1/jane", "v:round-1/gerald"]],
    ]);
    // Other tabs pass no group: one run, rendered as plain options.
    const flat = [{ value: "a", label: "A", on: null }, { value: "b", label: "B", on: null }];
    expect(onOptionGroups(flat)).toEqual([{ group: undefined, options: flat }]);
    // Ungrouped options either side of a group stay where they are.
    const mixed = [{ value: "w", label: "Whole", on: null }, ...opts.slice(0, 1)];
    expect(onOptionGroups(mixed).map((g) => [g.group, g.options.length])).toEqual([[undefined, 1], ["Round 3 · Gerald, fixes", 1]]);
  });
  it("lists a note by its read, an older round's with the round, and older notes by what they were on", () => {
    const m = { rounds: voiceRounds(lanes, {}), sections: ["s1", "s2"] };
    expect(voiceOnLabel(m, "round-2/sombre")).toBe("sombre");
    expect(voiceOnLabel(m, "round-1/jane")).toBe("Round 1 · Voices · jane");
    expect(voiceOnLabel(m, "round-1/jane", () => "Read 2")).toBe("Round 1 · Voices · Read 2");
    expect(voiceOnLabel(m, "vo")).toBe("Assembled read");
    expect(voiceOnLabel(m, "s2")).toBe("S2");
    expect(voiceOnLabel(m, "s2:t2")).toBe("S2 · Take 2");
    expect(voiceOnLabel(m, null)).toBeNull();
    expect(voiceOnLabel(m, "nowhere")).toBeNull();
  });
});

import {
  levelText, loudnessLanes, loudnessReadout, MIX_LANES, type MixModel, mixNoteRows, mixNoteTarget, mixOnLabel, mixOnOptions, notePending,
} from "../../web/src/lib.js";
import type { LoudnessResult } from "../../web/src/types.js";

describe("a note in the making (one definition of pending)", () => {
  const none = { range: { in: null }, marks: [], hasText: false };
  it("is nothing with no range, no marks and no text", () => {
    expect(notePending(none)).toBe(false);
  });
  it("holds for a range, even an In point alone", () => {
    expect(notePending({ ...none, range: { in: 1.5 } })).toBe(true);
    expect(notePending({ ...none, range: { in: 0 } })).toBe(true);
  });
  it("holds for marks ticked without a range", () => {
    expect(notePending({ ...none, marks: [{ kind: "fall" }] })).toBe(true);
  });
  it("holds for typed text", () => {
    expect(notePending({ ...none, hasText: true })).toBe(true);
  });
});

describe("Mix", () => {
  const lanes: Lane[] = [
    { id: "music", stage: "music", name: "Music", variants: [
      { id: "a", name: "A · Deep house", file: "a.wav", meta: {}, cues: [] },
      { id: "b", name: "B · Warm keys", file: "b.wav", meta: {}, cues: [] },
    ] },
    { id: "sfx", stage: "sfx", name: "Sound effects", variants: [
      { id: "pass-a", name: "Pass A", file: "pa.wav", meta: {}, cues: [] },
      { id: "pass-b", name: "Pass B", file: "pb.wav", meta: {}, cues: [] },
    ] },
  ];
  const music = variantRows(lanes, "music");
  const sfx = variantRows(lanes, "sfx");
  const model = (heard: Partial<MixModel["heard"]> = {}): MixModel => ({
    variants: { music, sfx },
    heard: { vo: true, music: [music[1]], sfx: [sfx[0]], ...heard },
  });

  it("turns on Mix", () => {
    expect(BUILT.mix).toBe(true);
    expect(AUDIO_CHIPS.mix).toEqual(["Level", "Balance", "Loudness"]);
  });

  describe("which lanes are measured", () => {
    const heard = { vo: true, music: true, sfx: true };
    it("measures every lane that's heard and has something to play", () => {
      expect(loudnessLanes(heard, { vo: 1, music: 1, sfx: 1 })).toEqual(["voice", "music", "sfx"]);
    });
    it("leaves out muted lanes, and lanes solo silences", () => {
      expect(loudnessLanes(heard, { vo: 1, music: 0, sfx: 1 })).toEqual(["voice", "sfx"]);
      expect(loudnessLanes(heard, { vo: 0, music: 1, sfx: 0 })).toEqual(["music"]);
    });
    it("leaves out a lane with nothing picked, or a missing file, even when it's soloed", () => {
      expect(loudnessLanes({ ...heard, music: false }, { vo: 1, music: 1, sfx: 1 })).toEqual(["voice", "sfx"]);
      expect(loudnessLanes({ ...heard, sfx: false }, { vo: 0, music: 0, sfx: 1 })).toEqual([]);
    });
  });

  describe("notes", () => {
    it("knows what a note is on", () => {
      const m = model();
      expect(mixNoteTarget(m, null)).toBe("mix");
      expect(mixNoteTarget(m, "vo")).toBe("vo");
      expect(mixNoteTarget(m, "b")).toBe("music");
      expect(mixNoteTarget(m, "pass-a")).toBe("sfx");
      // A variant no longer picked still belongs to its lane.
      expect(mixNoteTarget(m, "a")).toBe("music");
      expect(mixNoteTarget(m, "pass-b")).toBe("sfx");
      expect(mixNoteTarget(m, "nowhere")).toBeNull();
      // Lane-qualified (I3).
      expect(mixNoteTarget(m, "music/b")).toBe("music");
      expect(mixNoteTarget(m, "sfx/pass-b")).toBe("sfx");
      expect(mixNoteTarget(m, "sfx/gone")).toBeNull();
    });
    it("never confuses a music bed and an SFX pass with the same name (I3)", () => {
      const clash: Lane[] = [
        { id: "music", stage: "music", name: "Music", variants: [{ id: "option-a", name: "Option A", file: "m.wav", meta: {}, cues: [] }] },
        { id: "sfx", stage: "sfx", name: "Sound effects", variants: [{ id: "option-a", name: "Option A", file: "s.wav", meta: {}, cues: [] }] },
      ];
      const mm = variantRows(clash, "music");
      const ss = variantRows(clash, "sfx");
      const m: MixModel = { variants: { music: mm, sfx: ss }, heard: { vo: false, music: mm, sfx: ss } };
      const sfxOption = mixOnOptions(m).find((o) => o.value === "sfx:sfx/option-a")!;
      expect(sfxOption.on).toBe("sfx/option-a");
      expect(mixNoteRows(m, sfxOption.on)).toEqual(["sfx"]);
      expect(mixOnLabel(m, sfxOption.on)).toBe("Sound effects · Option A");
      expect(mixNoteRows(m, "music/option-a")).toEqual(["music"]);
      // Legacy bare id: where it always drew (the first heard match, Music).
      expect(mixNoteRows(m, "option-a")).toEqual(["music"]);
    });
    it("draws a lane note on its lane, and a whole-mix (or orphaned) note on every lane", () => {
      const m = model();
      expect(mixNoteRows(m, "vo")).toEqual(["vo"]);
      expect(mixNoteRows(m, "a")).toEqual(["music"]);
      expect(mixNoteRows(m, "pass-a")).toEqual(["sfx"]);
      expect(mixNoteRows(m, null)).toEqual([...MIX_LANES]);
      expect(mixNoteRows(m, "nowhere")).toEqual([...MIX_LANES]);
    });
    it("lists the whole mix and each lane with something to play in the On menu", () => {
      expect(mixOnOptions(model()).map((o) => [o.value, o.label, o.on, o.row ?? null])).toEqual([
        ["mix", "Whole mix", null, null],
        ["vo", "Voiceover", "vo", "vo"],
        ["music:music/b", "Music · B · Warm keys", "music/b", "music"],
        ["sfx:sfx/pass-a", "Sound effects · Pass A", "sfx/pass-a", "sfx"],
      ]);
      expect(mixOnOptions(model({ vo: false, music: [], sfx: [] })).map((o) => o.value)).toEqual(["mix"]);
    });
    it("labels a listed note", () => {
      const m = model();
      expect(mixOnLabel(m, null)).toBe("Whole mix");
      expect(mixOnLabel(m, "vo")).toBe("Voiceover");
      expect(mixOnLabel(m, "b")).toBe("Music · B · Warm keys");
      expect(mixOnLabel(m, "a")).toBe("Music · A · Deep house");
      expect(mixOnLabel(m, "pass-a")).toBe("Sound effects · Pass A");
      expect(mixOnLabel(m, "music/a")).toBe("Music · A · Deep house");
      expect(mixOnLabel(m, "sfx/pass-b")).toBe("Sound effects · Pass B");
      expect(mixOnLabel(m, "nowhere")).toBeNull();
    });
  });

  describe("the loudness readout", () => {
    const result = (over: Partial<LoudnessResult> = {}) =>
      ({ kind: "result" as const, result: { available: true, integrated: -14.08, truePeak: -1.24, musicUnderVo: -17.6, silent: false, ...over } as LoudnessResult });
    const values = (s: Parameters<typeof loudnessReadout>[0]) => loudnessReadout(s).map((c) => c.value);
    const tips = (s: Parameters<typeof loudnessReadout>[0]) => loudnessReadout(s).map((c) => c.tip);

    it("formats levels with a real minus sign, one decimal, and never −0.0", () => {
      expect(levelText(-14.08)).toBe("−14.1");
      expect(levelText(0.42)).toBe("+0.4");
      expect(levelText(-0.04)).toBe("0.0");
      expect(levelText(0)).toBe("0.0");
      expect(levelText(-17.6, 0)).toBe("−18");
    });
    it("shows LUFS integrated, dBTP true peak and music under VO", () => {
      const cells = loudnessReadout(result());
      expect(cells.map((c) => [c.id, c.label])).toEqual([
        ["integrated", "LUFS integrated"], ["truePeak", "dBTP true peak"], ["musicUnderVo", "Music under VO"],
      ]);
      expect(cells.map((c) => c.value)).toEqual(["−14.1", "−1.2", "−18 dB"]);
      expect(cells.map((c) => c.tip)).toEqual([null, null, null]);
    });
    it("shows — with the install tooltip when the server has no ffmpeg", () => {
      const s = result({ available: false, integrated: null, truePeak: null, musicUnderVo: null });
      expect(values(s)).toEqual(["—", "—", "—"]);
      expect(tips(s)).toEqual(Array(3).fill("Install ffmpeg for loudness"));
    });
    it("shows — saying there's nothing to measure when no lane is left", () => {
      expect(values({ kind: "empty" })).toEqual(["—", "—", "—"]);
      expect(tips({ kind: "empty" })).toEqual(Array(3).fill("Nothing to measure"));
    });
    it("shows — with no tooltip until the first reading is back", () => {
      expect(values({ kind: "waiting" })).toEqual(["—", "—", "—"]);
      expect(tips({ kind: "waiting" })).toEqual([null, null, null]);
    });
    it("says why there's no reading when it timed out or failed", () => {
      expect(tips({ kind: "timeout" })).toEqual(Array(3).fill("Measuring took too long · click to retry"));
      expect(tips({ kind: "error" })).toEqual(Array(3).fill("Couldn't measure loudness · click to retry"));
    });
    it("shows music under VO as — when either is missing from the mix", () => {
      const s = result({ musicUnderVo: null });
      expect(values(s)).toEqual(["−14.1", "−1.2", "—"]);
      expect(tips(s)[2]).toBe("Needs Voiceover and Music both playing");
    });
    it("shows a silent mix as −∞ in every cell, music under VO too, never 'Needs Voiceover and Music'", () => {
      const s = result({ silent: true, integrated: null, truePeak: null, musicUnderVo: null });
      expect(values(s)).toEqual(["−∞", "−∞", "−∞"]);
      expect(tips(s)).toEqual(Array(3).fill("The mix is silent"));
    });
  });
});

describe("the VO pick rule: server mix and dashboard agree (parity)", () => {
  const files = ["dry.wav", "warm.wav", "cool.wav"];
  // Two voice rounds, round-2 the newer, so the suite can mirror Task 1's three mixInputs cases
  // (an older round picked, a newer pick wins, nothing picked) on the client side too.
  const lanes: Lane[] = [
    { id: "music", stage: "music", name: "Music", variants: [] },
    { id: "round-1", stage: "voice", name: "Round 1", variants: [
      { id: "dry", name: "Dry", file: "audio/dry.wav", meta: {}, cues: [] },
      { id: "warm", name: "Warm", file: "audio/warm.wav", meta: {}, cues: [] },
    ] },
    { id: "round-2", stage: "voice", name: "Round 2", variants: [
      { id: "cool", name: "Cool", file: "audio/cool.wav", meta: {}, cues: [] },
    ] },
  ];
  const cases: { sections: Record<string, string>; lanes: Record<string, string> }[] = [
    { sections: {}, lanes: {} }, // nothing picked
    { sections: { s1: "t1", s2: "t2" }, lanes: {} }, // takes picked, but no round: still nothing
    { sections: { s2: "gone" }, lanes: {} },
    { sections: { s1: "t1" }, lanes: { "round-1": "warm" } }, // the only round picked
    { sections: {}, lanes: { "round-1": "gone" } }, // a stale pick is no pick
    { sections: {}, lanes: { "round-1": "dry" } }, // an older round picked, the newer round has none
    { sections: {}, lanes: { "round-1": "dry", "round-2": "cool" } }, // a newer pick wins over an older one
    { sections: {}, lanes: { "round-1": "dry", "round-2": "gone" } }, // falls through a stale newer pick to the older one
  ];

  it("resolves the same voice files at the same offsets, for every pick shape (§18.4: takes are never mixed)", async () => {
    const { root } = await tmpProject("parity");
    await mkdir(join(root, "audio"), { recursive: true });
    await Promise.all(files.map((f) => writeFile(join(root, "audio", f), "x")));
    const project: Project = { schema: 1, rev: 0, name: "p", fps: 30, videos: [], files: [], lanes };
    for (const c of cases) {
      const picks: Picks = { schema: 1, rev: 0, sections: c.sections, lanes: c.lanes };
      const server = mixInputs(project, picks, ["voice"], root).map((i) => [relative(root, i.file), i.offset]);
      // The dashboard's VO, as Mix plays it: the newest round's pick, walking back past rounds with
      // none -- never the assembled read from takes, which Rushes no longer mixes.
      const variant = heardVoice(voiceRounds(lanes, c.lanes));
      const client = variant ? [[variant.file, 0]] : [];
      expect(client, JSON.stringify(c)).toEqual(server);
    }
  });
});

describe("cueRoom", () => {
  it("gives each cue label the width up to its nearest neighbour, as a fraction of the lane", () => {
    const room = cueRoom([{ t: 10 }, { t: 14 }, { t: 40 }], 100);
    expect(room[0]).toBeCloseTo(0.04);
    expect(room[1]).toBeCloseTo(0.04);
    expect(room[2]).toBeCloseTo(0.26);
  });
  it("works in any order and caps a lone cue", () => {
    const room = cueRoom([{ t: 90 }, { t: 5 }], 100);
    expect(room[0]).toBeCloseTo(0.4);
    expect(room[1]).toBeCloseTo(0.4);
    expect(cueRoom([{ t: 3 }], 0)).toEqual([0.4]);
  });
});
