import { describe, expect, it } from "vitest";
import { appendEvent, backfillLog, logView, undatedLines, undatedRefs } from "../../src/core/log.js";
import {
  FILE_FOLDERS, broughtInEvent, cutEvent, fileEvent, lineEvent, lockEvent, notesSentEvent, picksEvent, repliesEvent, scriptEvent, takeEvent, variantEvent,
} from "../../src/core/logEvents.js";
import { LOG_MAX } from "../../src/core/logText.js";
import { LogFileSchema, type BatchesFile, type LogFile, type Project, type Script } from "../../src/core/schema.js";
import { addFile, addVariant, addVersion } from "../../src/core/project.js";
import { FOLDERS } from "../../web/src/lib.js";
import { tmpProject } from "../helpers/tmp.js";

const empty = (): LogFile => ({ schema: 1, rev: 0, backfilled: true, undated: [], dropped: 0, entries: [] });
const T0 = Date.UTC(2026, 9, 7, 9, 0);
const at = (min: number) => new Date(T0 + min * 60_000);
const texts = (f: LogFile) => [...f.entries].reverse().map((e) => e.text);
const music = { id: "night-drive", stage: "music" as const, name: "night-drive" };
const sfx = { id: "sfx", stage: "sfx" as const, name: "Sound effects" };

