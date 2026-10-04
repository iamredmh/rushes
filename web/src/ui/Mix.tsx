// Mix (§17.6): three lanes (Voiceover, Music, Sound effects), each with M and S, and a loudness
// readout under them.
//
// The VO lane plays the newest voice round's pick, walking back past rounds with none (§18.4),
// matching the server. Music and Sound effects play their picked variants; a lane with nothing
// picked, or whose file is missing, is an empty lane with the missing mark and is never measured.
//
// Mute and solo are view state: lane gains on the one clock (solo wins), never saved, and reset when
// you leave the tab. Only the lanes you hear are sent to the loudness readout.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../api.js";
import { assetRev, type Clip, laneGains } from "../audio/timeline.js";
import {
  clampLevel, defaultVersion, heardVoice, LEVEL_MAX, LEVEL_MIN, LEVEL_STEP, levelText, loudnessLanes, type LoudnessState, loudnessReadout,
  MIX_LANES, type MixLane, type MixModel, mixNoteRows, MIX_STAGE, mixOnLabel, mixOnOptions, STAGE_NAMES, type VariantRow, variantRows,
  voiceRounds, WHOLE_MIX,
} from "../lib.js";
import type { Asset, LoudnessResult, State, Video } from "../types.js";
import { AudioStage, type Preview } from "./AudioStage.js";
import { Icon } from "./Icon.js";
import type { StageRow } from "./Lanes.js";

