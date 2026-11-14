// §27, 5.6: what the Timeline tab's sound is (moved out of SoundTracks.tsx, unchanged): what each sound plays (the take in
// use), mute and solo as view state (never saved; kept by the desk across the Review tabs, reset by a film switch), levels
// saved with the picks (debounced), the cut's own sound, and the loudness of what you hear, measured (debounced) for the
// transport.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError } from "../../api.js";
import type { AudioEngine, LoadResult } from "../../audio/engine.js";
import { assetRev, type Clip, laneGains, mediaKey } from "../../audio/timeline.js";
import { useFollower } from "../../audio/useFollower.js";
import { takeCount, takeGroups, type TakeGroups, type TakeRow } from "../../desk.js";
import {
  clampLevel, filmLanes, filmPicks, loudnessLanes, type LoudnessState, MIX_LANES, type MixLane, type MixModel, mixNoteTarget, mixOnLabel, MIX_STAGE,
  takeInUse, variantRows, type VariantRow, WHOLE_MIX,
} from "../../lib.js";
import type { Asset, LoudnessResult, Note, State, Version, Video } from "../../types.js";
import { audioTestHook } from "../AudioStage.js";
import { usePictureWave } from "../PictureWave.js";
import type { Wave as Peaks } from "../../peaks.js";

/** The readout waits this long after the last change before measuring (§17.6). */
export const LOUDNESS_DEBOUNCE_MS = 500;
/** A level is saved this long after the last drag (§19.6): the slider itself stays live the whole time. */
export const LEVEL_SAVE_DEBOUNCE_MS = 300;

/** Each sound's name on its row and in a note's label. */
export const NAME: Record<MixLane, string> = { vo: "Voice", music: "Music", sfx: "Effects" };

type LaneView = { muted: boolean; solo: boolean };
/** Each sound's mute and solo on the Timeline tab. */
export type MixView = Record<MixLane, LaneView>;
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
  /** The film, or null in a project with takes and no film yet. */
  video: Video | null;
  /** The cut on screen: its own sound is the Cut sound row. Null with no cut: the engine is then its own clock. */
  version: Version | null;
  /** The <video> on the monitor: the clock the takes follow. */
  player: { current: HTMLVideoElement | null };
  /** The cut's length as the player knows it, for a waveform the browser has to make itself. */
  duration: number;
  /** The transport's volume and mute: what you hear of the takes, as of the picture. */
  monitor: { level: number; muted: boolean };
  toast(message: string): void;
  onChanged(): void;
  /** Final review I3: where the desk keeps the mute and solo for the film, so they outlast a trip to another tab. */
  keep?: { current: MixView | null };
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
  /** The cut's own sound: its row shows unless the cut is known to have none; its waveform once it has one. */
  cut: { shown: boolean; wave: Peaks | null; known: boolean };
  /** The Cut sound row's M: muted while any take is in use, until pressed. */
  cutMuted: boolean;
  toggleCut(): void;
  /** Whether the <video> plays its own sound muted. */
  videoMuted: boolean;
  loudness: { state: LoudnessState; measuring: boolean; retry(): void };
  /** The engine and its length: the clock itself when there is no cut to follow. */
  engine: AudioEngine;
  length: number;
  /** What a note on the mix or on a take in use is on, for the notes list ("Whole mix", "Music · Warm keys"); null for any other note. */
  noteLabel(n: Note): string | null;
  /** §27, 5.7: the row a note is marked on: a take in use's (by its stage and `on`), or an older Mix note's lane. */
  noteRow(n: Note): MixLane | null;
}

/** The `on` a note on a take carries: "<lane>/<variant>", with ":<cue>" for one of a pass's cues. */
export const takeOn = (take: TakeRow) => `${take.lane}/${take.variant.id}`;

/**
 * What each sound plays on a film: one take, the one in use, as the server worked it out (§27.6), on the engine lane named
 * for the sound ("vo", "music", "sfx"). The Timeline tab plays all three; a sound's tab plays the other two under its own.
 */