describe("the words of each line (§22.5, R9)", () => {
  it("cuts: the short label, the film when there are several, and a merged count", () => {
    const one = cutEvent(1, { id: "lumen", name: "Lumen" }, { id: "v6", note: "v6: launch 1.45x slower; more", file: "a.mp4" });
    expect(one).toMatchObject({ area: "picture", kind: "cut", text: "v6 added: launch 1.45x slower", video: "lumen", version: "v6", merge: "count" });
    expect(one.many!(3, "lumen")).toBe("3 cuts added, the latest v6: launch 1.45x slower");
    const two = cutEvent(2, { id: "teaser", name: "Teaser" }, { id: "v2", note: "", file: "renders/teaser_v2.mp4", label: "Shorter end card" });
    expect(two.text).toBe("Teaser v2 added: Shorter end card");
    expect(two.many!(2, "teaser")).toBe("2 cuts added to Teaser, the latest Teaser v2: Shorter end card");
    expect(two.many!(2, "")).toBe("2 cuts added, the latest Teaser v2: Shorter end card");
  });
  it("variants and reads: the name in quotes, the lane unless it's the stage's own", () => {
    const bed = variantEvent(music, { id: "night-drive", name: "Night drive, driving drop" });
    expect(bed).toMatchObject({ area: "music", kind: "variant", text: "Music: “Night drive, driving drop” added to night-drive", ref: "night-drive/night-drive" });
    expect(bed.many!(3, "night-drive")).toBe("Music: 3 variants added to night-drive");
    expect(bed.many!(2, "")).toBe("Music: 2 variants added");
    expect(variantEvent({ id: "music", stage: "music", name: "Music" }, { id: "bed", name: "Bed" }).text).toBe("Music: “Bed” added");
    const read = variantEvent({ id: "round-2-jules", stage: "voice", name: "Round 2 · Jules" }, { id: "full", name: "Jules, full read" });
    expect(read.text).toBe("Voiceover: “Jules, full read” added to Round 2 · Jules");
    expect(read.many!(1, "Round 2 · Jules")).toBe("Voiceover: 1 read added to Round 2 · Jules");
  });
  it("takes, the script, picks and lock", () => {
    const take = takeEvent({ id: "s1", current: "Every launch starts with a single request." }, { id: "t2" }, 2);
    expect(take).toMatchObject({ area: "voice", kind: "take", text: "Voiceover: take 2 added to S1 “Every launch starts with a…”", ref: "s1:t2" });
    expect(take.many!(3, "S1")).toBe("Voiceover: 3 takes added to S1");
    expect(takeEvent({ id: "s2", current: "  " }, { id: "t1" }, 1).text).toBe("Voiceover: take 1 added to S2");
    expect(scriptEvent(6)).toMatchObject({ area: "script", kind: "script", text: "Script set: 6 sections", merge: "replace" });
    expect(scriptEvent(1).text).toBe("Script set: 1 section");
    const lanes = [
      { id: "round-1", stage: "voice" as const, name: "Round 1", variants: [{ id: "jules", name: "Vo Jules, full read", file: "a.wav", meta: {}, cues: [] }] },
      { id: "music", stage: "music" as const, name: "Music", variants: [{ id: "held", name: "Night drive, held back", file: "b.wav", meta: {}, cues: [] }] },
    ];
    expect(picksEvent({ lanes }, { "round-1": "jules", music: "held" })).toMatchObject({
      area: "mix", kind: "picks", text: "Picks: voice “Vo Jules, full read”, music “Night drive, held back”", merge: "replace", windowMs: 600_000,
    });
    expect(picksEvent({ lanes }, {}).text).toBe("Picks cleared");
    expect(lockEvent(1, { id: "lumen", name: "Lumen", lockedVersion: "v6" })).toMatchObject({ text: "Picture locked at v6", video: "lumen", version: "v6", subject: "lumen" });
    expect(lockEvent(1, { id: "lumen", name: "Lumen", lockedVersion: null }).text).toBe("Picture unlocked");
    expect(lockEvent(2, { id: "teaser", name: "Teaser", lockedVersion: "v2" }).text).toBe("Picture locked at Teaser v2");
    expect(lockEvent(2, { id: "teaser", name: "Teaser", lockedVersion: null }).text).toBe("Picture unlocked for Teaser");
  });
  it("notes sent, replies, files, bring-ins and a line somebody wrote", () => {
    expect(notesSentEvent({ stage: "picture", noteIds: ["a", "b", "c"], sectionIds: [] })).toMatchObject({ area: "notes", kind: "notes-sent", text: "3 notes sent from Picture", tab: "picture", count: 3 });
    expect(notesSentEvent({ stage: "script", noteIds: ["a"], sectionIds: ["s1", "s2"] }).text).toBe("1 note and 2 script edits sent from Script");
    expect(notesSentEvent({ stage: "script", noteIds: [], sectionIds: ["s1"] }).text).toBe("1 script edit sent from Script");
    expect(notesSentEvent({ stage: "picture", noteIds: ["a"], sectionIds: [] }).many!(5, "")).toBe("5 notes sent from several tabs");
    expect(repliesEvent([{ status: "done", stage: "picture" }, { status: "done", stage: "picture" }, { status: "todo", stage: "picture" }])).toMatchObject({
      area: "notes", kind: "replies", text: "Agent replied to 3 notes (2 done)", tab: "picture", merge: "once",
    });
    expect(repliesEvent([{ status: "todo", stage: "music" }, { status: "todo", stage: "picture" }])).toMatchObject({ text: "Agent replied to 2 notes", tab: null });
    const file = fileEvent({ kind: "doc", name: "Creative brief" });
    expect(file).toMatchObject({ area: "assets", kind: "files", text: "File added: Creative brief (Scripts & docs)" });
    expect(file.many!(2, "Scripts & docs")).toBe("2 files added: Scripts & docs");
    expect(broughtInEvent([{ lane: "music", variant: "bed" }, { lane: "vo-jules", variant: "read" }, {}], "v6")).toMatchObject({
      area: "assets", kind: "files", text: "Brought in 3 files with v6", count: 3, clears: ["music/bed", "vo-jules/read"],
    });
    expect(lineEvent("Kept the wide", "picture", { video: "hero", version: "v1" })).toMatchObject({ kind: "entry", merge: "once", area: "picture", video: "hero", version: "v1" });
  });
  it("never carries a note's or a reply's own words: only counts, names and short labels", () => {
    const secret = "the client hates the blue";
    const ev = [
      notesSentEvent({ stage: "picture", noteIds: ["a"], sectionIds: [] }),
      repliesEvent([{ status: "done", stage: "picture" }]),
    ];
    for (const e of ev) expect(JSON.stringify({ ...e, many: e.many?.(2, "x") })).not.toContain(secret);
  });
  it("names the Assets folders exactly as the dashboard does (§16.1)", () => {
    for (const [kind, title] of Object.entries(FILE_FOLDERS)) expect(FOLDERS.find((f) => f.id === kind)?.title, kind).toBe(title);
  });
});

