// Voiceover (§18; §27, 5.8): every read for this film, in rounds, as the tab's takes list shows them. A note is on a
// whole read or a point on it (no ranges), and a read in an older round is named by its round.
import { useState } from "preact/hooks";
import { takeGroups, type TakeRow } from "../desk.js";
import {
  agentPrompt, AUDIO_CHIPS, defaultVersion, filmLanes, filmNotes, filmPicks, otherLanes, type VariantRow, type VoiceNotes, voiceNoteRows, voiceOnLabel, voiceRounds, variantRows,
} from "../lib.js";
import type { Asset, State, Version, Video } from "../types.js";
import { AudioStage, filmsOf, type Preview, takeList } from "./AudioStage.js";
import { filmsControl } from "./FilmsMenu.js";
import { otherSounds } from "./desk/useMix.js";
import { BlindButton } from "./VariantTab.js";
import type { ReviewClock } from "./desk/frame.js";

const CHIPS: Record<"whole" | "point", string[]> = {
  whole: AUDIO_CHIPS.voice,
  point: ["Fix this", "Keep this"],
};

// Blind holds for the session, as on Music: its shuffle is fixed at page load, and the switch survives a trip to another tab.
const BLIND_SEED = Math.floor(Math.random() * 2 ** 31);
let blindSession = false;

export interface VoiceProps {
  state: State;
  assets: Asset[];
  /** The film whose cut the monitor shows. */
  video: Video | null;
  toast(message: string): void;
  onChanged(): void;
  /** A half-typed note is waiting: the caller refuses a film switch meanwhile. */
  onPendingChange?(pending: boolean): void;
  /** The film's one playhead across the Review tabs (final review I3). */
  clock?: ReviewClock;
  /** The cut chosen in the Cut menu, which the monitor shows (final review I5); the film's default cut without one. */
  version?: Version | null;
}

export function Voice({ state, assets, video, toast, onChanged, onPendingChange, clock, version }: VoiceProps) {
  const [blind, setBlindState] = useState(blindSession);
  const setBlind = (on: boolean) => {
    blindSession = on;
    setBlindState(on);
  };
  const filmCount = state.project.videos.length;
  const lanes = filmLanes(state.project.lanes, video?.id, filmCount);
  const filmState = filmPicks(state.picks, video?.id);
  const films = (r: { lane: string; variant: string; films: string[] }) => (filmCount > 1 ? filmsControl(r, state.project.videos, video, toast, onChanged) : undefined);
  const list = takeList({
    stage: "voice",
    groups: takeGroups(lanes, "voice", filmState.use?.voice, video ?? undefined),
    assets,
    blind: blind ? { seed: BLIND_SEED, word: "Read" } : null,
    films: (t: TakeRow) => films(filmsOf(t)),
  });
  const nameOf = (r: VariantRow) => list.nameOf(r.key) ?? r.name;
  const loose = video ? variantRows(otherLanes(state.project.lanes, video.id, filmCount), "voice") : [];

  // Notes resolve against the rounds (an older round's read is named by its round) and the script's takes (older notes).
  const model: VoiceNotes = { rounds: voiceRounds(lanes, filmState.lanes), sections: state.script.sections };
  // The monitor shows the cut chosen in the Cut menu, as the Timeline does; the take tags are still measured against the
  // film's current cut (takeGroups).
  const cut = version ?? defaultVersion(video ?? undefined);
  const preview: Preview | null = video && cut ? { video: video.id, version: cut, locked: video.lockedVersion === cut.id } : null;

  return (
    <AudioStage
      stage="voice"
      title="Voice"
      film={video?.id ?? null}
      readOnly={!!video?.shelved}
      list={list}
      others={otherSounds(state, assets, video ?? null, "voice")}
      loose={{
        items: loose.map((r) => ({ key: r.key, name: `${r.laneName} · ${r.name}`, meta: r.meta, films: films(r), none: r.films.length === 0 })),
        what: loose.length === 1 ? "read" : "reads",
      }}
      headerExtra={<BlindButton on={blind} onToggle={() => setBlind(!blind)} />}
      preview={preview}
      prompt={agentPrompt("picture", state.project.name, video?.name ?? null)}
      // Frames are counted at the cut's rate, as on the Timeline (m1).
      fps={cut?.fps ?? (state.project.fps || 30)}
      notes={filmNotes(state.notes.notes, "voice", video?.id)}
      noteRow={(n) => voiceNoteRows(model, n)}
      onLabel={(n) => voiceOnLabel(model, n.on, nameOf)}
      targetName={(it) => `${it.take.round} · ${it.name}`}
      hasRange={false}
      chipsFor={(scope) => CHIPS[scope === "point" ? "point" : "whole"]}
      wholeLabel="The whole read"
      none="No voice reads for this film yet."
      toast={toast}
      onChanged={onChanged}
      onPendingChange={onPendingChange}
      clock={clock}
    />
  );
}
