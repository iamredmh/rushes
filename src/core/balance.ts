// §29: the house balance. Given each take's loudness over time, how far to move the music and effects faders so the
// three sounds sit against each other: the voice rings true over the music on every spoken line, the music holds a set
// level, and every effect is heard, not hidden under the bed. Pure: the readings come from ffmpeg (server/balance.ts),
// and `rushes balance` runs the same rule on files for the agent that makes the sound.
//
// The numbers are calibrated by ear on Red's Meet your agents mix (19 Nov 2026): the music he settled on sits level
// with the voice's integrated loudness, the voice still clears it in the speech band on every line, and the effects
// pass he wanted heard needed about +10 dB, which puts each hit about 1 dB under the music around it.
import { LEVEL_MAX, LEVEL_MIN, LEVEL_STEP, type LaneStage, type Levels } from "./schema.js";

/** One ebur128 reading, every 0.1 s: momentary (400 ms) and short-term (3 s) loudness, LUFS. Silence is -120. */
export interface Frame {
  t: number;
  m: number;
  s: number;
}

/** A take measured whole: its integrated loudness (null when silent or unread) and its frames. */
export interface Reading {
  integrated: number | null;
  frames: Frame[];
}

/** What the rule needs of each take: the full-band reading, and for voice and music the speech band too. */
export interface TakeReadings {
  full: Reading;
  /** The same take through the speech band (SPEECH_BAND): where music covers a voice, and where it doesn't. */
  band?: Reading;
}

export const BALANCE = {
  /** LU the music's integrated loudness sits under the voice's (0: level with it). */
  musicUnderVoice: 0,
  /** LU the voice must clear the music by, in the speech band, on every spoken line. */
  voiceClearance: 1,
  /** dB each effect's momentary peak sits under the music's short-term level around it. */
  sfxUnderGroove: 1,
  /** With no music in use: dB each effect's peak sits under the voice's integrated loudness. */
  sfxUnderVoice: 6,
  /** With no voice in use: the music's integrated loudness, LUFS. */
  musicAlone: -20,
  /** With neither: each effect's momentary peak, LUFS. */
  sfxAlone: -20,
  /** dBTP the balanced mix may peak at: over it, every sound comes down together (`trimmed`). */
  peakCeiling: -1,
} as const;

/** The band a voice is understood in: ffmpeg filters applied before measuring voice and music for clearance. */
export const SPEECH_BAND = { low: 300, high: 4000 } as const;

const SILENT = -70;
const FRAME_S = 0.1;

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > SILENT;
const pow = (db: number) => 10 ** (db / 10);
const toDb = (p: number) => (p > 0 ? 10 * Math.log10(p) : -120);
/** Loudness of several readings together: their power averaged, not their dB. */
const energyMean = (dbs: number[]) => (dbs.length === 0 ? -120 : toDb(dbs.reduce((a, d) => a + pow(d), 0) / dbs.length));

/** The frames of a reading by index (frame i covers t ≈ (i + 1) × 0.1 s), so two takes line up frame for frame. */
function byIndex(frames: Frame[]): Map<number, Frame> {
  const out = new Map<number, Frame>();
  for (const f of frames) out.set(Math.round(f.t / FRAME_S) - 1, f);
  return out;
}

/** A stretch where the voice is speaking, as frame indexes. */
export interface Line {
  start: number;
  end: number;
  frames: number[];
}

/**
 * Where the voice speaks: frames within 20 LU of its integrated loudness, joined across pauses of 0.4 s or less, and
 * at least 0.3 s long. A breath between words stays inside one line; a gap between sentences ends it.
 */
export function spokenLines(voice: Reading): Line[] {
  if (!finite(voice.integrated)) return [];
  const floor = Math.max(voice.integrated - 20, SILENT);
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const f of voice.frames) {
    if (f.m <= floor) continue;
    const i = Math.round(f.t / FRAME_S) - 1;
    if (cur && f.t - cur.end <= 0.4 + 1e-9) {
      cur.end = f.t;
      cur.frames.push(i);
    } else {
      cur = { start: f.t, end: f.t, frames: [i] };
      lines.push(cur);
    }
  }
  return lines.filter((l) => l.end - l.start >= 0.3 - 1e-9);
}

/** One effect: the frames where it sounds, joined across gaps of 0.3 s or less, and its loudest momentary reading. */
export interface Hit {
  t: number;
  index: number;
  peak: number;
}