describe("appendEvent (§22.5, R4, Review Focus 3)", () => {
  it("merges into the newest of its kind, area and writer within two minutes, interleaved or not, and moves it to the top", () => {
    const f = empty();
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(0));
    appendEvent(f, variantEvent(sfx, { id: "p", name: "Pass" }), "agent", at(0.5));
    appendEvent(f, variantEvent(music, { id: "b", name: "B" }), "agent", at(1));
    expect(texts(f)).toEqual(["Music: 2 variants added to night-drive", "Sound effects: “Pass” added"]);
    expect(f.entries[1]).toMatchObject({ n: 2, ref: "night-drive/b", at: at(1).toISOString() });
    appendEvent(f, variantEvent(music, { id: "c", name: "C" }), "agent", at(3.5)); // 2.5 min after the last music
    expect(texts(f)[0]).toBe("Music: “C” added to night-drive");
    expect(f.entries).toHaveLength(3);
  });
  it("ten variants in a second, music and sound effects interleaved, make two lines (Review Focus 3)", () => {
    const f = empty();
    for (let i = 0; i < 10; i++) appendEvent(f, variantEvent(i % 2 ? sfx : music, { id: `v${i}`, name: `V${i}` }), "agent", at(i / 600));
    expect(texts(f)).toEqual(["Sound effects: 5 variants added", "Music: 5 variants added to night-drive"]);
  });
  it("a line dated in the future (a clock that was ahead) doesn't swallow everything after it (I2)", () => {
    const f = empty();
    appendEvent(f, variantEvent(music, { id: "early", name: "Early" }), "agent", at(24 * 60)); // tomorrow
    for (let h = 0; h < 20; h++) appendEvent(f, variantEvent(music, { id: `v${h}`, name: `V${h}` }), "agent", at(h * 60));
    expect(f.entries).toHaveLength(21);
    expect(f.entries[0]).toMatchObject({ text: "Music: “Early” added to night-drive", n: 1, at: at(24 * 60).toISOString() });
    expect(texts(f)[0]).toBe("Music: “V19” added to night-drive");
  });
  it("a line a little ahead (within one window) still merges and keeps its later time; one further ahead doesn't", () => {
    const f = empty();
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(1));
    appendEvent(f, variantEvent(music, { id: "b", name: "B" }), "agent", at(0));
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({ n: 2, at: at(1).toISOString() });
    const g = empty();
    appendEvent(g, variantEvent(music, { id: "a", name: "A" }), "agent", at(2.5));
    appendEvent(g, variantEvent(music, { id: "b", name: "B" }), "agent", at(0));
    expect(g.entries).toHaveLength(2);
  });
  it("never merges two writers, or a count across different subjects without dropping the subject", () => {
    const f = empty();
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(0));
    appendEvent(f, variantEvent(music, { id: "b", name: "B" }), "user", at(0.1));
    expect(f.entries).toHaveLength(2);
    appendEvent(f, variantEvent({ id: "other", stage: "music", name: "other" }, { id: "c", name: "C" }), "agent", at(0.2));
    expect(texts(f)[0]).toBe("Music: 2 variants added");
  });
  it("two films' cuts in a burst say so, without naming either film", () => {
    const f = empty();
    appendEvent(f, cutEvent(2, { id: "hero", name: "Hero" }, { id: "v3", note: "v3: tighter", file: "h.mp4" }), "agent", at(0));
    appendEvent(f, cutEvent(2, { id: "teaser", name: "Teaser" }, { id: "v2", note: "v2: end card", file: "t.mp4" }), "agent", at(0.5));
    expect(texts(f)).toEqual(["2 cuts added, the latest Teaser v2: end card"]);
    expect(f.entries[0]).toMatchObject({ video: "teaser", version: "v2", subject: "" });
  });
  it("replace keeps the newest line for the same subject only, and picks merge within ten minutes", () => {
    const f = empty();
    appendEvent(f, lockEvent(2, { id: "hero", name: "Hero", lockedVersion: "v3" }), "user", at(0));
    appendEvent(f, lockEvent(2, { id: "hero", name: "Hero", lockedVersion: null }), "user", at(1));
    appendEvent(f, lockEvent(2, { id: "teaser", name: "Teaser", lockedVersion: "v2" }), "user", at(1.5));
    expect(texts(f)).toEqual(["Picture locked at Teaser v2", "Picture unlocked for Hero"]);
    const lanes = [{ id: "music", stage: "music" as const, name: "Music", variants: [{ id: "a", name: "A", file: "a.wav", meta: {}, cues: [] }, { id: "b", name: "B", file: "b.wav", meta: {}, cues: [] }] }];
    const p = empty();
    appendEvent(p, picksEvent({ lanes }, { music: "a" }), "user", at(0));
    appendEvent(p, picksEvent({ lanes }, { music: "b" }), "user", at(9));
    appendEvent(p, picksEvent({ lanes }, { music: "a" }), "user", at(20));
    expect(texts(p)).toEqual(["Picks: music “A”", "Picks: music “B”"]);
  });
  it("once never merges, but an identical repeat (a retried request) isn't doubled (§22.9)", () => {
    const f = empty();
    const reply = repliesEvent([{ status: "done", stage: "picture" }]);
    appendEvent(f, reply, "agent", at(0));
    appendEvent(f, reply, "agent", at(0.2));
    appendEvent(f, repliesEvent([{ status: "todo", stage: "picture" }]), "agent", at(0.3));
    expect(texts(f)).toEqual(["Agent replied to 1 note", "Agent replied to 1 note (1 done)"]);
  });
  it("a retried cut, variant or take (the same version or ref again) isn't counted twice (§22.9)", () => {
    const f = empty();
    const cut = cutEvent(1, { id: "hero", name: "Hero" }, { id: "v4", note: "v4: slower", file: "h.mp4" });
    appendEvent(f, cut, "agent", at(0));
    appendEvent(f, cut, "agent", at(0.1));
    expect(f.entries).toHaveLength(1);
    expect(f.entries[0]).toMatchObject({ n: 1, text: "v4 added: slower", at: at(0.1).toISOString() });
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(0.2));
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(0.3));
    appendEvent(f, cutEvent(1, { id: "hero", name: "Hero" }, { id: "v5", note: "v5: faster", file: "h5.mp4" }), "agent", at(0.4));
    expect(texts(f)).toEqual(["2 cuts added, the latest v5: faster", "Music: “A” added to night-drive"]);
    // Files and notes carry no identity, so two of them are two, as they should be.
    const g = empty();
    appendEvent(g, fileEvent({ kind: "image", name: "Still" }), "user", at(0));
    appendEvent(g, fileEvent({ kind: "image", name: "Still" }), "user", at(0.1));
    expect(texts(g)).toEqual(["2 files added: Images"]);
  });
  it("stores one clean line and keeps the newest 5000, counting what it drops (Review Focus 2 and 5)", () => {
    const f = empty();
    const e = appendEvent(f, lineEvent("  A decision\nmade late\t", "project"), "agent", at(0));
    expect(e.text).toBe("A decision made late");
    for (let i = 0; i < 5001; i++) appendEvent(f, lineEvent(`Line ${i}`, "project"), "agent", at(i));
    expect(f.entries).toHaveLength(5000);
    expect(f.dropped).toBe(2);
    expect(f.entries[0].text).toBe("Line 1");
    expect(LogFileSchema.safeParse(f).success).toBe(true);
  });
  it("refuses a line with nothing visible in it, leaving the file as it was (Review Focus 2)", () => {
    const f = empty();
    appendEvent(f, lineEvent("Kept", "project"), "agent", at(0));
    const before = structuredClone(f);
    expect(() => appendEvent(f, lineEvent(" \n​‮ ", "project"), "agent", at(1))).toThrow(/blank/);
    expect(f).toEqual(before);
  });
  it("a subject longer than the schema keeps is cut, and the file still validates", () => {
    const f = empty();
    appendEvent(f, variantEvent({ id: "long", stage: "music", name: "n".repeat(500) }, { id: "a", name: "A" }), "agent", at(0));
    expect(Array.from(f.entries[0].subject).length).toBe(200);
    expect(Array.from(f.entries[0].text).length).toBeLessThanOrEqual(160);
    expect(LogFileSchema.safeParse(f).success).toBe(true);
  });
  it("a live event about an undated ref dates it: it leaves Before the log (R5)", () => {
    const f = { ...empty(), undated: ["night-drive/a", "music/bed", "s1:t1"] };
    appendEvent(f, variantEvent(music, { id: "a", name: "A" }), "agent", at(0));
    appendEvent(f, broughtInEvent([{ lane: "music", variant: "bed" }], null), "rushes", at(1));
    expect(f.undated).toEqual(["s1:t1"]);
  });
  it("a log at the cap stays fast: each append on 5000 lines is a fraction of a millisecond, not a copy per line (Review Focus 5)", () => {
    const f = empty();
    for (let i = 0; i < LOG_MAX; i++) appendEvent(f, lineEvent(`Line ${i}`, "project"), "agent", at(i * 3));
    const start = performance.now();
    for (let i = 0; i < 500; i++) appendEvent(f, lineEvent(`More ${i}`, i % 2 ? "picture" : "music"), "agent", at(LOG_MAX * 3 + i * 3));
    const ms = performance.now() - start;
    expect(f.entries).toHaveLength(LOG_MAX);
    expect(f.dropped).toBe(500);
    // Measured at well under 0.1 ms per append; 500 of them under two seconds leaves room for a slow CI box.
    expect(ms).toBeLessThan(2000);
  });
});

