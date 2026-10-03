// Mix (§17.6): three lanes (Voiceover, Music, Sound effects), each with M and S, and a loudness
// readout under them.
//
// The VO lane plays exactly what the Voiceover tab calls the picks: a picked whole-read voice
// variant, else the assembled read (each section's pick, else its newest take). Music and Sound
// effects play their picked variants; a lane with nothing picked, or whose file is missing, is an
// empty lane with the missing mark and is never measured.
//
// Mute and solo are view state: lane gains on the one clock (solo wins), never saved, and reset when
// you leave the tab. Only the lanes you hear are sent to the loudness readout.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.js";
import { assembleRead, assetRev, type Clip, laneGains } from "../audio/timeline.js";
import {
  defaultVersion, loudnessLanes, type LoudnessState, loudnessReadout, MIX_LANES, type MixLane, type MixModel, mixNoteRows,
  mixOnLabel, mixOnOptions, pickedVoiceRow, sectionLabel, STAGE_NAMES, type VariantRow, variantRows, WHOLE_MIX,
} from "../lib.js";
import type { Asset, LoudnessResult, State, Video } from "../types.js";
import { AudioStage, type Preview } from "./AudioStage.js";
import { Icon } from "./Icon.js";
import type { StageRow } from "./Lanes.js";

const COLOR: Record<MixLane, string> = { vo: "#4FD1C5", music: "#A78BFA", sfx: "#FB923C" };
const NAME: Record<MixLane, string> = { vo: "Voiceover", music: "Music", sfx: "Sound effects" };
/** The readout waits this long after the last change before measuring (§17.6). */
export const LOUDNESS_DEBOUNCE_MS = 500;

type LaneView = { muted: boolean; solo: boolean };
const UNTOUCHED: Record<MixLane, LaneView> = { vo: { muted: false, solo: false }, music: { muted: false, solo: false }, sfx: { muted: false, solo: false } };

export interface MixProps {
  state: State;
  assets: Asset[];
  /** The film whose cut the preview plays. */
  video: Video | null;
  toast(message: string): void;
  onChanged(): void;
  /** A half-typed note or a range is waiting: the caller refuses a film switch meanwhile. */
  onPendingChange?(pending: boolean): void;
}

