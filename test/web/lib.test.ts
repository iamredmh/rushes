import { describe, expect, it } from "vitest";
import {
  boxFrom, defaultVersion, extOf, firstTab, fit, FOLDERS, fmt, folderItems, formatBytes, frameAt, groupByFilm,
  isChanged, isPreviewable, latest, metaLine, neighbourVideo, noteTime, OPEN_SAFE_EXT, placeNote, shotAt, shotLabel, shotSeek, snap, stepFrame,
} from "../../web/src/lib.js";
import type { Asset, Note, Section, Shot, TabState, Video } from "../../web/src/types.js";
// Only this test imports the server's own list, so the web copy (ruling 1) is never pulled
// into the web bundle -- this is purely to assert the two stay equal.
import { OPEN_SAFE_EXT as SERVER_OPEN_SAFE_EXT } from "../../src/server/reveal.js";
import { markLabel as serverMarkLabel, type Mark } from "../../src/core/schema.js";
import {
  AUDIO_CHIPS, BUILT, blindOrder, laneSelection, markLabel, marksLabel, setMarkDb, testFlags, toggleMark, variantMeta,
  variantNoteRow, variantOnOptions, variantRows,
} from "../../web/src/lib.js";
import type { Lane } from "../../web/src/types.js";

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
    expect(opts[2]).toMatchObject({ on: "swipe", t: 1.5, row: "sfx/pass-a" });
    expect(variantOnOptions(rows, (r) => r.name).length).toBe(2);
  });
  it("draws a note on its variant, or on the pass holding its cue", () => {
    const sfx = variantRows(lanes, "sfx");
    expect(variantNoteRow(sfx, "pass-b")).toBe("sfx/pass-b");
    expect(variantNoteRow(sfx, "tap")).toBe("sfx/pass-a");
    expect(variantNoteRow(sfx, null)).toBeNull();
    expect(variantNoteRow(sfx, "nope")).toBeNull();
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