describe("backfill and reading back (§22.6)", () => {
  const project = (): Project => {
    const p: Project = { schema: 1, rev: 0, name: "Lumen launch film", fps: 30, videos: [], lanes: [], files: [], autoProxy: false };
    addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", note: "v1: first pass; rough" }, at(-3000));
    addVersion(p, { video: "Hero", file: "renders/hero_v2.mp4", note: "v2 (batch b_1): tighter cut" }, at(-1000));
    addVersion(p, { video: "Hero", file: "renders/hero_v3.mp4", note: "v3: after the log began" }, at(10));
    addFile(p, { kind: "doc", file: "brief.md", name: "Creative brief" }, at(-3100));
    for (const name of ["Night drive", "Held back", "Quiet bed"]) addVariant(p, { stage: "music", lane: "night-drive", name, file: `audio/${name}.wav` });
    p.videos[0].versions.push({ ...p.videos[0].versions[0], id: "v9", addedAt: "" }); // a date that doesn't parse
    return p;
  };
  const batches: BatchesFile = { schema: 1, rev: 1, batches: [{ id: "b_1", stage: "picture", noteIds: ["n_1", "n_2"], sectionIds: [], sentAt: at(-2000).toISOString(), prompt: "" }] };
  const script: Script = { schema: 1, rev: 0, wordsPerSecond: 2.6, sections: [{ id: "s1", start: 0, end: 4, current: "A line.", proposed: null, direction: "", status: "draft", takes: [{ id: "t1", file: "t.wav", duration: null, forText: "A line." }] }] };

  it("reads in what is dated before `before`, in time order and by Rushes, once; skips dates that don't parse", () => {
    const f: LogFile = { schema: 1, rev: 0, backfilled: false, undated: [], dropped: 0, entries: [] };
    backfillLog(f, { project: project(), batches, script }, T0);
    expect(texts(f)).toEqual(["v2 added: tighter cut", "2 notes sent from Picture", "v1 added: first pass", "File added: Creative brief (Scripts & docs)"]);
    expect(f.entries.every((e) => e.by === "rushes")).toBe(true);
    expect(f.backfilled).toBe(true);
    expect(f.undated).toEqual(["night-drive/night-drive", "night-drive/held-back", "night-drive/quiet-bed", "s1:t1"]);
    backfillLog(f, { project: project(), batches, script }, T0);
    expect(f.entries).toHaveLength(4);
  });
  it("a variant a live line already dates is never also undated, whichever came first (R5)", () => {
    const f: LogFile = { schema: 1, rev: 0, backfilled: false, undated: [], dropped: 0, entries: [] };
    appendEvent(f, variantEvent(music, { id: "held-back", name: "Held back" }), "agent", at(5));
    backfillLog(f, { project: project(), batches, script }, T0);
    expect(f.undated).toEqual(["night-drive/night-drive", "night-drive/quiet-bed", "s1:t1"]);
    expect(texts(f)[0]).toBe("Music: “Held back” added to night-drive");
  });
  it("Before the log: one line per lane and one for takes, only for what still exists (Review Focus 4)", () => {
    const p = project();
    expect(undatedLines(undatedRefs(p, script), { project: p, script })).toEqual([
      { area: "music", text: "Music: night-drive (3 variants)" },
      { area: "voice", text: "Voiceover: 1 section with takes" },
    ]);
    expect(undatedLines(["gone/x", "night-drive/missing", "s9:t1"], { project: p, script })).toEqual([]);
    const voice: Project = { ...p, lanes: [{ id: "round-1", stage: "voice", name: "Round 1 · Voices", variants: [{ id: "jane", name: "Jane", file: "j.wav", meta: {}, cues: [] }, { id: "gerald", name: "Gerald", file: "g.wav", meta: {}, cues: [] }] }] };
    expect(undatedLines(["round-1/jane", "round-1/gerald"], { project: voice, script: { sections: [] } })).toEqual([{ area: "voice", text: "Voiceover: Round 1 · Voices (2 reads)" }]);
  });
  it("logView: newest first, limit, area, since, and how many it left out", () => {
    const f = empty();
    for (const [i, area] of (["picture", "music", "picture"] as const).entries()) appendEvent(f, lineEvent(`Line ${i}`, area), "agent", at(i * 5));
    const p = project();
    const ctx = { project: p, script };
    f.undated = ["night-drive/night-drive"];
    expect(logView(f, {}, ctx)).toMatchObject({ earlier: 0, total: 3, dropped: 0, undated: [{ area: "music", text: "Music: night-drive (1 variant)" }] });
    expect(logView(f, {}, ctx).entries.map((e) => e.text)).toEqual(["Line 2", "Line 1", "Line 0"]);
    expect(logView(f, { limit: 1 }, ctx)).toMatchObject({ earlier: 2, entries: [{ text: "Line 2" }] });
    expect(logView(f, { area: "picture" }, ctx).entries.map((e) => e.text)).toEqual(["Line 2", "Line 0"]);
    expect(logView(f, { area: "picture" }, ctx).undated).toEqual([]);
    expect(logView(f, { since: at(4).toISOString() }, ctx)).toMatchObject({ entries: [{ text: "Line 2" }, { text: "Line 1" }], undated: [] });
  });
  it("logView: a limit that isn't a number reads as the default", () => {
    const f = empty();
    appendEvent(f, lineEvent("Line", "project"), "agent", at(0));
    const ctx = { project: project(), script };
    expect(logView(f, { limit: Number.NaN }, ctx)).toMatchObject({ earlier: 0, entries: [{ text: "Line" }] });
  });
});