/** The effects in a pass: everything within 30 dB of the pass's loudest moment (and above -60 LUFS). */
export function effectHits(sfx: Reading): Hit[] {
  const loudest = Math.max(-120, ...sfx.frames.map((f) => f.m));
  if (loudest <= SILENT) return [];
  const floor = Math.max(loudest - 30, -60);
  const hits: (Hit & { end: number })[] = [];
  let cur: (Hit & { end: number }) | null = null;
  for (const f of sfx.frames) {
    if (f.m <= floor) continue;
    const i = Math.round(f.t / FRAME_S) - 1;
    if (cur && f.t - cur.end <= 0.3 + 1e-9) {
      cur.end = f.t;
      if (f.m > cur.peak) Object.assign(cur, { peak: f.m, t: f.t, index: i });
    } else {
      cur = { t: f.t, index: i, peak: f.m, end: f.t };
      hits.push(cur);
    }
  }
  return hits.map(({ t, index, peak }) => ({ t, index, peak }));
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** A fader setting: on the 0.5 dB step and inside the fader's range. */
export function toLevel(db: number): number {
  const stepped = Math.round(db / LEVEL_STEP) * LEVEL_STEP;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, stepped)) + 0; // + 0: never -0
}

export interface BalanceReport {
  /** The voice's integrated loudness, LUFS (its fader stays at 0). */
  voice: number | null;
  music: null | {
    level: number;
    /** What set it: level with the voice, held back so the voice clears it, or (no voice) the set level. */
    by: "voice" | "clearance" | "alone";
    /** LU the voice clears the music by on its closest line, at the new level (speech band). Null with no lines. */
    clearance: number | null;
  };
  sfx: null | {
    level: number;
    /** How many effects were found. */
    hits: number;
    /** What the effects were set against. */
    by: "music" | "voice" | "alone";
  };
  /** Sounds whose fader hit the end of its range: the take itself needs to be louder (or quieter). */
  clamped: LaneStage[];
  /** dB every sound came down by together so the mix doesn't clip (0: no need). */
  trim: number;
}

export interface Balance {
  levels: Levels;
  report: BalanceReport;
}

/**
 * The house balance for whichever of voice, music and effects are in use. The voice stays at 0 dB: it is the
 * reference. Music is set level with the voice (BALANCE.musicUnderVoice), then pulled back if the voice would clear it
 * by less than BALANCE.voiceClearance in the speech band on any spoken line. Effects are set so the median hit peaks
 * BALANCE.sfxUnderGroove dB under the music's short-term level at that moment (after the music's own move). A sound
 * that is silent, or wasn't read, gets no level.
 */
export function balance(takes: Partial<Record<LaneStage, TakeReadings>>): Balance {
  const levels: Levels = {};
  const clamped: LaneStage[] = [];
  const set = (stage: LaneStage, db: number): number => {
    const level = toLevel(db);
    if (db > LEVEL_MAX + LEVEL_STEP / 2 || db < LEVEL_MIN - LEVEL_STEP / 2) clamped.push(stage);
    levels[stage] = level;
    return level;
  };

  const voice = takes.voice && finite(takes.voice.full.integrated) ? takes.voice : undefined;
  const music = takes.music && finite(takes.music.full.integrated) ? takes.music : undefined;
  const sfx = takes.sfx && takes.sfx.full.frames.some((f) => f.m > SILENT) ? takes.sfx : undefined;
  const report: BalanceReport = { voice: voice ? voice.full.integrated : null, music: null, sfx: null, clamped, trim: 0 };

  if (voice) levels.voice = 0;

  // ---- music ----
  let musicGain = 0;
  if (music) {
    const mI = music.full.integrated as number;
    if (voice) {
      const vI = voice.full.integrated as number;
      let want = vI - BALANCE.musicUnderVoice - mI;
      let by: "voice" | "clearance" = "voice";
      const margins = clearances(voice, music);
      if (margins.length > 0) {
        const closest = Math.min(...margins);
        const limit = closest - BALANCE.voiceClearance;
        if (limit < want) {
          want = limit;
          by = "clearance";
        }
      }
      musicGain = set("music", want);
      report.music = { level: musicGain, by, clearance: margins.length > 0 ? round1(Math.min(...margins) - musicGain) : null };
    } else {
      musicGain = set("music", BALANCE.musicAlone - mI);
      report.music = { level: musicGain, by: "alone", clearance: null };
    }
  }

  // ---- effects ----
  if (sfx) {
    const hits = effectHits(sfx.full);
    const groove = music ? byIndex(music.full.frames) : null;
    const vI = voice ? (voice.full.integrated as number) : null;
    let by: "music" | "voice" | "alone" = music ? "music" : voice ? "voice" : "alone";
    const moves = hits.map((h) => {
      const g = groove?.get(h.index)?.s;
      // A hit where the music is silent (before it starts, say) is set against the voice, or the set level.
      if (finite(g)) return g + musicGain - BALANCE.sfxUnderGroove - h.peak;
      if (vI !== null) return vI - BALANCE.sfxUnderVoice - h.peak;
      return BALANCE.sfxAlone - h.peak;
    });
    const move = median(moves);
    if (move !== null) {
      if (music && hits.every((h) => !finite(groove?.get(h.index)?.s))) by = voice ? "voice" : "alone";
      report.sfx = { level: set("sfx", move), hits: hits.length, by };
    }
  }

  return { levels, report };
}