export function planSounds(state: State, assets: Asset[], video: Video | null): SoundRow[] {
  const asset = (path: string) => assets.find((a) => a.path === path);
  const use = filmPicks(state.picks, video?.id).use;
  const lanes = filmLanes(state.project.lanes, video?.id, state.project.videos.length);
  return MIX_LANES.map((lane) => {
    const groups = takeGroups(lanes, MIX_STAGE[lane], use?.[MIX_STAGE[lane]], video ?? undefined);
    const take = groups.inUse;
    if (!take) return { lane, groups, take, clip: null, block: takeCount(groups).all > 0 ? "waiting" : "none" };
    const file = take.variant.file;
    const a = asset(file);
    if (a?.missing) return { lane, groups, take, clip: null, block: "missing" };
    const clip: Clip = { id: `${take.lane}/${take.variant.id}`, lane, path: file, offset: 0, duration: 0, rev: a ? assetRev(a) : undefined };
    return { lane, groups, take, clip, block: "take" };
  });
}

/** Each sound's saved level (§19.6) as a gain, as the Timeline tab plays it with nothing muted or soloed. */
export function savedGains(state: State, video: Video | null): Record<MixLane, number> {
  const levels = filmPicks(state.picks, video?.id).levels;
  return laneGains(MIX_LANES.map((id) => ({ id, level: levels[MIX_STAGE[id]] ?? 0 }))) as Record<MixLane, number>;
}

/** What a sound's tab plays under its own takes: the other sounds' takes in use and every sound's saved level, as a gain. */
export interface OtherSounds {
  clips: Clip[];
  /** By engine lane: "vo", "music", "sfx". */
  gains: Record<MixLane, number>;
}

/** The other two sounds' takes in use on this film, for `stage`'s tab (§27, 5.8: a take is auditioned against the mix). */
export function otherSounds(state: State, assets: Asset[], video: Video | null, stage: "voice" | "music" | "sfx"): OtherSounds {
  return {
    clips: planSounds(state, assets, video).flatMap((r) => (MIX_STAGE[r.lane] !== stage && r.clip ? [r.clip] : [])),
    gains: savedGains(state, video),
  };
}