describe("the log through the store (§22.9, Review Focus 1 and 5)", () => {
  const sources = async (store: Awaited<ReturnType<typeof tmpProject>>["store"]) => ({
    project: await store.read("project"), batches: await store.read("batches"), script: await store.read("script"),
  });

  it("two first reads at once backfill exactly once: update runs one at a time per file", async () => {
    const { store } = await tmpProject("Lumen launch film");
    await store.update("project", (p) => {
      addVersion(p, { video: "Hero", file: "renders/hero_v1.mp4", note: "v1: first pass" }, at(-60));
      addFile(p, { kind: "doc", file: "brief.md", name: "Creative brief" }, at(-90));
    });
    const src = await sources(store);
    const runs = await Promise.all(Array.from({ length: 5 }, () => store.update("log", (f) => backfillLog(f, src, T0))));
    expect(runs.map((r) => r.data.rev)).toEqual([1, 2, 3, 4, 5]);
    const log = await store.read("log");
    expect(log.entries.map((e) => e.text)).toEqual(["File added: Creative brief (Scripts & docs)", "v1 added: first pass"]);
    expect(log.backfilled).toBe(true);
  });

  it("two writers appending at once both land, in order, and the file stays valid", async () => {
    const { store } = await tmpProject();
    const writes = Array.from({ length: 40 }, (_, i) => store.update("log", (f) => appendEvent(f, lineEvent(`From ${i % 2 ? "an agent" : "the dashboard"} ${i}`, "project"), i % 2 ? "agent" : "user", at(i))));
    await Promise.all(writes);
    const log = await store.read("log");
    expect(log.rev).toBe(40);
    expect(log.entries).toHaveLength(40);
    expect(new Set(log.entries.map((e) => e.id)).size).toBe(40);
  });

  it("a full log round-trips through the store: the 5001st line drops one and counts it", async () => {
    const { store } = await tmpProject();
    const f = empty();
    for (let i = 0; i < LOG_MAX; i++) appendEvent(f, lineEvent(`Line ${i}`, "project"), "agent", at(i * 3));
    await store.update("log", (d) => Object.assign(d, f));
    const start = performance.now();
    await store.update("log", (d) => appendEvent(d, lineEvent("One more", "picture"), "user", at(LOG_MAX * 3)));
    const ms = performance.now() - start;
    const log = await store.read("log");
    expect(log.entries).toHaveLength(LOG_MAX);
    expect(log.dropped).toBe(1);
    expect(log.entries.at(-1)?.text).toBe("One more");
    // A read, an append, a validation and an atomic write of the whole file; measured at tens of milliseconds.
    expect(ms).toBeLessThan(1500);
  });
});
