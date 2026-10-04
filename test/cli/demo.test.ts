import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDemo, makeRunner, pickVoices, type DemoDeps, type Runner } from "../../src/cli/demo.js";
import { fromManifestPath } from "../../src/core/paths.js";
import { Store } from "../../src/core/store.js";
import { onLabel } from "../../src/core/notes.js";

const made: string[] = [];
afterEach(async () => {
  while (made.length) await rm(made.pop()!, { recursive: true, force: true });
});

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rushes-demo-test-"));
  made.push(dir);
  return dir;
}

/** Always succeeds, without touching the filesystem: good enough for a "good run" with fake runners. */
function fakeFfmpeg(): Runner {
  return async (args) => {
    if (args[0] === "-hide_banner" && args.includes("-filters")) return { code: 0, stdout: "... drawtext ...\n", stderr: "" };
    return { code: 0, stdout: "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers\n", stderr: "" };
  };
}

function fakeFfmpegMissing(): Runner {
  return async () => ({ code: 1, stdout: "", stderr: "" });
}

/** Succeeds like `fakeFfmpeg`, except the first cut render fails -- for exercising cleanup on a failure part-way through a run. */
function fakeFfmpegFailsOnFirstRender(): Runner {
  return async (args) => {
    if (args.some((a) => a.includes("testsrc2"))) return { code: 1, stdout: "", stderr: "synthetic failure for the regression test" };
    if (args[0] === "-hide_banner" && args.includes("-filters")) return { code: 0, stdout: "... drawtext ...\n", stderr: "" };
    return { code: 0, stdout: "ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers\n", stderr: "" };
  };
}