const COLOR: Record<MixLane, string> = { vo: "#4FD1C5", music: "#A78BFA", sfx: "#FB923C" };
const NAME: Record<MixLane, string> = { vo: "Voiceover", music: "Music", sfx: "Sound effects" };
/** The readout waits this long after the last change before measuring (§17.6). */
export const LOUDNESS_DEBOUNCE_MS = 500;
/** A level is saved this long after the last drag (§19.6): the slider itself stays live the whole time. */
export const LEVEL_SAVE_DEBOUNCE_MS = 300;

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
  // VO: the newest voice round's pick, walking back past rounds with none (§18.4), as the server mixes it.
  const voiceRead = heardVoice(voiceRounds(state.project.lanes, lanePicks));
  const voClips: Clip[] = voiceRead && !missing(voiceRead.file)
    ? [{ id: voiceRead.key, lane: "vo", path: voiceRead.file, offset: 0, duration: 0, rev: rev(voiceRead.file) }]
    : [];
  const voGone = voiceRead ? missing(voiceRead.file) : false;

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
  const toggle = (lane: MixLane, key: keyof LaneView) => setView((v) => ({ ...v, [lane]: { ...v[lane], [key]: !v[lane][key] } }));

  // ---- levels (§19.6): saved with the picks, in dB. The slider stays live (and the engine hears
  // every tick) while the save to /api/picks is debounced, so dragging never spams the server. ----
  const pickLevels = state.picks.levels;
  const savedLevel = (lane: MixLane): number => pickLevels[MIX_STAGE[lane]] ?? 0;
  const [levels, setLevels] = useState<Record<MixLane, number>>(() => ({ vo: savedLevel("vo"), music: savedLevel("music"), sfx: savedLevel("sfx") }));
  const saveTimers = useRef<Partial<Record<MixLane, number>>>({});
  // Picked up elsewhere (another tab, the agent, or your own save landing) -- but never for a lane
  // with a save still pending: a refresh racing your own debounce must not snap the slider you're
  // dragging back to the stale server value underneath your hand.
  const savedKey = JSON.stringify(pickLevels);
  useEffect(() => {
    setLevels((v) => {
      let changed = false;
      const next = { ...v };
      for (const lane of MIX_LANES) {
        if (saveTimers.current[lane] !== undefined) continue;
        const saved = savedLevel(lane);
        if (next[lane] !== saved) {
          next[lane] = saved;
          changed = true;
        }
      }
      return changed ? next : v;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);
  useEffect(
    () => () => {
      for (const id of Object.values(saveTimers.current)) window.clearTimeout(id);
    },
    [],
  );
  const setLevel = (lane: MixLane, db: number) => {
    const clamped = clampLevel(db);
    setLevels((v) => (v[lane] === clamped ? v : { ...v, [lane]: clamped }));
    const timers = saveTimers.current;
    if (timers[lane] !== undefined) window.clearTimeout(timers[lane]);
    timers[lane] = window.setTimeout(() => {
      delete timers[lane];
      // 0 dB is the default: saved as a clear (null), same as the key never having been set.
      api.put("/api/picks", { levels: { [MIX_STAGE[lane]]: clamped === 0 ? null : clamped } }).then(onChanged, (e) => {
        toast(e instanceof ApiError ? e.message : "Couldn't save the level");
      });
    }, LEVEL_SAVE_DEBOUNCE_MS);
  };

  const gains = laneGains(MIX_LANES.map((id) => ({ id, ...view[id], level: levels[id] })));

  // ---- the lanes ----
  const metaOf = (lane: MixLane): string | null => {
    if (lane === "vo") return voiceRead ? `${voiceRead.laneName} · ${voiceRead.name}` : null;
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
    cues: lane === "sfx" ? heardRows.sfx.flatMap((r) => r.cues) : undefined,
    on: options.find((o) => o.row === lane)?.value,
    missing: emptyTip(lane) ?? undefined,
    controls: (
      <>
        <button type="button" class="ms" aria-pressed={view[lane].muted} aria-label={`Mute ${NAME[lane]}`} data-tip="Mute" onClick={() => toggle(lane, "muted")}>M</button>
        <button type="button" class="ms" aria-pressed={view[lane].solo} aria-label={`Solo ${NAME[lane]}`} data-tip="Solo" onClick={() => toggle(lane, "solo")}>S</button>
        <label class="level" data-tip={`Level for ${NAME[lane]}. Double-click to reset.`}>
          <input
            type="range"
            min={LEVEL_MIN}
            max={LEVEL_MAX}
            step={LEVEL_STEP}
            value={levels[lane]}
            aria-label={`${NAME[lane]} level`}
            onInput={(e) => setLevel(lane, Number((e.target as HTMLInputElement).value))}
            onDblClick={() => setLevel(lane, 0)}
          />
          <span class="db mono">{levelText(levels[lane])} dB</span>
        </label>
      </>
    ),
  }));

  // ---- loudness (§17.6): the lanes you hear, debounced, never blocking ----
  const want = loudnessLanes(heard, gains);
  // Anything that changes the mix re-measures: the lanes, what each plays (picks, takes, re-renders),
  // and the levels -- the server applies them before measuring, so this follows the saved value
  // (`pickLevels`), not the slider mid-drag, which it can't see yet anyway.
  const signature = JSON.stringify({ want, levels: pickLevels, clips: MIX_LANES.map((l) => clipsOf[l].map((c) => [c.path, c.rev ?? "", c.offset])) });
  const [loudness, setLoudness] = useState<LoudnessState>({ kind: "waiting" });
  const [measuring, setMeasuring] = useState(false);
  // Bumped by clicking the readout after a timeout or an error: the server never caches either, so
  // asking again with unchanged data really measures again.
  const [retry, setRetry] = useState(0);
  const retryable = loudness.kind === "timeout" || loudness.kind === "error";
  const asked = useRef(0);
  useEffect(() => {
    const ask = ++asked.current;
    if (want.length === 0) {
      setLoudness({ kind: "empty" });
      setMeasuring(false);
      return;
    }
    // A reason there's no number ("Nothing to measure", a timeout, an error) is stale the moment a
    // new reading is on its way: show the plain dash until it lands.
    setLoudness((s) => (s.kind === "empty" || s.kind === "timeout" || s.kind === "error" ? { kind: "waiting" } : s));
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
  }, [signature, retry]);
  // A reading that lands after you've left the tab is dropped.
  useEffect(() => () => void ++asked.current, []);

  const readout = (
    <div
      class={retryable ? "meter retry" : "meter"}
      role="group"
      aria-label="Loudness"
      aria-busy={measuring}
      onClick={retryable ? () => setRetry((n) => n + 1) : undefined}
    >
      {loudnessReadout(loudness).map((c) => (
        <div data-cell={c.id}>
          <b data-value data-tip={c.tip ?? undefined} aria-description={c.tip ?? undefined}>{c.value}</b>
          <span>{c.label}</span>
        </div>
      ))}
      {measuring && (
        <span class="smk measuring" data-measuring data-tip="Measuring" aria-label="Measuring"><Icon name="gauge" /></span>
      )}
      {retryable && !measuring && (
        // The keyboard's way to the same retry; a click on it bubbles to the readout's own handler.
        <button type="button" class="btn ghost ib" data-tip="Measure again" aria-label="Measure again"><Icon name="gauge" /></button>
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
      film={video?.id ?? null}
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