/** Everything the Timeline tab's sound needs: what plays, how loud, what is heard and what it measures. */
export function useMix({ state, assets, video, version, player, duration, monitor, toast, onChanged, keep }: MixInput): Mix {
  const asset = (path: string) => assets.find((a) => a.path === path);
  const filmId = video?.id;
  // Worked out again only when what they come from changes: the Timeline re-renders every frame while it plays.
  const filmState = useMemo(() => filmPicks(state.picks, filmId), [state.picks, filmId]);
  const use = filmState.use;
  // Only this film's reads, beds and passes (and any made for every film), as the server measures them.
  const lanes = useMemo(() => filmLanes(state.project.lanes, filmId, state.project.videos.length), [state.project.lanes, filmId, state.project.videos.length]);

  // ---- what each sound plays: one take, the one in use, as the server worked it out (§27.6) ----
  const planned = useMemo(() => planSounds(state, assets, video), [state.picks, state.project, assets, video]);
  const clips = useMemo(() => planned.flatMap((r) => (r.clip ? [r.clip] : [])), [planned]);
  const inUse = planned.some((r) => r.take !== null);

  // ---- mute and solo: view state only ----
  const [view, setView] = useState<MixView>(() => keep?.current ?? UNTOUCHED);
  // A layout effect: a tab switch straight after a click must not unmount this before a passive effect would have run.
  useLayoutEffect(() => {
    if (keep) keep.current = view;
  }, [view]);
  const toggle = (lane: MixLane, key: keyof LaneView) => setView((v) => ({ ...v, [lane]: { ...v[lane], [key]: !v[lane][key] } }));
  // A sound whose take goes (unpicked here, by the agent or in another tab) lets go of its mute and solo: there is no M
  // or S left to undo them, and a take picked later starts as any take does.
  const live: Record<MixLane, boolean> = { vo: false, music: false, sfx: false };
  for (const r of planned) live[r.lane] = r.take !== null;
  const liveKey = MIX_LANES.map((l) => (live[l] ? "1" : "0")).join("");
  useLayoutEffect(() => {
    setView((v) => {
      const gone = MIX_LANES.filter((l) => !live[l] && (v[l].muted || v[l].solo));
      return gone.length === 0 ? v : { ...v, ...Object.fromEntries(gone.map((l) => [l, { muted: false, solo: false }])) };
    });
  }, [liveKey]);
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
  const savedKey = useMemo(() => `${filmId}:${JSON.stringify(pickLevels)}`, [filmId, pickLevels]);
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
  // Only a sound with a take in use can mute or solo anything, even before the view state above has let go.
  const gains = laneGains(MIX_LANES.map((id) => (live[id] ? { id, ...view[id], level: levels[id] } : { id, level: levels[id] })));
  const master = monitor.muted ? 0 : monitor.level;
  const heardGains = Object.fromEntries(Object.entries(gains).map(([lane, g]) => [lane, g * master]));
  const { media, engine, length } = useFollower(player, clips, heardGains);
  // A file that won't play at all says so on its block; the others play on.
  const rows = planned.map((r): SoundRow => (r.clip && media[mediaKey(r.clip)] === "error" ? { ...r, block: "broken" } : r));
  const anySolo = MIX_LANES.some((l) => live[l] && view[l].solo);

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
  // Only the server's "no audio" counts as silent: a waveform that couldn't be had (a failed request, no ffmpeg and too
  // big to decode here) still leaves the row and its M, so the sound can always be heard. While the answer is still on
  // its way and nothing is in use, the cut plays its own sound anyway, so the row waits for it rather than come and go.
  const cutAsset = version ? asset(version.file) : undefined;
  const cutWave = usePictureWave(video?.id ?? null, version, cutAsset?.size ?? null, cutAsset ? assetRev(cutAsset) : undefined, version?.duration ?? duration);
  const cutShown = version !== null && !cutWave.silent && (cutWave.known || inUse);
  // An M pressed on the row lasts only while the row is there, on its cut: with no M left to undo it, the video never
  // stays muted (or unmuted) by a choice made on a row that has gone.
  useLayoutEffect(() => {
    if (!cutShown) setCutChoice(null);
  }, [cutShown]);
  useLayoutEffect(() => setCutChoice(null), [version?.id]);

  // ---- loudness (§17.6): the sounds you hear, debounced, never blocking ----
  const heard: Record<MixLane, boolean> = { vo: false, music: false, sfx: false };
  for (const r of planned) heard[r.lane] = r.clip !== null;
  const want = inUse ? loudnessLanes(heard, gains) : [];
  // Anything that changes the mix re-measures: the sounds, what each plays (picks, re-renders) and the saved levels
  // (the server applies them before measuring, so this follows the saved value, not the slider mid-drag).
  const wantKey = want.join("\n");
  const signature = useMemo(() => JSON.stringify({ want, film: filmId, levels: pickLevels, clips: clips.map((c) => [c.path, c.rev ?? ""]) }), [wantKey, filmId, pickLevels, clips]);
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
  const variants = useMemo(() => ({ music: variantRows(lanes, "music"), sfx: variantRows(lanes, "sfx") }), [lanes]);
  const heardRows = (stage: "music" | "sfx"): VariantRow[] => variants[stage].filter((r) => takeInUse(use, stage, r) && !asset(r.file)?.missing);
  const model: MixModel = { variants, heard: { vo: heard.vo, music: heardRows("music"), sfx: heardRows("sfx") } };

  const rowOfTake = (n: Note): SoundRow | null => {
    if (n.on === null || (n.stage !== "voice" && n.stage !== "music" && n.stage !== "sfx")) return null;
    const on = n.on;
    return rows.find((r) => r.take && MIX_STAGE[r.lane] === n.stage && (on === takeOn(r.take) || on.startsWith(`${takeOn(r.take)}:`))) ?? null;
  };
  const noteRow = (n: Note): MixLane | null => {
    if (n.stage === "mix") {
      const target = mixNoteTarget(model, n.on);
      return target === null || target === WHOLE_MIX ? null : target;
    }
    return rowOfTake(n)?.lane ?? null;
  };

  return {
    rows,
    media,
    view,
    toggle,
    levels,
    setLevel,
    inUse,
    cut: { shown: cutShown, wave: cutWave.wave, known: cutWave.known },
    cutMuted,
    toggleCut: () => setCutChoice(!cutMuted),
    videoMuted: cutMuted || anySolo,
    loudness: { state: loudness, measuring, retry: () => setRetries((n) => n + 1) },
    noteLabel: (n) => {
      if (n.stage === "mix") return mixOnLabel(model, n.on);
      const r = rowOfTake(n);
      return r ? `${NAME[r.lane]} · ${r.take!.variant.name}` : null;
    },
    noteRow,
    engine,
    length,
  };
}
