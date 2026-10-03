// Voiceover (§18): rounds of whole reads. The current (newest) round is open under its name, one
// lane per read; each older round is folded into one row that opens its lanes beneath it.
//
// Every read is an engine lane of its own, holding just that read. One read sounds at a time, by lane
// gain (voiceListening in lib.ts): the clicked one, else the current round's pick, else its first
// read. So clicking a read, Use and Unpick are 4 ms ramps on one clock: the playhead never moves.
import { useState } from "preact/hooks";
import { api } from "../api.js";
import { assetRev, type Clip } from "../audio/timeline.js";
import {
  blindOrder, defaultVersion, readLane, type Scope, STAGE_NAMES, type VariantRow, voiceDefaultRead, voiceListening, type VoiceNotes, voiceNoteRows,
  voiceOnLabel, voiceOnOptions, type VoiceRound, voiceRounds,
} from "../lib.js";
import type { Asset, State, Video } from "../types.js";
import { AudioStage, type Preview } from "./AudioStage.js";
import { Icon } from "./Icon.js";
import type { StageRow } from "./Lanes.js";

const VO_COLOR = "#4FD1C5";
const SCOPES: Scope[] = ["whole", "point"];
const CHIPS: Record<"whole" | "point", string[]> = {
  whole: ["Speaker", "Pacing", "Tone", "Overall"],
  point: ["Fix this", "Keep this"],
};

// Blind holds for the session, as on Music: its shuffle is fixed at page load, and the switch
// survives a trip to another tab.
const BLIND_SEED = Math.floor(Math.random() * 2 ** 31);
let blindSession = false;
// Which older rounds are open, per film, for the session.
const openRounds = new Map<string, Set<string>>();
const NONE_OPEN: ReadonlySet<string> = new Set();

export interface VoiceProps {
  state: State;
  assets: Asset[];
  /** The film whose cut the preview plays. */
  video: Video | null;
  toast(message: string): void;
  onChanged(): void;
  /** A half-typed note is waiting: the caller refuses a film switch meanwhile. */
  onPendingChange?(pending: boolean): void;
}

