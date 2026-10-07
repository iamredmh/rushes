import { describe, expect, it } from "vitest";
import {
  agentPrompt, boxFrom, contentRect, copyShortcut, cueRoom, defaultVersion, extOf, firstTab, fit, FOLDERS, fmt, folderItems, formatBytes, frameAt, groupByFilm,
  isChanged, isPreviewable, latest, LOCKED_TAB, metaLine, neighbourVideo, noteTime, OPEN_SAFE_EXT, placeNote, shotAt, shotLabel, shotSeek, snap, stepFrame,
} from "../../web/src/lib.js";
import type { Asset, Note, Section, Shot, TabState, Video } from "../../web/src/types.js";
import {
  mergeProxyJob, PLAYBACK_ERROR_REASON, proxyEstimateMb, proxyMeta, proxyPhase, proxyProgress, proxyReason, proxyTip, settleProxyJobs,
  type ProxyJobs, type ProxyProgress,
} from "../../web/src/lib.js";
// Only this test imports the server's own list, so the web copy (ruling 1) is never pulled
// into the web bundle -- this is purely to assert the two stay equal.
import { OPEN_SAFE_EXT as SERVER_OPEN_SAFE_EXT } from "../../src/server/reveal.js";
import { markLabel as serverMarkLabel, type Mark } from "../../src/core/schema.js";
import {
  AUDIO_CHIPS, BUILT, blindOrder, laneSelection, markLabel, marksLabel, scopeOptions, noteFocus, setMarkDb, spacePressesButton, testFlags, toggleMark, watchFocusOrigin, variantMeta,
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

describe("LOCKED_TAB / agentPrompt (§19.1)", () => {
  it("gives every locked tab non-empty what, unlocks and ask", () => {
    for (const copy of Object.values(LOCKED_TAB)) {
      expect(copy.what.trim()).not.toBe("");
      expect(copy.unlocks.trim()).not.toBe("");
      expect(copy.ask.trim()).not.toBe("");
    }
  });
  it("builds the Music prompt with a film clause when the film is known", () => {
    expect(agentPrompt("music", "Launch", "Hero")).toBe(
      'In Rushes project "Launch", make two or three music beds for "Hero" and add each with rushes_add_variant (stage "music") with a one-line description.',
    );
  });
  it("drops the film clause when there's no film", () => {
    expect(agentPrompt("music", "Launch", null)).toBe(
      'In Rushes project "Launch", make two or three music beds and add each with rushes_add_variant (stage "music") with a one-line description.',
    );
  });
});

describe("boxFrom", () => {
  it("normalises a drag in any direction and clamps it to the frame", () => {
    expect(boxFrom(100, 50, 300, 150, 400, 200)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom(300, 150, 100, 50, 400, 200)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(boxFrom(-50, -50, 500, 300, 400, 200)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("contentRect", () => {
  it("is the whole box when the picture's shape matches it", () => {
    expect(contentRect(1920, 1080, 960, 540)).toEqual({ x: 0, y: 0, w: 960, h: 540 });
  });
  it("pillarboxes a vertical cut in a 16:9 box: full height, centred", () => {
    // 360x640 in 992x630: scale 630/640, so 354.375 wide, (992 - 354.375) / 2 in from the left.
    expect(contentRect(360, 640, 992, 630)).toEqual({ x: 318.8125, y: 0, w: 354.375, h: 630 });
  });
  it("letterboxes a wide cut in a taller box: full width, centred", () => {
    expect(contentRect(2400, 1000, 1200, 900)).toEqual({ x: 0, y: 200, w: 1200, h: 500 });
  });
  it("scales up as well as down", () => {
    expect(contentRect(16, 9, 1600, 1000)).toEqual({ x: 0, y: 50, w: 1600, h: 900 });
  });
  it("falls back to the whole box before the picture's size is known", () => {
    expect(contentRect(0, 0, 640, 360)).toEqual({ x: 0, y: 0, w: 640, h: 360 });
    expect(contentRect(360, 640, 0, 0)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
  it("with boxFrom, measures a drag on a pillarboxed picture against the picture", () => {
    const r = contentRect(360, 640, 992, 630);
    // Pointer positions in the element's own coordinates, moved into the picture's.
    const drag = (x0: number, y0: number, x1: number, y1: number) => boxFrom(x0 - r.x, y0 - r.y, x1 - r.x, y1 - r.y, r.w, r.h);
    // From the picture's top-left corner to its centre.
    expect(drag(r.x, 0, r.x + r.w / 2, r.h / 2)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    // A drag that starts out in the pillarbox is clamped to the picture's edge.
    expect(drag(10, 0, r.x + r.w / 2, r.h / 2)).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    // Measured against the element instead, the same drag is the bug: a box well under half as wide.
    expect(boxFrom(r.x, 0, r.x + r.w / 2, r.h / 2, 992, 630).w).toBeLessThan(0.2);
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
    const v = (id: string) => ({ id, file: `${id}.mp4`, duration: null, fps: null, addedAt: "", note: "", shots: [], proxy: null });
    expect(latest({ id: "hero", name: "Hero", versions: [v("v1"), v("v2")], lockedVersion: null })?.id).toBe("v2");
    expect(latest({ id: "hero", name: "Hero", versions: [], lockedVersion: null })).toBeUndefined();
    expect(latest(undefined)).toBeUndefined();
  });
});

describe("defaultVersion", () => {
  const v = (id: string) => ({ id, file: `${id}.mp4`, duration: null, fps: null, addedAt: "", note: "", shots: [], proxy: null });
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
      "Screenshots", "Cuts", "Proxies", "Voiceover", "Music", "Sound effects",
      "Scripts & docs", "Images", "Captions", "Exports", "Delivery", "Edit files",
    ]);
    expect(FOLDERS.find((f) => f.id === "export")?.filmFilter).toBe(false);
    expect(FOLDERS.find((f) => f.id === "cut")?.filmFilter).toBe(true);
    expect(FOLDERS.find((f) => f.id === "delivery")?.filmFilter).toBe(true);
    expect(FOLDERS.find((f) => f.id === "proxy")).toMatchObject({ kinds: ["proxy"], view: "list", filmFilter: true, gridToggle: false });
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
    { id: "hero", name: "Hero", versions: [{ id: "v1", file: "renders/hero_v1.mp4", duration: null, fps: null, addedAt: "2026-10-01T00:00:00Z", note: "First pass", shots: [], proxy: null }], lockedVersion: null },
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

describe("Space on a focused button (§19.8)", () => {
  /** A stand-in button: it matches `:focus-visible` when `keyboard`, and is its own `closest("button")`. */
  const button = (keyboard: boolean, player = false) => {
    const el = {
      matches: (sel: string) => sel === ":focus-visible" && keyboard,
      closest: (sel: string) => (sel === "button" ? el : sel === "[data-player]" && player ? {} : null),
    };
    return el as unknown as EventTarget;
  };
  it("is the button's when it was reached by keyboard", () => {
    const b = button(true);
    noteFocus(b);
    expect(spacePressesButton(b)).toBe(true);
  });
  it("plays when the button only has focus from a mouse click", () => {
    const b = button(false);
    noteFocus(b);
    expect(spacePressesButton(b)).toBe(false);
    // A key press later makes it match :focus-visible, but how it got focus is what counts.
    expect(spacePressesButton(b)).toBe(false);
  });
  it("still plays from the page, the player, or a button inside the player", () => {
    expect(spacePressesButton(null)).toBe(false);
    expect(spacePressesButton({} as EventTarget)).toBe(false);
    const lane = button(true, true);
    noteFocus(lane);
    expect(spacePressesButton(lane)).toBe(false);
  });
  it("forgets a keyboard focus once the button is pressed with the pointer", () => {
    const listeners: Record<string, (e: Event) => void> = {};
    watchFocusOrigin({ addEventListener: (type: string, cb: (e: Event) => void) => { listeners[type] = cb; } } as unknown as Document);
    const b = button(true);
    listeners.focusin({ target: b } as unknown as Event);
    expect(spacePressesButton(b)).toBe(true);
    listeners.pointerdown({ target: b } as unknown as Event);
    expect(spacePressesButton(b)).toBe(false);
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
    const m = { rounds: voiceRounds(lanes, {}), sections: [{ id: "s1", takes: [] }, { id: "s2", takes: [{ id: "t1" }] }] };
    expect(voiceNoteRows(m, { on: "round-2/sombre" })).toBe("round-2/sombre");
    expect(voiceNoteRows(m, { on: "jane" })).toBe("round-1/jane");
    for (const on of [null, "vo", "s2", "s2:t1", "round-2/gone", "nowhere"]) expect(voiceNoteRows(m, { on })).toBeNull();
  });
  it("never reads a section id or 'vo' as a read named like it", () => {
    const clash = voiceRounds([{ id: "r", stage: "voice", name: "R", variants: [v("vo"), v("s2")] }] as Lane[], {});
    const m = { rounds: clash, sections: [{ id: "s2", takes: [] }] };
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
    const m = { rounds: voiceRounds(lanes, {}), sections: [{ id: "s1", takes: [] }, { id: "s2", takes: [{ id: "t1" }, { id: "t2" }] }] };
    expect(voiceOnLabel(m, "round-2/sombre")).toBe("sombre");
    expect(voiceOnLabel(m, "round-1/jane")).toBe("Round 1 · Voices · jane");
    expect(voiceOnLabel(m, "round-1/jane", () => "Read 2")).toBe("Round 1 · Voices · Read 2");
    expect(voiceOnLabel(m, "vo")).toBe("Assembled read");
    expect(voiceOnLabel(m, "s2")).toBe("S2");
    expect(voiceOnLabel(m, "s2:t2")).toBe("S2 · Take 2");
    // As export and the CLI say: no `on` is the assembled read, and a take that's gone has no label.
    expect(voiceOnLabel(m, null)).toBe("Assembled read");
    expect(voiceOnLabel(m, "s2:t3")).toBeNull();
    expect(voiceOnLabel(m, "s1:t1")).toBeNull();
    expect(voiceOnLabel(m, "nowhere")).toBeNull();
  });
});

import {
  clampLevel, levelText, loudnessLanes, loudnessReadout, MIX_LANES, type MixModel, mixNoteRows, mixNoteTarget, mixOnLabel, mixOnOptions, notePending,
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
    it("the Mix slider's exact readout (§19.6): a real U+2212 minus, never an ASCII hyphen", () => {
      // A Mix level is always a whole 0.5 dB step, so this is the literal string the slider shows.
      expect(levelText(-14)).toBe("−14.0");
      expect(`${levelText(-14)} dB`).toBe("−14.0 dB");
      expect(levelText(-14)).not.toContain("-"); // U+002D, the ASCII hyphen-minus
      expect(levelText(6)).toBe("+6.0");
      expect(levelText(0)).toBe("0.0");
    });
    it("clamps a level to the slider's range and snaps it to the 0.5 dB step (§19.6)", () => {
      expect(clampLevel(-14)).toBe(-14);
      expect(clampLevel(-14.2)).toBe(-14);
      expect(clampLevel(-14.3)).toBe(-14.5);
      expect(clampLevel(-30)).toBe(-24);
      expect(clampLevel(20)).toBe(6);
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
    const project: Project = { schema: 1, rev: 0, name: "p", fps: 30, videos: [], files: [], lanes, autoProxy: false };
    for (const c of cases) {
      const picks: Picks = { schema: 1, rev: 0, sections: c.sections, lanes: c.lanes, levels: {} };
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

describe("onOptionGroups keeps same-named rounds apart", () => {
  it("splits on the group id, not the label", () => {
    const groups = onOptionGroups([
      { value: "a", label: "A", on: "x/a", group: "Voiceover", groupId: "round-x" },
      { value: "b", label: "B", on: "y/b", group: "Voiceover", groupId: "round-y" },
    ]);
    expect(groups.map((g) => g.options.length)).toEqual([1, 1]);
  });
});

describe("proxies (§19.5)", () => {
  const job = (over: Partial<ProxyProgress> = {}): ProxyProgress => ({ job: "j1", video: "hero", version: "v1", pct: 0, state: "running", at: 1, ...over });

  it("estimates the proxy at 1 MB a second (8 Mbit/s), rounded to 10 MB and never under 10", () => {
    expect(proxyEstimateMb(6)).toBe(10);
    expect(proxyEstimateMb(0)).toBe(10);
    expect(proxyEstimateMb(NaN)).toBe(10);
    expect(proxyEstimateMb(142)).toBe(140);
    expect(proxyEstimateMb(145)).toBe(150);
    expect(proxyTip(142)).toBe("Makes a lightweight 1080p copy on your drive so this cut previews smoothly. About 140 MB. Your original isn't changed.");
  });

  it("never moves a job backwards: a finished job stays finished, and its % never drops", () => {
    let jobs: ProxyJobs = {};
    jobs = mergeProxyJob(jobs, job({ pct: 40, at: 2 }));
    expect(jobs["hero/v1"].pct).toBe(40);
    expect(mergeProxyJob(jobs, job({ pct: 10, at: 3 }))).toBe(jobs);
    jobs = mergeProxyJob(jobs, job({ pct: 100, state: "done", at: 4 }));
    expect(mergeProxyJob(jobs, job({ pct: 99, at: 5 }))).toBe(jobs);
    expect(jobs["hero/v1"].state).toBe("done");
  });

  it("a newer job for the same cut replaces the old one, older news never does", () => {
    let jobs: ProxyJobs = mergeProxyJob({}, job({ state: "failed", reason: "x", at: 5 }));
    expect(mergeProxyJob(jobs, job({ job: "j0", at: 3 }))).toBe(jobs);
    jobs = mergeProxyJob(jobs, job({ job: "j2", at: 6 }));
    expect(jobs["hero/v1"]).toMatchObject({ job: "j2", state: "running" });
  });

  it("turns a route's ProxyJob into the event's shape", () => {
    expect(proxyProgress({ id: "j1", video: "hero", version: "v2", pct: 3, state: "failed", reason: "The original file is missing" }, 9)).toEqual({
      job: "j1", video: "hero", version: "v2", pct: 3, state: "failed", reason: "The original file is missing", at: 9,
    });
  });

  it("settling against a state seeds its running jobs and drops what it shows is over, but only older news", () => {
    const noProxy = () => false;
    // A tab opened mid-job: the state's running job is seeded.
    const seeded = settleProxyJobs({}, [{ id: "j1", video: "hero", version: "v1", pct: 12, state: "running" }], 10, noProxy);
    expect(seeded["hero/v1"]).toMatchObject({ job: "j1", pct: 12, state: "running", at: 10 });
    // A running job the state no longer lists ended unseen: dropped.
    expect(settleProxyJobs(seeded, [], 20, noProxy)).toEqual({});
    // ...unless the news is newer than the fetch.
    expect(settleProxyJobs(seeded, [], 5, noProxy)).toBe(seeded);
    // A finished job whose proxy has gone (deleted) is dropped; one whose proxy is there stays.
    const done = mergeProxyJob({}, job({ state: "done", pct: 100, at: 1 }));
    expect(settleProxyJobs(done, [], 20, noProxy)).toEqual({});
    expect(settleProxyJobs(done, [], 20, () => true)).toBe(done);
    // Failed and cancelled jobs are kept: they're what the bar returns to the offer from.
    const failed = mergeProxyJob({}, job({ state: "failed", at: 1 }));
    expect(settleProxyJobs(failed, [], 20, noProxy)).toBe(failed);
  });

  it("picks the bar's row: nothing without ffmpeg, the offer needs a reason and no proxy, and ✓ only for a proxy watched being made", () => {
    const base = { ffmpeg: true, need: null, broken: false, hasProxy: false, job: undefined, starting: false, watched: false };
    expect(proxyPhase({ ...base, ffmpeg: false, need: "It's a ProRes file" })).toBe("none");
    expect(proxyPhase(base)).toBe("none");
    expect(proxyPhase({ ...base, need: "It's a ProRes file" })).toBe("offer");
    expect(proxyPhase({ ...base, broken: true })).toBe("offer");
    expect(proxyPhase({ ...base, need: "x", starting: true })).toBe("working");
    expect(proxyPhase({ ...base, need: "x", job: job() })).toBe("working");
    expect(proxyPhase({ ...base, need: "x", job: job({ state: "failed" }) })).toBe("offer");
    expect(proxyPhase({ ...base, need: "x", job: job({ state: "cancelled" }) })).toBe("offer");
    // Finished, but the record hasn't arrived yet: still working, at 100%.
    expect(proxyPhase({ ...base, need: "x", job: job({ state: "done" }), watched: true })).toBe("working");
    expect(proxyPhase({ ...base, need: "x", hasProxy: true, job: job({ state: "done" }), watched: true })).toBe("done");
    expect(proxyPhase({ ...base, need: "x", hasProxy: true, job: job({ state: "done" }) })).toBe("none");
    expect(proxyPhase({ ...base, need: "x", hasProxy: true })).toBe("none");
  });

  it("gives the server's reason, else the browser's refusal", () => {
    expect(proxyReason("It's a ProRes file, which browsers struggle with", true)).toBe("It's a ProRes file, which browsers struggle with");
    expect(proxyReason(null, true)).toBe(PLAYBACK_ERROR_REASON);
    expect(PLAYBACK_ERROR_REASON).toBe("The browser couldn't play this file");
    expect(proxyReason(undefined, false)).toBeNull();
  });

  it("describes a proxy as size · W×H · from vN, reusing formatBytes", () => {
    expect(proxyMeta({ size: 148_897_792, width: 1920, height: 1080, version: "v3" })).toBe("142.0 MB · 1920×1080 · from v3");
    expect(proxyMeta({ size: 1536, width: undefined, height: undefined, version: undefined })).toBe("2 KB");
  });
});

describe("copyShortcut (Minor 11)", () => {
  it("is ⌘C on Apple platforms and Ctrl+C elsewhere", () => {
    expect(copyShortcut("MacIntel")).toBe("⌘C");
    expect(copyShortcut("iPad")).toBe("⌘C");
    expect(copyShortcut("Linux x86_64")).toBe("Ctrl+C");
    expect(copyShortcut("Win32")).toBe("Ctrl+C");
    expect(copyShortcut("")).toBe("Ctrl+C");
  });
});

// ---- Plan 5, Task 5: Assets › Found (§20.5) ----
import {
  bringInMessage, broughtInRows, filterFound, foundChip, foundDuration, foundKinds, foundRowChanged, foundSignature, foundTotal, groupFound, humanFolder, lockedFound, reuseItems,
  type FoundItem,
} from "../../web/src/lib.js";

const counts = (c: Partial<Record<"voice" | "music" | "sfx" | "cut" | "other", number>> = {}) => ({ voice: 0, music: 0, sfx: 0, cut: 0, other: 0, ...c });
const item = (path: string, kind: FoundItem["kind"] = "other", extra: Partial<FoundItem> = {}): FoundItem => {
  const i = path.lastIndexOf("/");
  return { path, kind, folder: i === -1 ? "" : path.slice(0, i), size: 1000, modified: 0, duration: null, score: null, reasons: [], suggested: false, ...extra };
};

describe("humanFolder", () => {
  it("turns a folder name into words", () => {
    expect(humanFolder("vo_jules")).toBe("Vo Jules");
    expect(humanFolder("vo-jules")).toBe("Vo Jules");
    expect(humanFolder("bed")).toBe("Bed");
    expect(humanFolder("voJules")).toBe("Vo Jules");
    expect(humanFolder("VO")).toBe("VO");
    expect(humanFolder("clean  takes")).toBe("Clean Takes");
  });
  it("keeps each level of a nested folder, and names the project folder itself", () => {
    expect(humanFolder("hyperframes/out")).toBe("Hyperframes / Out");
    expect(humanFolder("")).toBe("Project folder");
  });
});

describe("groupFound", () => {
  it("groups by folder in the order each folder first appears, with all cuts last as Other cuts", () => {
    const files = [
      item("renders/final.mp4", "cut"),
      item("vo_jules/a.wav", "voice"),
      item("bed/b.wav", "music"),
      item("vo_jules/c.wav", "voice"),
      item("old/render.mov", "cut"),
      item("audition/t.wav"),
    ];
    const groups = groupFound(files);
    expect(groups.map((g) => g.title)).toEqual(["Vo Jules", "Bed", "Audition", "Other cuts"]);
    expect(groups.map((g) => g.files.map((f) => f.path))).toEqual([
      ["vo_jules/a.wav", "vo_jules/c.wav"], ["bed/b.wav"], ["audition/t.wav"], ["renders/final.mp4", "old/render.mov"],
    ]);
    expect(groups.map((g) => g.key)).toEqual(["vo_jules", "bed", "audition", "\0cuts"]);
  });
  it("is stable: the same input gives the same groups, and nothing is lost", () => {
    const files = [item("b/x.wav"), item("a/y.wav"), item("b/z.wav"), item("top.wav")];
    const once = groupFound(files);
    expect(groupFound(files)).toEqual(once);
    expect(once.flatMap((g) => g.files).length).toBe(4);
    expect(once.map((g) => g.title)).toEqual(["B", "A", "Project folder"]);
  });
  it("has no groups for no files", () => {
    expect(groupFound([])).toEqual([]);
  });
});

describe("lockedFound (§20.5)", () => {
  it("says how many files of the tab's kind were found, in the singular for one", () => {
    expect(lockedFound("music", counts({ music: 14 }))).toEqual({ kind: "music", text: "14 music files found in this project", review: "Review music files in Found" });
    expect(lockedFound("music", counts({ music: 1 }))?.text).toBe("1 music file found in this project");
    expect(lockedFound("voice", counts({ voice: 2 }))?.text).toBe("2 voiceover files found in this project");
    expect(lockedFound("sfx", counts({ sfx: 1 }))?.text).toBe("1 sound effect file found in this project");
    expect(lockedFound("sfx", counts({ sfx: 3 }))?.kind).toBe("sfx");
  });
  it("has no line for none found, another kind's files, or a tab that takes no files of its own", () => {
    expect(lockedFound("music", counts({ voice: 5 }))).toBeNull();
    expect(lockedFound("music", counts())).toBeNull();
    expect(lockedFound("music", undefined)).toBeNull();
    for (const tab of ["script", "picture", "mix", "assets"] as const) expect(lockedFound(tab, counts({ voice: 1, music: 1, sfx: 1, cut: 1, other: 1 }))).toBeNull();
  });
});

describe("foundChip", () => {
  it("reads 'N brought in · M more found'", () => {
    expect(foundChip({ broughtIn: ["a", "b", "c"], counts: counts({ voice: 100, music: 19 }) })).toBe("3 brought in · 119 more found");
  });
  it("drops the half with nothing in it, and is null when both are empty", () => {
    expect(foundChip({ broughtIn: ["a"], counts: counts() })).toBe("1 brought in");
    expect(foundChip({ broughtIn: [], counts: counts({ cut: 4 }) })).toBe("4 found");
    expect(foundChip({ broughtIn: [], counts: counts() })).toBeNull();
    expect(foundChip(undefined)).toBeNull();
  });
  it("counts every kind that is left", () => {
    expect(foundTotal(counts({ voice: 1, music: 2, sfx: 3, cut: 4, other: 5 }))).toBe(15);
  });
  it("names the files, not just how many: the same counts with another file is another signature", () => {
    const c = counts({ voice: 2 });
    const a = foundSignature({ broughtIn: [], counts: c, digest: "aaaa" });
    expect(foundSignature({ broughtIn: [], counts: c, digest: "aaaa" })).toBe(a);
    expect(foundSignature({ broughtIn: [], counts: c, digest: "bbbb" })).not.toBe(a);
    // An older server sends no digest: the counts stand in.
    expect(foundSignature({ broughtIn: [], counts: c })).not.toBe(a);
    expect(foundSignature(undefined)).toBe("");
  });
  it("changes its signature when what is found changes, so the chip can come back", () => {
    const a = foundSignature({ broughtIn: [], counts: counts({ voice: 2 }) });
    expect(foundSignature({ broughtIn: [], counts: counts({ voice: 2 }) })).toBe(a);
    expect(foundSignature({ broughtIn: ["x"], counts: counts({ voice: 2 }) })).not.toBe(a);
    expect(foundSignature({ broughtIn: [], counts: counts({ voice: 3 }) })).not.toBe(a);
  });
});

describe("foundDuration", () => {
  it("is m:ss.s, with a dash when unknown", () => {
    expect(foundDuration(68.6)).toBe("1:08.6");
    expect(foundDuration(4.1)).toBe("0:04.1");
    expect(foundDuration(59.96)).toBe("1:00.0");
    expect(foundDuration(null)).toBe("—");
    expect(foundDuration(Number.NaN)).toBe("—");
  });
});

describe("filterFound and foundKinds", () => {
  const files = [item("vo/a.wav", "voice"), item("bed/Warm Pad.wav", "music"), item("x/t1.wav", "other"), item("x/t2.wav", "other"), item("r/c.mp4", "cut")];
  it("filters by kind and by a search over the path, ignoring case", () => {
    expect(filterFound(files, "all", "").length).toBe(5);
    expect(filterFound(files, "other", "").map((f) => f.path)).toEqual(["x/t1.wav", "x/t2.wav"]);
    expect(filterFound(files, "all", "warm pad").map((f) => f.path)).toEqual(["bed/Warm Pad.wav"]);
    expect(filterFound(files, "all", "  BED/ ").map((f) => f.path)).toEqual(["bed/Warm Pad.wav"]);
    expect(filterFound(files, "music", "a.wav").map((f) => f.path)).toEqual([]);
  });
  it("counts the kinds that are there, in a fixed order", () => {
    expect(foundKinds(files)).toEqual([["voice", 1], ["music", 1], ["other", 2], ["cut", 1]]);
  });
});

describe("bringInMessage", () => {
  it("says what came in", () => {
    expect(bringInMessage(3, [])).toBe("Brought in 3 files");
    expect(bringInMessage(1, [])).toBe("Brought in 1 file");
  });
  it("says what couldn't, and why", () => {
    expect(bringInMessage(2, [{ path: "a.wav", reason: "That file has gone" }])).toBe("Brought in 2 files. 1 couldn't be added: that file has gone.");
    expect(bringInMessage(12, [{ path: "m.wav", reason: "Up to 12 at a time, so the tabs stay quick." }])).toBe(
      "Brought in 12 files. 1 couldn't be added: up to 12 at a time, so the tabs stay quick.",
    );
  });
  it("names each different reason once", () => {
    const failed = [
      { path: "a", reason: "That file has gone" },
      { path: "b", reason: "That file has gone" },
      { path: "c", reason: "Choose a kind for this file" },
    ];
    expect(bringInMessage(0, failed)).toBe("Nothing was brought in. 3 couldn't be added: that file has gone; choose a kind for this file.");
  });
});

describe("broughtInRows", () => {
  const project = {
    videos: [{ id: "hero", name: "Hero", lockedVersion: null, versions: [{ id: "v2", file: "renders/cut-b.mp4" }] }],
    lanes: [
      { id: "vo-jules", stage: "voice" as const, name: "Vo Jules", variants: [{ id: "read", name: "read", file: "vo_jules/read.wav", meta: { description: "same length as the cut · made 12 min before it" }, cues: [] }] },
      { id: "music", stage: "music" as const, name: "Music", variants: [{ id: "bed", name: "bed", file: "bed/bed.wav", meta: {}, cues: [] }] },
    ],
    files: [{ id: "f1", kind: "doc" as const, file: "notes/brief.md", name: "brief", note: "", video: null, addedAt: "" }],
  };
  it("describes each brought-in file from where it was registered", () => {
    const rows = broughtInRows(project as never, ["vo_jules/read.wav", "bed/bed.wav", "renders/cut-b.mp4", "notes/brief.md"]);
    expect(rows.map((r) => [r.name, r.kind, r.label, r.reasons, r.playable])).toEqual([
      ["read.wav", "voice", "Voiceover · Vo Jules", "same length as the cut · made 12 min before it", true],
      ["bed.wav", "music", "Music", "", true],
      ["cut-b.mp4", "cut", "Cut · Hero v2", "", false],
      ["brief.md", "doc", "Doc", "", false],
    ]);
  });
  it("still lists a file it can't place", () => {
    expect(broughtInRows(project as never, ["gone/x.wav"])).toEqual([
      { path: "gone/x.wav", name: "x.wav", kind: null, label: "", reasons: "", playable: false },
    ]);
  });
});

describe("reuseItems", () => {
  const a = item("vo/a.wav", "voice", { reasons: ["one"], duration: 3 });
  const b = item("vo/b.wav", "voice");
  const copy = (f: FoundItem): FoundItem => ({ ...f, reasons: [...f.reasons] });
  it("keeps the very same list when nothing changed", () => {
    const prev = [a, b];
    expect(reuseItems(prev, [copy(a), copy(b)])).toBe(prev);
  });
  it("keeps the old object for each unchanged file and takes the new one for a changed file", () => {
    const next = [copy(a), { ...copy(b), duration: 9 }, item("vo/c.wav", "voice")];
    const out = reuseItems([a, b], next);
    expect(out).not.toEqual([a, b]);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(next[1]);
    expect(out[1].duration).toBe(9);
    expect(out[2].path).toBe("vo/c.wav");
  });
  it("notices a changed reason, a removed file and a new order", () => {
    expect(reuseItems([a, b], [{ ...copy(a), reasons: ["two"] }, copy(b)])[0].reasons).toEqual(["two"]);
    expect(reuseItems([a, b], [copy(a)])).toEqual([a]);
    const swapped = reuseItems([a, b], [copy(b), copy(a)]);
    expect(swapped.map((f) => f.path)).toEqual(["vo/b.wav", "vo/a.wav"]);
    expect(swapped[0]).toBe(b);
  });
});

describe("foundRowChanged: a Found row draws again only when something it shows changed", () => {
  const a = item("vo/a.wav", "voice");
  const props = { item: a, kind: "voice" as const, ticked: false, playing: false, failure: undefined as string | undefined };

  it("is false for the same props, whatever the callbacks are", () => {
    expect(foundRowChanged(props, { ...props })).toBe(false);
  });

  it("is true for a new item, kind, tick, play state or failure", () => {
    expect(foundRowChanged(props, { ...props, item: { ...a } })).toBe(true);
    expect(foundRowChanged(props, { ...props, kind: "music" })).toBe(true);
    expect(foundRowChanged(props, { ...props, ticked: true })).toBe(true);
    expect(foundRowChanged(props, { ...props, playing: true })).toBe(true);
    expect(foundRowChanged(props, { ...props, failure: "Already in the project." })).toBe(true);
  });
});