/** On each spoken line: how far the voice is over the music in the speech band, LU, with the music at 0 dB. */
function clearances(voice: TakeReadings, music: TakeReadings): number[] {
  if (!voice.band || !music.band) return [];
  const vb = byIndex(voice.band.frames);
  const mb = byIndex(music.band.frames);
  return spokenLines(voice.full).map((line) => {
    const v = energyMean(line.frames.map((i) => vb.get(i)?.m ?? -120));
    const m = energyMean(line.frames.map((i) => mb.get(i)?.m ?? -120));
    return v - m;
  });
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * A balance brought down so the mix peaks at BALANCE.peakCeiling at most: every sound by the same amount (rounded up to
 * the fader's step), voice included, so they still sit the same against each other. `truePeak` is the balanced mix's,
 * dBTP. Unchanged when it is under the ceiling or unknown.
 */
export function trimmed(b: Balance, truePeak: number | null): Balance {
  if (truePeak === null || !Number.isFinite(truePeak) || truePeak <= BALANCE.peakCeiling) return b;
  const by = Math.ceil((truePeak - BALANCE.peakCeiling) / LEVEL_STEP) * LEVEL_STEP;
  const levels: Levels = {};
  for (const stage of ["voice", "music", "sfx"] as const) if (b.levels[stage] !== undefined) levels[stage] = toLevel(b.levels[stage]! - by);
  const { music, sfx } = b.report;
  return {
    levels,
    report: { ...b.report, music: music && { ...music, level: levels.music! }, sfx: sfx && { ...sfx, level: levels.sfx! }, trim: -by },
  };
}

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "\u2212" : ""}${Math.abs(n)} dB`;

/** What a balance did, in a sentence or two, for the desk's toast, the agent and the CLI. */
export function balanceSummary(r: BalanceReport): string {
  const parts: string[] = [];
  if (r.music) {
    const why =
      r.music.by === "alone" ? "at the set level, with no voice in use"
        : r.music.by === "clearance" ? `held back so the voice clears it by ${BALANCE.voiceClearance} LU on every line`
        : "level with the voice";
    parts.push(`Music ${signed(r.music.level)}, ${why}.`);
  }
  if (r.sfx) {
    const against = r.sfx.by === "music" ? "just under the music around them" : r.sfx.by === "voice" ? "under the voice" : "at the set level";
    parts.push(`Effects ${signed(r.sfx.level)}: ${r.sfx.hits} ${r.sfx.hits === 1 ? "hit" : "hits"} ${against}.`);
  }
  if (parts.length === 0) parts.push(r.voice !== null ? "Only the voice is in use: nothing to balance against it." : "Nothing in use to balance.");
  if (r.trim < 0) parts.push(`Everything ${signed(r.trim)} so the mix doesn't clip.`);
  if (r.clamped.length > 0) parts.push(`${r.clamped.map((s) => NAMES[s]).join(" and ")} hit the end of the fader: that take needs re-rendering at a different level.`);
  return parts.join(" ");
}

const NAMES: Record<LaneStage, string> = { voice: "Voice", music: "Music", sfx: "Effects" };

/**
 * The per-frame lines of an ebur128 run (`t: 1.2  TARGET:-23 LUFS  M: -20.1 S: -22.3 ...`). `-inf` and `nan` read as
 * silence.
 */
export function parseFrames(stderr: string): Frame[] {
  const out: Frame[] = [];
  const num = (s: string) => (s === "-inf" || s === "nan" || s === "inf" ? -120 : Number(s));
  for (const m of stderr.matchAll(/\bt:\s*([\d.]+)\s+TARGET:[^\n]*?\bM:\s*(-?inf|nan|-?[\d.]+)\s+S:\s*(-?inf|nan|-?[\d.]+)/g)) {
    out.push({ t: Number(m[1]), m: num(m[2]), s: num(m[3]) });
  }
  return out;
}