export function Mix({ state, assets, video, toast, onChanged, onPendingChange }: MixProps) {
  const asset = (path: string) => assets.find((a) => a.path === path);
  const rev = (path: string) => {
    const a = asset(path);
    return a ? assetRev(a) : undefined;
  };
  const missing = (path: string) => asset(path)?.missing === true;
  const lanePicks = state.picks.lanes;

  // ---- what each lane plays ----
  // VO: the picked whole-read variant replaces the read, as on Voiceover and in the server's mix.
  const sections = state.script.sections;
  const voiceVariant = pickedVoiceRow(variantRows(state.project.lanes, "voice"), lanePicks);
  const readClips = assembleRead(sections, state.picks.sections, "vo");
  const voClips: Clip[] = voiceVariant
    ? missing(voiceVariant.file) ? [] : [{ id: voiceVariant.key, lane: "vo", path: voiceVariant.file, offset: 0, duration: 0, rev: rev(voiceVariant.file) }]
    : readClips.filter((c) => !missing(c.path)).map((c) => ({ ...c, rev: rev(c.path) }));
  const voGone = voiceVariant ? missing(voiceVariant.file) : readClips.length > 0 && voClips.length === 0;

  const variants = { music: variantRows(state.project.lanes, "music"), sfx: variantRows(state.project.lanes, "sfx") };
  const picked = (rows: VariantRow[]) => rows.filter((r) => lanePicks[r.lane] === r.variant);
  const pickedRows = { music: picked(variants.music), sfx: picked(variants.sfx) };
  const heardRows = { music: pickedRows.music.filter((r) => !missing(r.file)), sfx: pickedRows.sfx.filter((r) => !missing(r.file)) };
  const variantClips = (lane: "music" | "sfx"): Clip[] =>
    heardRows[lane].map((r) => ({ id: r.key, lane, path: r.file, offset: 0, duration: 0, rev: rev(r.file) }));

  const clipsOf: Record<MixLane, Clip[]> = { vo: voClips, music: variantClips("music"), sfx: variantClips("sfx") };
  const heard: Record<MixLane, boolean> = { vo: voClips.length > 0, music: clipsOf.music.length > 0, sfx: clipsOf.sfx.length > 0 };
  const model: MixModel = { variants, heard: { vo: heard.vo, music: heardRows.music, sfx: heardRows.sfx } };
  const options = mixOnOptions(model);

  // ---- mute and solo: view state only ----
  const [view, setView] = useState(UNTOUCHED);
  const gains = laneGains(MIX_LANES.map((id) => ({ id, ...view[id] })));
  const toggle = (lane: MixLane, key: keyof LaneView) => setView((v) => ({ ...v, [lane]: { ...v[lane], [key]: !v[lane][key] } }));

  // ---- the lanes ----
  const metaOf = (lane: MixLane): string | null => {
    if (lane === "vo") return voiceVariant ? voiceVariant.name : readClips.length > 0 ? "Assembled read" : null;
    return pickedRows[lane].map((r) => r.name).join(" · ") || null;
  };
  const emptyTip = (lane: MixLane): string | null => {
    if (heard[lane]) return null;
    if (lane === "vo") return voGone ? "Missing" : "Nothing picked";
    return pickedRows[lane].length > 0 ? "Missing" : "Nothing picked";
  };
  const rows: StageRow[] = MIX_LANES.map((lane) => ({
    key: lane,
    name: NAME[lane],
    meta: metaOf(lane),
    color: COLOR[lane],
    clips: clipsOf[lane],
    labels: lane === "vo" && !voiceVariant ? sections.map((s) => ({ t: s.start, text: sectionLabel(s.id) })) : undefined,
    cues: lane === "sfx" ? heardRows.sfx.flatMap((r) => r.cues) : undefined,
    on: options.find((o) => o.row === lane)?.value,
    missing: emptyTip(lane) ?? undefined,
    controls: (
      <>
        <button type="button" class="ms" aria-pressed={view[lane].muted} aria-label={`Mute ${NAME[lane]}`} data-tip="Mute" onClick={() => toggle(lane, "muted")}>M</button>
        <button type="button" class="ms" aria-pressed={view[lane].solo} aria-label={`Solo ${NAME[lane]}`} data-tip="Solo" onClick={() => toggle(lane, "solo")}>S</button>
      </>
    ),
  }));

  // ---- loudness (§17.6): the lanes you hear, debounced, never blocking ----
  const want = loudnessLanes(heard, gains);
  // Anything that changes the mix re-measures: the lanes, and what each plays (picks, takes, re-renders).
  const signature = JSON.stringify({ want, clips: MIX_LANES.map((l) => clipsOf[l].map((c) => [c.path, c.rev ?? "", c.offset])) });
  const [loudness, setLoudness] = useState<LoudnessState>({ kind: "waiting" });
  const [measuring, setMeasuring] = useState(false);
  const asked = useRef(0);
  useEffect(() => {
    const ask = ++asked.current;
    if (want.length === 0) {
      setLoudness({ kind: "empty" });
      setMeasuring(false);
      return;
    }
    setMeasuring(true);
    const timer = window.setTimeout(() => {
      api.post<LoudnessResult>("/api/mix/loudness", { lanes: want }).then(
        (result) => {
          if (ask === asked.current) setLoudness({ kind: "result", result });
        },
        (e) => {
          if (ask === asked.current) setLoudness({ kind: e instanceof ApiError && e.status === 504 ? "timeout" : "error" });
        },
      ).finally(() => {
        if (ask === asked.current) setMeasuring(false);
      });
    }, LOUDNESS_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [signature]);
  // A reading that lands after you've left the tab is dropped.
  useEffect(() => () => void ++asked.current, []);

  const readout = (
    <div class="meter" aria-label="Loudness" aria-busy={measuring}>
      {loudnessReadout(loudness).map((c) => (
        <div data-cell={c.id}>
          <b data-value data-tip={c.tip ?? undefined} aria-description={c.tip ?? undefined}>{c.value}</b>
          <span>{c.label}</span>
        </div>
      ))}
      {measuring && (
        <span class="smk measuring" data-measuring data-tip="Measuring" aria-label="Measuring"><Icon name="gauge" /></span>
      )}
    </div>
  );

  const notes = state.notes.notes.filter((n) => n.stage === "mix");
  const cut = defaultVersion(video ?? undefined);
  const preview: Preview | null = video && cut ? { video: video.id, version: cut.id, file: cut.file, duration: cut.duration } : null;
  const fps = state.project.fps || 30;

  return (
    <AudioStage
      stage="mix"
      title={STAGE_NAMES.mix}
      belowLanes={readout}
      rows={rows}
      preview={preview}
      fps={fps}
      notes={notes}
      onOptions={options}
      defaultOn={WHOLE_MIX}
      listen={() => ({ select: {}, gains })}
      noteRow={(n) => mixNoteRows(model, n.on)}
      onLabel={(n) => mixOnLabel(model, n.on)}
      toast={toast}
      onChanged={onChanged}
      onPendingChange={onPendingChange}
    />
  );
}
