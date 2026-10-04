import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { addVariant, addVersion, setShots, shotAt } from "../core/project.js";
import { addNote } from "../core/notes.js";
import { setSections } from "../core/script.js";
import { toManifestPath } from "../core/paths.js";
import { Store } from "../core/store.js";

// §19.2: `rushes demo` builds an example project, with every byte of media generated on the
// user's machine (nothing downloaded, nothing shipped). The fictional product is "Lumen" --
// brand-neutral, no real company names.

/**
 * Runs one command to completion and collects its output. Spawned with an argument array, never
 * through a shell (global constraints) -- the same contract as the loudness and proxy runners,
 * minus the streaming/abort machinery those need for long jobs: everything `demo` makes is a few
 * seconds of synthetic media.
 */
export interface Runner {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** A `Runner` over `cmd`, via `child_process.spawn` with no shell. */
export function makeRunner(cmd: string): Runner {
  return (args) =>
    new Promise((res) => {
      let stdout = "";
      let stderr = "";
      let child;
      try {
        child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
      } catch {
        res({ code: 1, stdout: "", stderr: "" });
        return;
      }
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("error", () => res({ code: 1, stdout, stderr }));
      child.on("close", (code) => res({ code: code ?? 1, stdout, stderr }));
    });
}

/** The real ffmpeg and `say` runners. `main.ts` injects these (or `null` for `say`) into `makeDemo`. */
export const ffmpegRunner: Runner = makeRunner("ffmpeg");
export const sayRunner: Runner = makeRunner("say");

/** Whether macOS `say` actually works here: `say -v ?` runs and lists at least one voice. */
export async function sayAvailable(run: Runner): Promise<boolean> {
  try {
    const r = await run(["-v", "?"]);
    return r.code === 0 && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export interface DemoDeps {
  /** Spawns ffmpeg. Required: without it, `makeDemo` refuses before writing anything. */
  ffmpeg: Runner;
  /** Spawns macOS `say`, or `null` on a machine without it (or where it didn't answer `-v ?`). */
  say: Runner | null;
  now: Date;
  /** The font file to burn the timecode in with, when it exists. Defaults to macOS's Arial; tests point it elsewhere. */
  font?: string;
}

const PRODUCT = "Lumen";
const DURATION = 30;
const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";

/** Last non-empty line of ffmpeg's stderr, for a short, readable failure message. */
function tail(s: string): string {
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? "ffmpeg gave no reason";
}

/** Refuses a non-empty folder. Otherwise returns whether `dir` already existed (empty) before this run, so a failure part-way through knows how much of it is safe to remove. */
async function checkFolder(dir: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (names.length > 0) throw new Error("That folder isn't empty. Choose a new one: rushes demo <folder>");
  return true;
}

/**
 * Everything `makeDemo` can leave behind under `root`: the `.rushes` project folder and the
 * generated `renders` and `audio` folders. Nothing else is ever created there.
 */
async function removeDemoContents(root: string): Promise<void> {
  await Promise.all([".rushes", "renders", "audio"].map((name) => rm(join(root, name), { recursive: true, force: true })));
}

async function requireFfmpeg(ffmpeg: Runner): Promise<void> {
  let ok: boolean;
  try {
    ok = (await ffmpeg(["-version"])).code === 0;
  } catch {
    ok = false;
  }
  if (!ok) throw new Error("The demo needs ffmpeg to make its media. Run rushes doctor for how to install it.");
}

/**
 * How `drawtext` burns the timecode in: with `font` (a file) when it's on this machine, else with
 * fontconfig's default font (`""`, no `fontfile`) when a one-frame probe shows that works, as it
 * does on most Linux builds -- or `null` to skip the overlay entirely: this ffmpeg wasn't compiled
 * with `drawtext`, or it can't find any font (both common on a minimal install). Never a reason to
 * fail the demo.
 */
async function drawtextFont(ffmpeg: Runner, font: string): Promise<string | null> {
  try {
    const r = await ffmpeg(["-hide_banner", "-filters"]);
    if (r.code !== 0 || !/\bdrawtext\b/.test(`${r.stdout}\n${r.stderr}`)) return null;
    if (existsSync(font)) return font;
    const probe = await ffmpeg(["-hide_banner", "-f", "lavfi", "-i", "color=size=64x64:duration=0.04", "-vf", "drawtext=text=0", "-frames:v", "1", "-f", "null", "-"]);
    return probe.code === 0 ? "" : null;
  } catch {
    return null;
  }
}

/** `font` is a file path, `""` for fontconfig's default, or `null` for no timecode. */
function videoFilter(font: string | null, hue: number | null): string[] {
  const parts: string[] = [];
  if (hue !== null) parts.push(`hue=h=${hue}`);
  if (font !== null) parts.push(`drawtext=${font ? `fontfile=${font}:` : ""}text='%{pts\\:hms}':fontcolor=white:fontsize=36:x=24:y=24:box=1:boxcolor=black@0.5:boxborderw=10`);
  return parts.length ? ["-vf", parts.join(",")] : [];
}

/** A 30 s 1280×720 `testsrc2` cut, optionally hue-shifted, with a burnt-in timecode when `drawtext` is available. */
async function renderCut(ffmpeg: Runner, out: string, opts: { hue: number | null; font: string | null }): Promise<void> {
  const args = [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=25:duration=${DURATION}`,
    ...videoFilter(opts.font, opts.hue),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
    out,
  ];
  const r = await ffmpeg(args);
  if (r.code !== 0) throw new Error(`Couldn't render ${out}: ${tail(r.stderr)}`);
}

/** A placeholder tone, used when `say` isn't available: a plain sine wave, clearly not a voice read. */
async function renderSineTone(ffmpeg: Runner, out: string, freq: number, seconds: number): Promise<void> {
  const args = ["-hide_banner", "-y", "-f", "lavfi", "-i", `sine=frequency=${freq}:duration=${seconds}`, "-ar", "44100", "-ac", "1", out];
  const r = await ffmpeg(args);
  if (r.code !== 0) throw new Error(`Couldn't render ${out}: ${tail(r.stderr)}`);
}

/** A system voice's read of `text`, via `say -v ... -o out.aiff`, then converted to WAV with ffmpeg. */
async function renderSayVoice(say: Runner, ffmpeg: Runner, outWav: string, opts: { voice: string | null; rate?: number; text: string }): Promise<void> {
  const aiff = outWav.replace(/\.wav$/, ".aiff");
  const args: string[] = [];
  if (opts.voice) args.push("-v", opts.voice);
  if (opts.rate) args.push("-r", String(opts.rate));
  args.push("-o", aiff, opts.text);
  const said = await say(args);
  if (said.code !== 0) throw new Error(`"say" couldn't make ${aiff}: ${tail(said.stderr)}`);
  const conv = await ffmpeg(["-hide_banner", "-y", "-i", aiff, "-ar", "44100", "-ac", "1", outWav]);
  if (conv.code !== 0) throw new Error(`Couldn't convert ${aiff}: ${tail(conv.stderr)}`);
  await rm(aiff, { force: true });
}

/** The first two of `say -v ?`'s voices matching `preferred`, in order -- or `[null, null]` to fall back to the default voice for both. */
export function pickVoices(listing: string, preferred: readonly string[] = ["Daniel", "Samantha"]): [string | null, string | null] {
  const names = new Set(
    listing
      .split(/\r?\n/)
      .map((l) => l.trim().split(/\s+/)[0])
      .filter(Boolean),
  );
  const found = preferred.filter((v) => names.has(v));
  if (found.length >= 2) return [found[0], found[1]];
  if (found.length === 1) return [found[0], found[0]];
  return [null, null];
}

async function pickSystemVoices(say: Runner): Promise<[string | null, string | null]> {
  try {
    const r = await say(["-v", "?"]);
    return r.code === 0 ? pickVoices(r.stdout) : [null, null];
  } catch {
    return [null, null];
  }
}

/** A sustained chord from sine partials, via ffmpeg's `aevalsrc`, optionally amplitude-pulsed. */
async function renderChord(ffmpeg: Runner, out: string, opts: { freqs: number[]; seconds: number; pulseHz?: number }): Promise<void> {
  const terms = opts.freqs.map((f) => `0.18*sin(2*PI*${f}*t)`).join("+");
  const envelope = opts.pulseHz ? `*(0.55+0.45*sin(2*PI*${opts.pulseHz}*t))` : "";
  const args = ["-hide_banner", "-y", "-f", "lavfi", "-i", `aevalsrc=(${terms})${envelope}:s=44100:d=${opts.seconds}`, "-ar", "44100", "-ac", "2", out];
  const r = await ffmpeg(args);
  if (r.code !== 0) throw new Error(`Couldn't render ${out}: ${tail(r.stderr)}`);
}

/** Three short, band-passed, faded noise bursts at `times`, mixed over `totalSeconds` of silence -- the classic "whoosh" recipe. */
async function renderWhooshes(ffmpeg: Runner, out: string, times: number[], totalSeconds: number): Promise<void> {
  const burstDur = 0.8;
  const inputs = times.flatMap(() => ["-f", "lavfi", "-i", `anoisesrc=color=pink:duration=${burstDur}:sample_rate=44100`]);
  inputs.push("-f", "lavfi", "-i", `anullsrc=channel_layout=mono:sample_rate=44100:duration=${totalSeconds}`);
  const chains = times.map((t, i) => {
    const delayMs = Math.max(0, Math.round(t * 1000));
    return `[${i}:a]highpass=f=300,lowpass=f=3500,afade=t=in:d=0.15,afade=t=out:st=${(burstDur - 0.2).toFixed(2)}:d=0.2,adelay=${delayMs}:all=1[w${i}]`;
  });
  const labels = `${times.map((_, i) => `[w${i}]`).join("")}[${times.length}:a]`;
  const filter = `${chains.join(";")};${labels}amix=inputs=${times.length + 1}:normalize=0[outa]`;
  const args = ["-hide_banner", "-y", ...inputs, "-filter_complex", filter, "-map", "[outa]", "-ac", "1", out];
  const r = await ffmpeg(args);
  if (r.code !== 0) throw new Error(`Couldn't render ${out}: ${tail(r.stderr)}`);
}

/**
 * Builds a ready-to-explore example project in `dir` (§19.2): a test-pattern film in two cuts with
 * shots, a four-section script, two rounds of voice reads, two music beds, an SFX pass with cues,
 * example notes on every stage, and picks set for music and round 1. Every file is generated here,
 * with ffmpeg (and macOS `say`, when it's there) -- nothing is downloaded or shipped.
 *
 * Refuses, without writing anything, when `dir` exists and isn't empty, or when ffmpeg isn't
 * available through `deps.ffmpeg`. A failure after that point -- say isn't playing along, or
 * ffmpeg chokes on one of the renders -- undoes everything this run created (the whole folder,
 * if it didn't exist before; just what's inside it, if it did) and rethrows with a one-line
 * reason, so nothing a user runs twice ever looks like a half-built project.
 */
export async function makeDemo(dir: string, deps: DemoDeps): Promise<{ dir: string }> {
  const root = resolve(dir);
  // Decided before anything is written: whether a failure part-way through should remove `root`
  // itself (we created it) or only what we put inside it (it was already there, empty).
  const existedBefore = await checkFolder(root);
  await requireFfmpeg(deps.ffmpeg);

  try {
    const store = new Store(root);
    await store.init(`${PRODUCT} launch demo`);

    // The layout README and AGENTS recommend: renders/ for cuts, audio/<voiceover|music|sfx>/ for the rest.
    const rendersDir = join(root, "renders");
    const voiceDir = join(root, "audio", "voiceover");
    const musicDir = join(root, "audio", "music");
    const sfxDir = join(root, "audio", "sfx");
    await Promise.all([rendersDir, voiceDir, musicDir, sfxDir].map((d) => mkdir(d, { recursive: true })));

    const font = await drawtextFont(deps.ffmpeg, deps.font ?? FONT);

    // 1. The picture: a 30 s test-pattern film in two cuts, v2 hue-shifted, with shots every 6 s.
    const v1Abs = join(rendersDir, "lumen-launch_v1.mp4");
    const v2Abs = join(rendersDir, "lumen-launch_v2.mp4");
    await renderCut(deps.ffmpeg, v1Abs, { hue: null, font });
    await renderCut(deps.ffmpeg, v2Abs, { hue: 100, font });

    let videoId = "";
    let pictureNoteShot: ReturnType<typeof shotAt> = null;
    const pictureNoteT = 10;
    await store.update("project", (p) => {
      const { video, version: v1 } = addVersion(p, { video: `${PRODUCT} launch`, file: toManifestPath(root, v1Abs), duration: DURATION, fps: 25, note: "First cut of the test pattern" }, deps.now);
      videoId = video.id;
      const cut = setShots(p, video.id, v1.id, [0, 6, 12, 18, 24].map((start, i) => ({ name: `Shot ${i + 1}`, start })));
      // Stamped as the server stamps a note made in the dashboard (app.ts, POST /api/notes).
      pictureNoteShot = shotAt(cut.shots, pictureNoteT);
      addVersion(p, { video: videoId, file: toManifestPath(root, v2Abs), duration: DURATION, fps: 25, note: "Hue pass, for comparison" }, deps.now);
    });

    // 2. The script: four plain sections about the fictional product.
    const sections = [
      { id: "s1", start: 0, end: 7.5, current: `${PRODUCT} opens on a blank timeline and a flashing cursor.` },
      { id: "s2", start: 7.5, end: 15, current: `Drop in a folder of clips, and ${PRODUCT} finds the best takes on its own.` },
      { id: "s3", start: 15, end: 22.5, current: "Notes, picks and a locked cut travel with the project, not a chat log." },
      { id: "s4", start: 22.5, end: 30, current: `${PRODUCT}: fewer rounds, and a cut everyone signed off on.` },
    ];
    await store.update("script", (s) => {
      setSections(s, sections, { replace: true });
    });

    // 3. Voice reads, two rounds: Round 1 compares two voices; Round 2 is one voice at a slower pace.
    const scriptText = sections.map((s) => s.current).join(" ");
    const hasSay = deps.say !== null;
    const [voiceA, voiceB] = hasSay ? await pickSystemVoices(deps.say!) : [null, null];

    const round1AWav = join(voiceDir, "round-1-voice-a.wav");
    const round1BWav = join(voiceDir, "round-1-voice-b.wav");
    const round2Wav = join(voiceDir, "round-2-voice-a-slower.wav");
    if (hasSay) {
      await renderSayVoice(deps.say!, deps.ffmpeg, round1AWav, { voice: voiceA, text: scriptText });
      await renderSayVoice(deps.say!, deps.ffmpeg, round1BWav, { voice: voiceB, text: scriptText });
      await renderSayVoice(deps.say!, deps.ffmpeg, round2Wav, { voice: voiceA, rate: 140, text: scriptText });
    } else {
      await renderSineTone(deps.ffmpeg, round1AWav, 440, 10);
      await renderSineTone(deps.ffmpeg, round1BWav, 554, 10);
      await renderSineTone(deps.ffmpeg, round2Wav, 440, 12);
    }
    // Short names for the note text; the read names spell out why there's no voice.
    const shortA = hasSay ? "Voice A" : "Placeholder A";
    const shortB = hasSay ? "Voice B" : "Placeholder B";
    const voiceAName = hasSay ? shortA : `${shortA} (no text-to-speech on this machine)`;
    const voiceBName = hasSay ? shortB : `${shortB} (no text-to-speech on this machine)`;
    const placeholder = "A placeholder tone, not a read";

    let round1LaneId = "";
    let voiceAId = "";
    await store.update("project", (p) => {
      const { lane, variant } = addVariant(p, { stage: "voice", round: "Round 1 · Voices", name: voiceAName, file: toManifestPath(root, round1AWav), description: hasSay ? "The script at a natural pace" : placeholder });
      round1LaneId = lane.id;
      voiceAId = variant.id;
      addVariant(p, { stage: "voice", round: "Round 1 · Voices", name: voiceBName, file: toManifestPath(root, round1BWav), description: hasSay ? "A second voice, same script and pace" : placeholder });
      addVariant(p, { stage: "voice", round: "Round 2 · Voice A, pace", name: "Voice A · slower", file: toManifestPath(root, round2Wav), description: "Based on Voice A, slower" });
    });

    // 4. Music beds: two synthesised chords at different tempos.
    const warmPadWav = join(musicDir, "warm-pad.wav");
    const pulseWav = join(musicDir, "pulse.wav");
    await renderChord(deps.ffmpeg, warmPadWav, { freqs: [196, 246.94, 293.66], seconds: 12 });
    await renderChord(deps.ffmpeg, pulseWav, { freqs: [220, 277.18, 329.63], seconds: 12, pulseHz: 2.5 });

    let musicVariantId = "";
    await store.update("project", (p) => {
      const { variant } = addVariant(p, { stage: "music", name: "Warm pad", file: toManifestPath(root, warmPadWav) });
      musicVariantId = variant.id;
      addVariant(p, { stage: "music", name: "Pulse", file: toManifestPath(root, pulseWav) });
    });

    // 5. One SFX pass, three whooshes with cues.
    const sfxWav = join(sfxDir, "pass-a.wav");
    const cueTimes = [1.5, 4.5, 7.5];
    await renderWhooshes(deps.ffmpeg, sfxWav, cueTimes, 9);
    await store.update("project", (p) => {
      addVariant(p, {
        stage: "sfx",
        name: "Pass A",
        file: toManifestPath(root, sfxWav),
        cues: [
          { name: "Whoosh 1", t: cueTimes[0] },
          { name: "Whoosh 2", t: cueTimes[1] },
          { name: "Whoosh 3", t: cueTimes[2] },
        ],
      });
    });

    // 6. Picks: music and round 1, with music's level set to -12 dB so Mix shows a level.
    await store.update("picks", (picks) => {
      picks.lanes.music = musicVariantId;
      picks.lanes[round1LaneId] = voiceAId;
      picks.levels.music = -12;
    });

    // 7. Example notes: a point on Picture, a whole note on a Round 1 read, a range note with "Fall"
    // on Music, and a whole note on Mix.
    const voiceNote = hasSay ? `${shortA} reads warmer than ${shortB}. Lean that way for launch.` : `${shortA} over ${shortB} for now. Swap in real reads before launch.`;
    await store.update("notes", (notes) => {
      addNote(notes, { stage: "picture", video: videoId, version: "v1", scope: "point", t: pictureNoteT, shot: pictureNoteShot, text: "Hold the opening frame a beat longer before the cut." }, deps.now);
      addNote(notes, { stage: "voice", on: `${round1LaneId}/${voiceAId}`, scope: "whole", text: voiceNote }, deps.now);
      addNote(notes, { stage: "music", on: `music/${musicVariantId}`, scope: "range", t: 6, tOut: 9, marks: [{ kind: "fall" }], text: "Let the pad fall away under the last line." }, deps.now);
      addNote(notes, { stage: "mix", on: null, scope: "whole", text: "Check the whole mix against a phone speaker before sign-off." }, deps.now);
    });

    return { dir: root };
  } catch (e) {
    // A failure here must never leave a half-built project looking like a real one. Only `root`
    // itself is treated carefully: remove it whole when we created it, or just what we put inside
    // it when it was already there (and, by `checkFolder` above, already empty) -- never anything
    // we didn't create.
    await (existedBefore ? removeDemoContents(root) : rm(root, { recursive: true, force: true }));
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`The demo couldn't finish (${reason}). Nothing was left behind.`);
  }
}
