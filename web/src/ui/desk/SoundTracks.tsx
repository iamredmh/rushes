// §27, 5.6: sound on the timeline. Under the Picture track, one row each for Voice, Music and Effects (a swatch, the
// name, its take count, M, S and the level, then one block: the take in use with its waveform), and a Cut sound row
// when the cut file has a sound of its own. The takes in use play through one engine that follows the picture.
//
// What was the Mix tab lives here: mute and solo are view state (never saved, reset when you leave the tab); levels
// are saved with the picks, debounced; and the loudness of what you hear is measured, debounced, for the transport.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../../api.js";
import { type LoadResult } from "../../audio/engine.js";
import { assetRev, type Clip, laneGains, mediaKey } from "../../audio/timeline.js";
import { useFollower } from "../../audio/useFollower.js";
import { cueKeys, cueLabel, cueName, cuesInTime } from "../../cues.js";
import { takeCount, takeGroups, type TakeGroups, type TakeRow } from "../../desk.js";
import {
  clampLevel, filmLanes, filmPicks, LEVEL_MAX, LEVEL_MIN, LEVEL_STEP, levelText, loudnessLanes, type LoudnessState, loudnessReadout, MIX_LANES,
  type MixLane, type MixModel, mixOnLabel, MIX_STAGE, takeInUse, variantRows, type VariantRow,
} from "../../lib.js";
import type { Asset, LoudnessResult, Note, State, Version, Video } from "../../types.js";
import { audioTestHook } from "../AudioStage.js";
import { CUE_CARD_ID, CueCard, cardHover, useCueCard } from "../CueCard.js";
import { rovingKeyDown } from "../CueLayers.js";
import { Icon } from "../Icon.js";
import { Wave } from "../Lanes.js";
import { PictureWave, usePictureWave } from "../PictureWave.js";

/** The readout waits this long after the last change before measuring (§17.6). */
export const LOUDNESS_DEBOUNCE_MS = 500;
/** A level is saved this long after the last drag (§19.6): the slider itself stays live the whole time. */
export const LEVEL_SAVE_DEBOUNCE_MS = 300;

const COLOR: Record<MixLane, string> = { vo: "var(--vo)", music: "var(--music)", sfx: "var(--sfx)" };
const NAME: Record<MixLane, string> = { vo: "Voice", music: "Music", sfx: "Effects" };
/** What a sound's takes are called, for its count's tooltip. */
const NOUN: Record<MixLane, string> = { vo: "read", music: "bed", sfx: "pass" };
/** The tab each sound's count opens. */
export type SoundTab = "voice" | "music" | "sfx";

type LaneView = { muted: boolean; solo: boolean };
const UNTOUCHED: Record<MixLane, LaneView> = { vo: { muted: false, solo: false }, music: { muted: false, solo: false }, sfx: { muted: false, solo: false } };

/** One sound's row: its takes, the one in use, and what its block says. */
export interface SoundRow {
  lane: MixLane;
  groups: TakeGroups;
  /** The take in use, or null. */
  take: TakeRow | null;
  /** What the engine plays for it, when its file is on disk. */
  clip: Clip | null;
  /** The block: a take playing, its file gone, nothing in use while takes wait, or no takes at all. */
  block: "take" | "missing" | "broken" | "waiting" | "none";
}

export interface MixInput {
  state: State;
  assets: Asset[];
  video: Video;
  /** The cut on screen: its own sound is the Cut sound row. */
  version: Version;
  /** The <video> on the monitor: the clock the takes follow. */
  player: { current: HTMLVideoElement | null };
  /** The cut's length as the player knows it, for a waveform the browser has to make itself. */
  duration: number;
  /** The transport's volume and mute: what you hear of the takes, as of the picture. */
  monitor: { level: number; muted: boolean };
  toast(message: string): void;
  onChanged(): void;
}

export interface Mix {
  rows: SoundRow[];
  media: Record<string, LoadResult | "error">;
  view: Record<MixLane, LaneView>;
  toggle(lane: MixLane, key: keyof LaneView): void;
  levels: Record<MixLane, number>;
  setLevel(lane: MixLane, db: number): void;
  /** Any take in use: the video is muted, the readout shows, and notes can be on the mix. */
  inUse: boolean;
  /** The cut's own sound, when it has one (null while it isn't known, and for a silent cut). */
  cutWave: ReturnType<typeof usePictureWave>;
  /** The Cut sound row's M: muted while any take is in use, until pressed. */
  cutMuted: boolean;
  toggleCut(): void;
  /** Whether the <video> plays its own sound muted. */
  videoMuted: boolean;
  loudness: { state: LoudnessState; measuring: boolean; retry(): void };
  /** What a note on the mix is on, for the notes list ("Whole mix", "Music · Warm keys"); null for any other note. */
  noteLabel(n: Note): string | null;
}