export function Voice({ state, assets, video, toast, onChanged, onPendingChange }: VoiceProps) {
  const [blind, setBlindState] = useState(blindSession);
  const setBlind = (on: boolean) => {
    blindSession = on;
    setBlindState(on);
  };
  const film = video?.id ?? "";
  // The open rounds live in openRounds, per film; this state only re-renders after a toggle.
  const [, rerender] = useState(0);
  const opened = openRounds.get(film) ?? NONE_OPEN;
  const toggle = (round: string) => {
    const next = new Set(opened);
    if (next.has(round)) next.delete(round);
    else next.add(round);
    openRounds.set(film, next);
    rerender((n) => n + 1);
  };

  const asset = (path: string) => assets.find((a) => a.path === path);
  const rev = (path: string) => {
    const a = asset(path);
    return a ? assetRev(a) : undefined;
  };
  // A file that isn't on disk is never loaded: its read shows the missing mark and plays silence.
  const missing = (path: string) => asset(path)?.missing === true;

  // Rounds in creation order; with Blind, each round's reads shuffled and named Read 1…n.
  const rounds = voiceRounds(state.project.lanes, state.picks.lanes);
  const shown: VoiceRound[] = rounds.map((round) => {
    if (!blind) return round;
    const order = blindOrder(round.reads.map((r) => r.key), BLIND_SEED);
    return { ...round, reads: order.map((k) => round.reads.find((r) => r.key === k)!) };
  });
  const position = new Map<string, number>();
  for (const round of shown) round.reads.forEach((r, i) => position.set(r.key, i + 1));
  const nameOf = (r: VariantRow) => (blind ? `Read ${position.get(r.key)}` : r.name);

  // null clears the round's pick (Unpick).
  const use = async (round: VoiceRound, variant: string | null) => {
    try {
      await api.put("/api/picks", { lanes: { [round.id]: variant } });
    } catch (e) {
      toast(`Couldn't ${variant === null ? "clear" : "set"} the pick: ${(e as Error).message}`);
    }
    onChanged();
  };

  // ---- what the engine plays: every read of every round, each in a lane of its own ----
  const clipOf = (r: VariantRow): Clip => ({ id: r.key, lane: readLane(r), path: r.file, offset: 0, duration: 0, rev: rev(r.file) });
  const clips: Clip[] = rounds.flatMap((round) => round.reads.filter((r) => !missing(r.file)).map(clipOf));

  // ---- the lanes: the current round open, then older rounds newest first, each folded ----
  const notes = state.notes.notes.filter((n) => n.stage === "voice");
  const model: VoiceNotes = { rounds, sections: state.script.sections.map((s) => s.id) };
  const lane = (round: VoiceRound, r: VariantRow): StageRow => ({
    key: r.key,
    name: nameOf(r),
    meta: blind ? "·····" : r.meta,
    color: VO_COLOR,
    clips: missing(r.file) ? [] : [clipOf(r)],
    use: { inUse: round.pick === r.variant, onUse: () => void use(round, r.variant), onUnpick: () => void use(round, null) },
    on: `v:${r.key}`,
    missing: missing(r.file),
  });
  const rows: StageRow[] = [];
  for (const round of [...shown].reverse()) {
    if (round.current) {
      round.reads.forEach((r, i) => rows.push(i === 0 ? { ...lane(round, r), heading: round.name, tag: "current" } : lane(round, r)));
      continue;
    }
    const isOpen = opened.has(round.id);
    const picked = round.reads.find((r) => r.variant === round.pick);
    const keys = new Set(round.reads.map((r) => r.key));
    const n = round.reads.length;
    rows.push({
      key: `round:${round.id}`,
      name: round.name,
      color: VO_COLOR,
      clips: [],
      fold: {
        label: (
          <>
            <b>{round.name}</b> · {n} {n === 1 ? "read" : "reads"} ·{" "}
            {picked ? <span class="fpk">picked {blind ? "a read" : picked.name}</span> : "nothing picked"}
          </>
        ),
        open: isOpen,
        dot: notes.some((note) => note.status === "todo" && keys.has(voiceNoteRows(model, note) ?? "")),
        onToggle: () => toggle(round.id),
      },
    });
    if (isOpen) for (const r of round.reads) rows.push(lane(round, r));
  }

  const onOptions = voiceOnOptions(shown, nameOf);
  const firstRead = voiceDefaultRead(rounds);
  const cut = defaultVersion(video ?? undefined);
  const preview: Preview | null = video && cut ? { video: video.id, version: cut.id, file: cut.file, duration: cut.duration } : null;
  const fps = state.project.fps || 30;

  return (
    <AudioStage
      stage="voice"
      film={video?.id ?? null}
      title={STAGE_NAMES.voice}
      headerExtra={
        <button
          class="btn ghost ib"
          aria-label="Blind"
          aria-pressed={blind}
          data-tip={blind ? "Show names" : "Blind: hide names"}
          onClick={() => setBlind(!blind)}
        >
          <Icon name="eyeoff" />
        </button>
      }
      rows={rows}
      clips={clips}
      preview={preview}
      fps={fps}
      notes={notes}
      onOptions={onOptions}
      defaultOn={firstRead ? `v:${firstRead.key}` : undefined}
      listen={(selected) => voiceListening(rounds, selected)}
      noteRow={(n) => voiceNoteRows(model, n)}
      onLabel={(n) => voiceOnLabel(model, n.on, nameOf)}
      scopes={SCOPES}
      defaultScope="whole"
      chipsFor={(scope) => CHIPS[scope === "point" ? "point" : "whole"]}
      marks={false}
      toast={toast}
      onChanged={onChanged}
      onPendingChange={onPendingChange}
    />
  );
}