function fakeSay(): Runner {
  return async (args) => {
    if (args[0] === "-v" && args[1] === "?") return { code: 0, stdout: "Daniel              en_GB    # Hello!\nSamantha            en_US    # Hello!\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

function deps(over: Partial<DemoDeps> = {}): DemoDeps {
  return { ffmpeg: fakeFfmpeg(), say: fakeSay(), now: new Date("2026-10-04T10:00:00Z"), ...over };
}

function has(bin: string): boolean {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const FFMPEG = has("ffmpeg") && has("ffprobe");
const SAY = process.platform === "darwin" && has("say");

describe("makeDemo", () => {
  it("refuses a non-empty folder, and writes nothing", async () => {
    const dir = await emptyDir();
    await writeFile(join(dir, "already-here.txt"), "hello", "utf8");
    await expect(makeDemo(dir, deps())).rejects.toThrow("That folder isn't empty. Choose a new one: rushes demo <folder>");
    expect(await readdir(dir)).toEqual(["already-here.txt"]);
  });

  it("refuses without ffmpeg, and writes nothing", async () => {
    const dir = await emptyDir();
    await expect(makeDemo(dir, deps({ ffmpeg: fakeFfmpegMissing() }))).rejects.toThrow(
      "The demo needs ffmpeg to make its media. Run rushes doctor for how to install it.",
    );
    expect(await readdir(dir)).toEqual([]);
  });

  it("builds a project with everything §19.2 asks for, with fake runners", async () => {
    const dir = await emptyDir();
    const { dir: made_ } = await makeDemo(dir, deps());
    expect(made_).toBe(dir);

    const store = new Store(dir);
    const project = await store.read("project");
    expect(project.videos).toHaveLength(1);
    expect(project.videos[0].versions).toHaveLength(2);
    expect(project.videos[0].versions[0].shots.length).toBeGreaterThan(0);

    const laneIds = project.lanes.filter((l) => l.stage === "voice").map((l) => l.id);
    expect(laneIds).toContain("round-1-voices");
    expect(laneIds).toContain("round-2-voice-a-pace");
    const round1 = project.lanes.find((l) => l.id === "round-1-voices")!;
    expect(round1.variants.map((v) => v.name)).toEqual(["Voice A", "Voice B"]);
    const round2 = project.lanes.find((l) => l.id === "round-2-voice-a-pace")!;
    expect(round2.variants.map((v) => v.name)).toEqual(["Voice A · slower"]);

    const musicVariants = project.lanes.filter((l) => l.stage === "music").flatMap((l) => l.variants);
    expect(musicVariants).toHaveLength(2);
    expect(musicVariants.map((v) => v.name).sort()).toEqual(["Pulse", "Warm pad"]);

    const sfxLanes = project.lanes.filter((l) => l.stage === "sfx");
    expect(sfxLanes).toHaveLength(1);
    expect(sfxLanes[0].variants).toHaveLength(1);
    expect(sfxLanes[0].variants[0].cues).toHaveLength(3);

    const picks = await store.read("picks");
    expect(picks.levels.music).toBe(-12);
    expect(picks.lanes.music).toBe("warm-pad");
    expect(picks.lanes["round-1-voices"]).toBe("voice-a");

    const notes = await store.read("notes");
    expect(notes.notes).toHaveLength(4);
    expect(notes.notes.map((n) => n.stage).sort()).toEqual(["mix", "music", "picture", "voice"]);
    const musicNote = notes.notes.find((n) => n.stage === "music")!;
    expect(musicNote.scope).toBe("range");
    expect(musicNote.marks).toEqual([{ kind: "fall" }]);
    const voiceNote = notes.notes.find((n) => n.stage === "voice")!;
    expect(voiceNote.scope).toBe("whole");
    const pictureNote = notes.notes.find((n) => n.stage === "picture")!;
    expect(pictureNote.scope).toBe("point");
    const mixNote = notes.notes.find((n) => n.stage === "mix")!;
    expect(mixNote.scope).toBe("whole");

    const script = await store.read("script");
    expect(script.sections).toHaveLength(4);
    expect(script.sections.filter((s) => s.current.includes("Lumen")).length).toBeGreaterThan(0);
  });

  it("puts the Voiceover note on a real Round 1 read, named in its text (§18.3: no 'Assembled read')", async () => {
    const dir = await emptyDir();
    await makeDemo(dir, deps());
    const store = new Store(dir);
    const project = await store.read("project");
    const notes = await store.read("notes");
    const voiceNote = notes.notes.find((n) => n.stage === "voice")!;
    expect(voiceNote.on).toBe("round-1-voices/voice-a");
    const [laneId, variantId] = voiceNote.on!.split("/");
    expect(project.lanes.find((l) => l.id === laneId)?.variants.some((v) => v.id === variantId)).toBe(true);
    expect(voiceNote.text).toContain("Voice A");
    expect(onLabel(voiceNote, { project, script: await store.read("script") })).toBe("Round 1 · Voices · Voice A");
  });

  it("names the placeholders, not voices, in the Voiceover note when there's no text-to-speech", async () => {
    const dir = await emptyDir();
    await makeDemo(dir, deps({ say: null }));
    const notes = await new Store(dir).read("notes");
    const voiceNote = notes.notes.find((n) => n.stage === "voice")!;
    expect(voiceNote.on).toMatch(/^round-1-voices\/placeholder-a/);
    expect(voiceNote.text).toContain("Placeholder A");
    expect(voiceNote.text).not.toContain("Voice A");
  });

  it("gives every read a one-line description, and Round 2's says what it's based on", async () => {
    const dir = await emptyDir();
    await makeDemo(dir, deps());
    const project = await new Store(dir).read("project");
    const reads = project.lanes.filter((l) => l.stage === "voice").flatMap((l) => l.variants);
    for (const r of reads) expect(String(r.meta.description ?? "").trim()).not.toBe("");
    const round2 = project.lanes.find((l) => l.id === "round-2-voice-a-pace")!;
    expect(round2.variants[0].meta.description).toBe("Based on Voice A, slower");
  });

  it("stamps the Picture note with its shot, as a note made in the dashboard would be", async () => {
    const dir = await emptyDir();
    await makeDemo(dir, deps());
    const notes = await new Store(dir).read("notes");
    expect(notes.notes.find((n) => n.stage === "picture")!.shot).toEqual({ n: 2, name: "Shot 2" });
  });

  it("lays the media out as README and AGENTS recommend: renders/ and audio/<voiceover|music|sfx>/", async () => {
    const dir = await emptyDir();
    await makeDemo(dir, deps());
    const project = await new Store(dir).read("project");
    for (const v of project.videos[0].versions) expect(v.file).toMatch(/^renders\//);
    const byStage = (stage: string) => project.lanes.filter((l) => l.stage === stage).flatMap((l) => l.variants.map((v) => v.file));
    for (const f of byStage("voice")) expect(f).toMatch(/^audio\/voiceover\//);
    for (const f of byStage("music")) expect(f).toMatch(/^audio\/music\//);
    for (const f of byStage("sfx")) expect(f).toMatch(/^audio\/sfx\//);
    expect((await readdir(dir)).sort()).toEqual([".rushes", "audio", "renders"]);
  });

  it("burns the timecode in through fontconfig when the macOS font isn't there but drawtext works without one", async () => {
    const dir = await emptyDir();
    const calls: string[][] = [];
    const ffmpeg: Runner = async (args) => {
      calls.push(args);
      if (args.includes("-filters")) return { code: 0, stdout: "... drawtext ...\n", stderr: "" };
      return { code: 0, stdout: "ffmpeg version 8.1\n", stderr: "" };
    };
    await makeDemo(dir, deps({ ffmpeg, font: join(dir, "no-such-font.ttf") }));
    const cuts = calls.filter((a) => a.some((x) => x.includes("testsrc2")));
    expect(cuts).toHaveLength(2);
    for (const c of cuts) {
      const vf = c[c.indexOf("-vf") + 1] ?? "";
      expect(vf).toContain("drawtext=text=");
      expect(vf).not.toContain("fontfile");
    }
  });

  it("skips the timecode, and still finishes, when drawtext can't find a font at all", async () => {
    const dir = await emptyDir();
    const calls: string[][] = [];
    const ffmpeg: Runner = async (args) => {
      calls.push(args);
      if (args.includes("-filters")) return { code: 0, stdout: "... drawtext ...\n", stderr: "" };
      // The fontconfig probe: drawtext with no fontfile fails on a build without fontconfig.
      if (args.some((x) => x.startsWith("drawtext"))) return { code: 1, stdout: "", stderr: "Cannot find a valid font" };
      return { code: 0, stdout: "ffmpeg version 8.1\n", stderr: "" };
    };
    await makeDemo(dir, deps({ ffmpeg, font: join(dir, "no-such-font.ttf") }));
    const cuts = calls.filter((a) => a.some((x) => x.includes("testsrc2")));
    expect(cuts).toHaveLength(2);
    for (const c of cuts) expect(c.join(" ")).not.toContain("drawtext");
  });

  it("falls back to sine-tone placeholders when `say` isn't available", async () => {
    const dir = await emptyDir();
    await makeDemo(dir, deps({ say: null }));
    const store = new Store(dir);
    const project = await store.read("project");
    const round1 = project.lanes.find((l) => l.id === "round-1-voices")!;
    expect(round1.variants.map((v) => v.name)).toEqual([
      "Placeholder A (no text-to-speech on this machine)",
      "Placeholder B (no text-to-speech on this machine)",
    ]);
    // Round 2 keeps its name even as a placeholder -- it's the pace variation, not the TTS story.
    const round2 = project.lanes.find((l) => l.id === "round-2-voice-a-pace")!;
    expect(round2.variants.map((v) => v.name)).toEqual(["Voice A · slower"]);
  });

  it("picks the first two preferred voices it finds in `say -v ?`'s listing", () => {
    const listing = "Daniel              en_GB    # Hello!\nSamantha            en_US    # Hello!\nAlex                en_US    # Hello!\n";
    expect(pickVoices(listing)).toEqual(["Daniel", "Samantha"]);
    expect(pickVoices("Alex                en_US    # Hello!\n")).toEqual([null, null]);
    expect(pickVoices("Daniel              en_GB    # Hello!\n")).toEqual(["Daniel", "Daniel"]);
  });
});

describe("makeDemo, cleanup on a failure part-way through", () => {

  it("removes the folder entirely when it didn't exist before the run, and a retry into the same path then works", async () => {
    const base = await emptyDir();
    const dir = join(base, "fresh-demo"); // doesn't exist yet -- makeDemo must create (and, on failure, remove) it.

    await expect(makeDemo(dir, deps({ ffmpeg: fakeFfmpegFailsOnFirstRender() }))).rejects.toThrow(
      /^The demo couldn't finish \(.*\)\. Nothing was left behind\.$/,
    );
    await expect(readdir(dir)).rejects.toThrow(/ENOENT/);

    const { dir: made_ } = await makeDemo(dir, deps());
    expect(made_).toBe(dir);
    expect((await readdir(dir)).sort()).toEqual([".rushes", "audio", "renders"]);
  });

  it("leaves a pre-existing empty folder in place, untouched, and a retry into the same path then works", async () => {
    const dir = await emptyDir(); // pre-existing and empty, per the first refusal check.

    await expect(makeDemo(dir, deps({ ffmpeg: fakeFfmpegFailsOnFirstRender() }))).rejects.toThrow(
      /^The demo couldn't finish \(.*\)\. Nothing was left behind\.$/,
    );
    expect(await readdir(dir)).toEqual([]); // the folder itself survives, still empty.

    const { dir: made_ } = await makeDemo(dir, deps());
    expect(made_).toBe(dir);
    expect((await readdir(dir)).sort()).toEqual([".rushes", "audio", "renders"]);
  });
});

describe.runIf(FFMPEG)("makeDemo, with real ffmpeg", () => {
  it("produces playable media files", async () => {
    const dir = await emptyDir();
    const { dir: made_ } = await makeDemo(dir, {
      ffmpeg: makeRunner("ffmpeg"),
      say: SAY ? makeRunner("say") : null,
      now: new Date(),
    });

    const store = new Store(made_);
    const project = await store.read("project");
    const files = [
      ...project.videos.flatMap((v) => v.versions.map((ver) => ver.file)),
      ...project.lanes.flatMap((l) => l.variants.map((v) => v.file)),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const abs = fromManifestPath(made_, f);
      const bytes = await readFile(abs).then((b) => b.length, () => 0);
      expect(bytes).toBeGreaterThan(0);
      const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", abs], { encoding: "utf8" });
      expect(out.trim().length).toBeGreaterThan(0);
    }
  }, 60_000);
});