/** Everything the Timeline tab's sound needs: what plays, how loud, what is heard and what it measures. */
export function useMix({ state, assets, video, version, player, duration, monitor, toast, onChanged }: MixInput): Mix {
  const asset = (path: string) => assets.find((a) => a.path === path);
  const filmId = video.id;
  const filmState = filmPicks(state.picks, filmId);
  const use = filmState.use;
  // Only this film's reads, beds and passes (and any made for every film), as the server measures them.
  const lanes = filmLanes(state.project.lanes, filmId, state.project.videos.length);

  // ---- what each sound plays: one take, the one in use, as the server worked it out (§27.6) ----
  const planned: SoundRow[] = MIX_LANES.map((lane) => {
    const groups = takeGroups(lanes, MIX_STAGE[lane], use?.[MIX_STAGE[lane]], video);
    const take = groups.inUse;
    if (!take) return { lane, groups, take, clip: null, block: takeCount(groups).all > 0 ? "waiting" : "none" };
    const file = take.variant.file;
    const a = asset(file);
    if (a?.missing) return { lane, groups, take, clip: null, block: "missing" };
    const clip: Clip = { id: `${take.lane}/${take.variant.id}`, lane, path: file, offset: 0, duration: 0, rev: a ? assetRev(a) : undefined };
    return { lane, groups, take, clip, block: "take" };
  });
  const clips = planned.flatMap((r) => (r.clip ? [r.clip] : []));
  const inUse = planned.some((r) => r.take !== null);

  // ---- mute and solo: view state only ----
  const [view, setView] = useState(UNTOUCHED);
  const toggle = (lane: MixLane, key: keyof LaneView) => setView((v) => ({ ...v, [lane]: { ...v[lane], [key]: !v[lane][key] } }));
  const [cutChoice, setCutChoice] = useState<boolean | null>(null);
  const cutMuted = cutChoice ?? inUse;

  // ---- levels (§19.6): saved with the picks, in dB. The slider stays live (and the engine hears every tick) while
  // the save to /api/picks is debounced, so dragging never spams the server. ----
  const pickLevels = filmState.levels;
  const savedLevel = (lane: MixLane): number => pickLevels[MIX_STAGE[lane]] ?? 0;
  const [levels, setLevels] = useState<Record<MixLane, number>>(() => ({ vo: savedLevel("vo"), music: savedLevel("music"), sfx: savedLevel("sfx") }));
  // Each lane's debounced save still to go: its timer, and the save itself, so leaving the tab can send it at once.
  const saveTimers = useRef<Partial<Record<MixLane, { id: number; send: (keepalive?: boolean) => void }>>>({});
  // Picked up elsewhere (another tab, the agent, or your own save landing) -- but never for a lane with a save still
  // pending: a refresh racing your own debounce must not snap the slider you're dragging back to the stale value.
  const savedKey = `${filmId}:${JSON.stringify(pickLevels)}`;
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
  // Sends every save still waiting on its debounce, now. Each is taken off the list as it goes: never sent twice.
  const flushSaves = (keepalive: boolean) => {
    const timers = saveTimers.current;
    for (const lane of MIX_LANES) {
      const pending = timers[lane];
      if (!pending) continue;
      window.clearTimeout(pending.id);
      delete timers[lane];
      pending.send(keepalive);
    }
  };
  // Leaving the tab (a key pressed mid-drag, say) flushes every pending save instead of dropping it. So does the page
  // being hidden or left: nothing unmounts then, and the timer dies with the page, so the save goes as a keepalive.
  useEffect(() => {
    const onHide = () => flushSaves(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushSaves(true);
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      flushSaves(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setLevel = (lane: MixLane, db: number) => {
    const clamped = clampLevel(db);
    setLevels((v) => (v[lane] === clamped ? v : { ...v, [lane]: clamped }));
    const timers = saveTimers.current;
    if (timers[lane] !== undefined) window.clearTimeout(timers[lane].id);
    // 0 dB is the default: saved as a clear (null), same as the key never having been set.
    const send = (keepalive = false) =>
      void api.put("/api/picks", { video: filmId, levels: { [MIX_STAGE[lane]]: clamped === 0 ? null : clamped } }, { keepalive }).then(onChanged, (e) => {
        toast(e instanceof ApiError ? e.message : "Couldn't save the level");
      });
    const id = window.setTimeout(() => {
      delete timers[lane];
      send();
    }, LEVEL_SAVE_DEBOUNCE_MS);
    timers[lane] = { id, send };
  };

  // What the mix is (mute, solo, levels), and what you hear of it (the transport's volume and mute on top).
  const gains = laneGains(MIX_LANES.map((id) => ({ id, ...view[id], level: levels[id] })));
  const master = monitor.muted ? 0 : monitor.level;
  const heardGains = Object.fromEntries(Object.entries(gains).map(([lane, g]) => [lane, g * master]));
  const { media, engine } = useFollower(player, clips, heardGains);
  // A file that won't play at all says so on its block; the others play on.
  const rows = planned.map((r): SoundRow => (r.clip && media[mediaKey(r.clip)] === "error" ? { ...r, block: "broken" } : r));
  const anySolo = MIX_LANES.some((l) => view[l].solo);

  // ---- the test hook (only with ?test=1) ----
  useLayoutEffect(() => {
    if (audioTestHook) audioTestHook.clips = clips;
  });
  useEffect(() => {
    const hook = audioTestHook;
    if (!hook) return;
    hook.engine = engine;
    return () => {
      if (hook.engine === engine) hook.engine = null;
    };
  }, [engine]);

  // ---- the cut's own sound: its waveform answers whether it has one (§19.9). Always the original's, even with a proxy. ----
  const cutAsset = asset(version.file);
  const cutWave = usePictureWave(video.id, version, cutAsset?.size ?? null, cutAsset ? assetRev(cutAsset) : undefined, version.duration ?? duration);

  // ---- loudness (§17.6): the sounds you hear, debounced, never blocking ----
  const heard: Record<MixLane, boolean> = { vo: false, music: false, sfx: false };
  for (const r of planned) heard[r.lane] = r.clip !== null;
  const want = inUse ? loudnessLanes(heard, gains) : [];
  // Anything that changes the mix re-measures: the sounds, what each plays (picks, re-renders) and the saved levels
  // (the server applies them before measuring, so this follows the saved value, not the slider mid-drag).
  const signature = JSON.stringify({ want, film: filmId, levels: pickLevels, clips: clips.map((c) => [c.path, c.rev ?? ""]) });
  const [loudness, setLoudness] = useState<LoudnessState>({ kind: "waiting" });
  const [measuring, setMeasuring] = useState(false);
  // Bumped by clicking the readout after a timeout or an error: the server caches neither, so it really measures again.
  const [retries, setRetries] = useState(0);
  const asked = useRef(0);
  useEffect(() => {
    const ask = ++asked.current;
    if (want.length === 0) {
      setLoudness({ kind: "empty" });
      setMeasuring(false);
      return;
    }
    // A reason there's no number is stale the moment a new reading is on its way: show the plain dash until it lands.
    setLoudness((s) => (s.kind === "empty" || s.kind === "timeout" || s.kind === "error" ? { kind: "waiting" } : s));
    setMeasuring(true);
    const timer = window.setTimeout(() => {
      api.post<LoudnessResult>("/api/mix/loudness", { lanes: want, video: filmId }).then(
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
  }, [signature, retries]);
  // A reading that lands after you've left the tab is dropped.
  useEffect(() => () => void ++asked.current, []);

  // ---- notes on the mix: what each is on, as the Mix tab named it ----
  const variants = { music: variantRows(lanes, "music"), sfx: variantRows(lanes, "sfx") };
  const heardRows = (stage: "music" | "sfx"): VariantRow[] => variants[stage].filter((r) => takeInUse(use, stage, r) && !asset(r.file)?.missing);
  const model: MixModel = { variants, heard: { vo: heard.vo, music: heardRows("music"), sfx: heardRows("sfx") } };

  return {
    rows,
    media,
    view,
    toggle,
    levels,
    setLevel,
    inUse,
    cutWave,
    cutMuted,
    toggleCut: () => setCutChoice(!cutMuted),
    videoMuted: cutMuted || anySolo,
    loudness: { state: loudness, measuring, retry: () => setRetries((n) => n + 1) },
    noteLabel: (n) => (n.stage === "mix" ? mixOnLabel(model, n.on) : null),
  };
}

export interface SoundTracksProps {
  mix: Mix;
  /** The cut's length: the rows share the Picture track's time scale. */
  duration: number;
  t: number;
  onSeek(t: number): void;
  /** A take count was clicked: open that sound's tab. */
  onOpenTab?(tab: SoundTab): void;
}

const TAB: Record<MixLane, SoundTab> = { vo: "voice", music: "music", sfx: "sfx" };

/** The rows under the Picture track. */
export function SoundTracks({ mix, duration, t, onSeek, onOpenTab }: SoundTracksProps) {
  const pct = (s: number) => (duration > 0 ? Math.min(100, Math.max(0, (s / duration) * 100)) : 0);
  const seekAt = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (r.width > 0) onSeek(((e.clientX - r.left) / r.width) * duration);
  };
  // §23: the one hover card for the Effects block's cues.
  const { shown: shownCard, api: card } = useCueCard();
  const [focusCue, setFocusCue] = useState(0);

  return (
    <>
      {mix.rows.map((row) => {
        const name = NAME[row.lane];
        const count = takeCount(row.groups);
        const take = row.take;
        const result = row.clip ? mix.media[mediaKey(row.clip)] : undefined;
        const loaded = result !== undefined && result !== "error" ? result : null;
        // The take's own length, up to the cut's end; the whole cut until its file has loaded.
        const end = loaded ? Math.min(duration || loaded.duration, loaded.duration) : duration;
        const label = row.block === "take" ? take!.variant.name
          : row.block === "missing" ? "File not found"
          : row.block === "broken" ? "This file won't play in a browser"
          : row.block === "waiting" ? "Nothing chosen yet"
          : "Not started";
        const timed = row.lane === "sfx" && row.block === "take" ? cuesInTime(take!.variant.cues) : [];
        const ckeys = cueKeys(timed);
        const chip = count.fresh > 0 ? `${count.fresh} new` : String(count.all);
        return (
          <div key={row.lane} class={`trow strack${take ? "" : " idle"}`} role="group" aria-label={`${name} track`} data-sound={row.lane} style={{ "--c": COLOR[row.lane] }}>
            <div class="thead shead">
              <i class="sw" aria-hidden="true" />
              <span class="snm">{name}</span>
              {count.all > 0 && (
                <button
                  type="button"
                  class={`tcount mono${count.fresh > 0 ? " new" : ""}`}
                  aria-label={`${chip}: see every ${NOUN[row.lane]}`}
                  data-tip={`See every ${NOUN[row.lane]}`}
                  onClick={() => onOpenTab?.(TAB[row.lane])}
                >
                  {chip}
                </button>
              )}
              <span class="sp" />
              {take && (
                <>
                  <button type="button" class="ms" aria-pressed={mix.view[row.lane].muted} aria-label={`Mute ${name}`} data-tip={`Mute ${name}`} onClick={() => mix.toggle(row.lane, "muted")}>M</button>
                  <button type="button" class="ms" aria-pressed={mix.view[row.lane].solo} aria-label={`Solo ${name}`} data-tip={`Solo ${name}`} onClick={() => mix.toggle(row.lane, "solo")}>S</button>
                  <label class="slvl" data-tip={`Level for ${name}. Double-click to reset.`}>
                    <input
                      type="range"
                      min={LEVEL_MIN}
                      max={LEVEL_MAX}
                      step={LEVEL_STEP}
                      value={mix.levels[row.lane]}
                      aria-label={`${name} level`}
                      aria-valuetext={`${levelText(mix.levels[row.lane])} dB`}
                      onInput={(e) => mix.setLevel(row.lane, Number((e.target as HTMLInputElement).value))}
                      onDblClick={() => mix.setLevel(row.lane, 0)}
                      // So Space and the arrows go back to the player once the level is set.
                      onPointerUp={(e) => (e.currentTarget as HTMLElement).blur()}
                    />
                    <span class="db mono">{levelText(mix.levels[row.lane])} dB</span>
                  </label>
                </>
              )}
            </div>
            <div class="tlane" onClick={seekAt}>
              {row.block === "take" ? (
                <>
                  <div
                    class={`sblock${take!.stale ? " stale" : ""}`}
                    title={take!.stale ? `${take!.round} · ${take!.variant.name} · made for an older cut` : `${take!.round} · ${take!.variant.name}`}
                    style={{ left: "0%", width: `${pct(end)}%` }}
                  >
                    <span class="slbl">{label}</span>
                  </div>
                  <Wave segments={[{ offset: 0, duration: loaded?.duration ?? 0, peaks: loaded ? loaded.peaks : null }]} length={duration} color={COLOR[row.lane]} />
                </>
              ) : (
                <div class={`sblock empty${row.block === "missing" || row.block === "broken" ? " gone" : ""}`} style={{ left: "0%", width: "100%" }}>
                  <span class="slbl">{label}</span>
                </div>
              )}
              {timed.map((c, i) => {
                const cc = { key: `t:${ckeys[i]}`, name: cueName(c), t: c.t, n: i + 1, of: timed.length, file: c.file ?? null, color: COLOR.sfx };
                const shown = card.shown === cc.key;
                return (
                  <button
                    type="button"
                    class={`cue${shown ? " hot" : ""}`}
                    data-cue={c.id}
                    key={`c${ckeys[i]}:${c.t}:${c.name}`}
                    tabIndex={i === Math.min(focusCue, timed.length - 1) ? 0 : -1}
                    aria-label={cueLabel(c)}
                    aria-describedby={shown ? CUE_CARD_ID : undefined}
                    style={{ left: `${pct(c.t)}%`, color: COLOR.sfx }}
                    {...cardHover(card, cc)}
                    onFocus={(e) => {
                      setFocusCue(i);
                      card.show(e.currentTarget, cc);
                    }}
                    onBlur={() => card.hide()}
                    onKeyDown={(e) => rovingKeyDown(e, "button.cue", card)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSeek(c.t);
                    }}
                  >
                    <span>{cueName(c)}</span>
                  </button>
                );
              })}
              <span class="playhead" style={{ left: `${pct(t)}%` }} />
            </div>
          </div>
        );
      })}
      {mix.cutWave && (
        <div class="trow strack csound" role="group" aria-label="Cut sound track" style={{ "--c": "var(--pic)" }}>
          <div class="thead shead">
            <i class="sw" aria-hidden="true" />
            <span class="snm">Cut sound</span>
            <span class="sp" />
            <button type="button" class="ms" aria-pressed={mix.cutMuted} aria-label="Mute Cut sound" data-tip="Mute Cut sound" onClick={mix.toggleCut}>M</button>
          </div>
          <div class="tlane" onClick={seekAt}>
            <div class="sblock cut" style={{ left: "0%", width: "100%" }} />
            <PictureWave wave={mix.cutWave} length={duration} />
            <span class="playhead" style={{ left: `${pct(t)}%` }} />
          </div>
        </div>
      )}
      <CueCard shown={shownCard} onHide={card.hide} />
    </>
  );
}

/** §27, 5.5: the loudness of what you hear, in the transport while any take is in use. A timeout or an error asks again on a click. */
export function LoudnessReadout({ loudness }: { loudness: Mix["loudness"] }) {
  const retryable = loudness.state.kind === "timeout" || loudness.state.kind === "error";
  return (
    <div
      class={`tloud${retryable ? " retry" : ""}`}
      role="group"
      aria-label="Loudness"
      aria-busy={loudness.measuring}
      onClick={retryable ? loudness.retry : undefined}
    >
      {loudnessReadout(loudness.state).map((c) => (
        <span class="lcell" data-cell={c.id}>
          <b data-value data-tip={c.tip ?? undefined} aria-description={c.tip ?? undefined}>{c.value}</b>
          <span>{SHORT[c.id] ?? c.label}</span>
        </span>
      ))}
      {loudness.measuring && <span class="measuring" data-measuring data-tip="Measuring" aria-label="Measuring"><Icon name="gauge" /></span>}
      {retryable && !loudness.measuring && (
        // The keyboard's way to the same retry; a click on it bubbles to the readout's own handler.
        <button type="button" class="btn ghost ib sm" data-tip="Measure again" aria-label="Measure again"><Icon name="gauge" /></button>
      )}
    </div>
  );
}

/** The readout's labels, short enough for the transport. */
const SHORT: Record<string, string> = { integrated: "LUFS", truePeak: "dBTP", musicUnderVo: "under VO" };
