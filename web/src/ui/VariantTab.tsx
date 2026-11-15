// Music (§17.3) and Effects (§17.4; §27, 5.8): every bed or pass for this film, as the tab's takes list shows them. A
// note is on a whole bed or pass, a point, a range with its marks, or (Effects) one of a pass's cues at its time. Music
// has Blind; an effects pass labels its cues on its block and opens its layers by sound (§23).
import { useState } from "preact/hooks";
import { takeGroups, type TakeRow } from "../desk.js";
import { agentPrompt, AUDIO_CHIPS, defaultVersion, filmLanes, filmNotes, filmPicks, otherLanes, variantNoteRow, variantOnLabel, variantOnOptions, variantRows } from "../lib.js";
import type { Asset, State, Version, Video } from "../types.js";
import { AudioStage, filmsOf, type Preview, takeList } from "./AudioStage.js";
import { filmsControl } from "./FilmsMenu.js";
import type { ReviewClock } from "./desk/frame.js";
import { Icon } from "./Icon.js";

// Blind holds for the session: its shuffle is fixed at page load, and the switch survives a trip to another tab.
const BLIND_SEED = Math.floor(Math.random() * 2 ** 31);
let blindSession = false;

// §23: which passes have their layers open, by take key, for the session.
const openLayers = new Set<string>();

const NAMES = { music: { title: "Music", one: "bed", many: "beds", none: "No music beds for this film yet." }, sfx: { title: "Effects", one: "pass", many: "passes", none: "No sound effects passes for this film yet." } } as const;

/** Blind listening: the names (and descriptions) are hidden while it is on. */
export function BlindButton({ on, onToggle }: { on: boolean; onToggle(): void }) {
  return (
    <button type="button" class="btn ghost sm kblind" aria-label="Blind" aria-pressed={on} data-tip={on ? "Show the names" : "Hide the names while you listen"} onClick={onToggle}>
      <Icon name="eyeoff" />
      Blind
    </button>
  );
}

export interface VariantTabProps {
  stage: "music" | "sfx";
  state: State;
  assets: Asset[];
  /** The film whose cut the monitor shows. */
  video: Video | null;
  toast(message: string): void;
  onChanged(): void;
  /** A half-typed note or a range is waiting: the caller refuses a film switch meanwhile. */
  onPendingChange?(pending: boolean): void;
  /** The film's one playhead across the Review tabs (final review I3). */
  clock?: ReviewClock;
  /** The cut chosen in the Cut menu, which the monitor shows (final review I5); the film's default cut without one. */
  version?: Version | null;
}

export function VariantTab({ stage, state, assets, video, toast, onChanged, onPendingChange, clock, version }: VariantTabProps) {
  const [blind, setBlindState] = useState(stage === "music" && blindSession);
  const setBlind = (on: boolean) => {
    blindSession = on;
    setBlindState(on);
  };
  const [, rerender] = useState(0);
  const words = NAMES[stage];

  const filmCount = state.project.videos.length;
  const lanes = filmLanes(state.project.lanes, video?.id, filmCount);
  const filmState = filmPicks(state.picks, video?.id);
  const films = (r: { lane: string; variant: string; films: string[] }) => (filmCount > 1 ? filmsControl(r, state.project.videos, video, toast, onChanged) : undefined);
  const list = takeList({
    stage,
    groups: takeGroups(lanes, stage, filmState.use?.[stage], video ?? undefined),
    assets,
    blind: blind ? { seed: BLIND_SEED, word: "Bed" } : null,
    films: (t: TakeRow) => films(filmsOf(t)),
  });
  const loose = video ? variantRows(otherLanes(state.project.lanes, video.id, filmCount), stage) : [];

  // What a note is on, and its words: a bed or pass, or a pass's cue ("Cue · Swipe", with the pass's name when two share it).
  const rows = variantRows(lanes, stage);
  const options = variantOnOptions(rows, (r) => list.nameOf(r.key) ?? r.name, stage === "sfx");
  // The monitor shows the cut chosen in the Cut menu, as the Timeline does; the take tags are still measured against the
  // film's current cut (takeGroups).
  const cut = version ?? defaultVersion(video ?? undefined);
  const preview: Preview | null = video && cut ? { video: video.id, version: cut, locked: video.lockedVersion === cut.id } : null;

  return (
    <AudioStage
      stage={stage}
      title={words.title}
      film={video?.id ?? null}
      readOnly={!!video?.shelved}
      list={list}
      loose={{ items: loose.map((r) => ({ key: r.key, name: r.name, meta: r.meta, films: films(r), none: r.films.length === 0 })), what: loose.length === 1 ? words.one : words.many }}
      headerExtra={stage === "music" ? <BlindButton on={blind} onToggle={() => setBlind(!blind)} /> : undefined}
      preview={preview}
      prompt={agentPrompt("picture", state.project.name, video?.name ?? null)}
      // Frames are counted at the cut's rate, as on the Timeline (m1).
      fps={cut?.fps ?? (state.project.fps || 30)}
      notes={filmNotes(state.notes.notes, stage, video?.id)}
      noteRow={(n) => variantNoteRow(rows, n.on)}
      onLabel={(n) => variantOnLabel(rows, options, n.on)}
      targetName={(it, cue) => (cue === null ? it.name : options.find((o) => o.value === `c:${it.key}:${cue}`)?.label ?? it.name)}
      rangeMarks
      chipsFor={() => AUDIO_CHIPS[stage]}
      wholeLabel={`The whole ${words.one}`}
      none={words.none}
      layers={stage === "sfx" ? {
        open: (key) => openLayers.has(key),
        toggle: (key) => {
          if (openLayers.has(key)) openLayers.delete(key);
          else openLayers.add(key);
          rerender((n) => n + 1);
        },
      } : undefined}
      toast={toast}
      onChanged={onChanged}
      onPendingChange={onPendingChange}
      clock={clock}
    />
  );
}
