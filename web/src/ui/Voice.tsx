// Voiceover (§17.5): the assembled read on top, with section labels; the chosen section's takes as
// sub-lanes under it; any whole alternative reads (voice variants) as lanes of their own.
//
// What's heard is gains on one clock (voiceListening in lib.ts). Each section is an engine lane
// holding every take of it at the section's start, and its selection is the take heard; each voice
// lane holds its variants. The read or one variant sounds at a time, by lane gain. So auditioning a
// take, Use, and clicking back to the read are all 4 ms ramps: the playhead never moves and nothing
// restarts. Picks don't change the clips at all, only which one each lane selects.
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import { assembleRead, assetRev, type Clip } from "../audio/timeline.js";
import {
  defaultVersion, isTakeStale, pickedVoiceRow, READ_ROW, readTake, sectionAt, sectionLabel, sectionLane, STAGE_NAMES, takeClipId, takeLabel,
  takeRowKey, variantRows, type VoiceModel, voiceLane, voiceListening, voiceNoteRows, voiceOnLabel, voiceOnOptions,
} from "../lib.js";
import type { Asset, State, Video } from "../types.js";
import { AudioStage, type Preview, type StageHandle } from "./AudioStage.js";
import type { StageRow } from "./Lanes.js";

const VO_COLOR = "#4FD1C5";

export interface VoiceProps {
  state: State;
  assets: Asset[];
  /** The film whose cut the preview plays. */
  video: Video | null;
  toast(message: string): void;
  onChanged(): void;
  /** A half-typed note or a range is waiting: the caller refuses a film switch meanwhile. */
  onPendingChange?(pending: boolean): void;
}

export function Voice({ state, assets, video, toast, onChanged, onPendingChange }: VoiceProps) {
  const sections = state.script.sections;
  const variants = variantRows(state.project.lanes, "voice");
  const model: VoiceModel = { sections, picks: state.picks.sections, variants, lanePicks: state.picks.lanes };
  const asset = (path: string) => assets.find((a) => a.path === path);
  const rev = (path: string) => {
    const a = asset(path);
    return a ? assetRev(a) : undefined;
  };
  // A file that isn't on disk is never loaded: its take shows the missing mark and leaves a gap.
  const missing = (path: string) => asset(path)?.missing === true;

  // ---- the section switch: the one you chose, else the one under the playhead, else the first ----
  const handle = useRef<StageHandle | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [atHead, setAtHead] = useState<string | null>(null);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  useEffect(() => {
    // Renders only when the playhead crosses into another section, never per frame.
    return handle.current?.engine.subscribe((t) => {
      const id = sectionAt(sectionsRef.current, t);
      if (id !== null) setAtHead(id);
    });
  }, []);
  const has = (id: string | null) => id !== null && sections.some((s) => s.id === id);
  const shown = has(chosen) ? chosen : has(atHead) ? atHead : (sections[0]?.id ?? null);
  const section = sections.find((s) => s.id === shown) ?? null;

  const choose = (id: string) => {
    setChosen(id);
    handle.current?.setOn(`s:${id}`);
  };
  const newTake = () => {
    if (!section) return;
    setChosen(section.id);
    handle.current?.startNote(`Another take of ${sectionLabel(section.id)}: `, { on: `s:${section.id}`, scope: "whole" });
  };

  // A take or variant id sets the pick; null clears it (Unpick).
  const setPick = async (body: { sections?: Record<string, string | null>; lanes?: Record<string, string | null> }, clearing: boolean) => {
    try {
      await api.put("/api/picks", body);
    } catch (e) {
      toast(`Couldn't ${clearing ? "clear" : "set"} the pick: ${(e as Error).message}`);
    }
    onChanged();
  };
  const useTake = (sectionId: string, takeId: string | null) => setPick({ sections: { [sectionId]: takeId } }, takeId === null);
  const useVariant = (lane: string, variant: string | null) => setPick({ lanes: { [lane]: variant } }, variant === null);

  // ---- what the engine plays: every take of every section, and every voice variant ----
  // Every clip plays its whole file (`duration: 0`), as the server's mix does: a take re-rendered
  // in place can change length without the script's recorded duration knowing.
  const clips: Clip[] = [];
  for (const s of sections) {
    for (const t of s.takes) {
      if (missing(t.file)) continue;
      clips.push({
        id: takeClipId(s.id, t.id), lane: sectionLane(s.id), path: t.file, offset: s.start, duration: 0,
        section: s.id, take: t.id, rev: rev(t.file),
      });
    }
  }
  for (const r of variants) {
    if (!missing(r.file)) clips.push({ id: r.key, lane: voiceLane(r.lane), path: r.file, offset: 0, duration: 0, rev: rev(r.file) });
  }

  // ---- the lanes ----
  const read: StageRow = {
    key: READ_ROW,
    name: "Assembled read",
    meta: sections.some((s) => s.takes.length > 0) ? "Picked take per section" : "No takes yet",
    color: VO_COLOR,
    // Drawn only: a section with no take, or a missing one, is a gap.
    clips: assembleRead(sections, state.picks.sections).filter((c) => !missing(c.path)).map((c) => ({ ...c, rev: rev(c.path) })),
    labels: sections.map((s) => ({ t: s.start, text: sectionLabel(s.id) })),
    on: "r",
  };
  const inRead = section ? readTake(section, state.picks.sections) : null;
  const takes: StageRow[] = (section?.takes ?? []).map((t) => {
    const gone = missing(t.file);
    return {
      key: takeRowKey(section!.id, t.id),
      name: takeLabel(section!, t.id),
      meta: t.duration !== null ? `${t.duration.toFixed(1)} s` : null,
      color: VO_COLOR,
      sub: true,
      clips: gone ? [] : [{ id: takeClipId(section!.id, t.id), lane: sectionLane(section!.id), path: t.file, offset: section!.start, duration: 0, rev: rev(t.file) }],
      // In use is the take the read uses (its pick, else the newest); only an explicit pick can be unpicked.
      use: {
        inUse: inRead?.id === t.id,
        onUse: () => void useTake(section!.id, t.id),
        onUnpick: state.picks.sections[section!.id] === t.id ? () => void useTake(section!.id, null) : undefined,
      },
      on: `t:${takeClipId(section!.id, t.id)}`,
      stale: isTakeStale(t, section!),
      missing: gone,
    };
  });
  const alternates: StageRow[] = variants.map((r, i) => ({
    key: r.key,
    name: r.name,
    meta: r.meta,
    color: VO_COLOR,
    clips: missing(r.file) ? [] : [{ id: r.key, lane: voiceLane(r.lane), path: r.file, offset: 0, duration: 0, rev: rev(r.file) }],
    order: i,
    use: { inUse: state.picks.lanes[r.lane] === r.variant, onUse: () => void useVariant(r.lane, r.variant), onUnpick: () => void useVariant(r.lane, null) },
    on: `v:${r.key}`,
    missing: missing(r.file),
  }));
  const notes = state.notes.notes.filter((n) => n.stage === "voice");
  // The read exists once there's a script to assemble (or a note already sits on it). With whole
  // reads only, the tab is just those reads, and the picked one (else the first) is what plays.
  const hasRead = sections.length > 0 || notes.some((n) => voiceNoteRows(model, n, shown).includes(READ_ROW));
  const rows = hasRead ? [read, ...takes, ...alternates] : alternates;
  const firstRead = hasRead ? null : (pickedVoiceRow(variants, state.picks.lanes) ?? variants[0] ?? null);
  const onOptions = voiceOnOptions(model, shown).filter((o) => hasRead || o.row !== READ_ROW);
  const cut = defaultVersion(video ?? undefined);
  const preview: Preview | null = video && cut ? { video: video.id, version: cut.id, file: cut.file, duration: cut.duration } : null;
  const fps = state.project.fps || 30;

  return (
    <AudioStage
      stage="voice"
      title={STAGE_NAMES.voice}
      belowLanes={section && (
        <div class="bar vobar">
          <div class="seg" role="group" aria-label="Section">
            {sections.map((s) => (
              <button type="button" aria-pressed={s.id === shown} onClick={() => choose(s.id)}>{sectionLabel(s.id)}</button>
            ))}
          </div>
          <button type="button" class="btn" data-tip={`Ask the agent for another take of ${sectionLabel(section.id)}`} onClick={newTake}>New take</button>
        </div>
      )}
      rows={rows}
      clips={clips}
      preview={preview}
      fps={fps}
      notes={notes}
      onOptions={onOptions}
      defaultOn={hasRead ? "r" : firstRead ? `v:${firstRead.key}` : undefined}
      listen={(selected) => voiceListening(model, selected ?? firstRead?.key ?? null)}
      noteRow={(n) => voiceNoteRows(model, n, shown)}
      onLabel={(n) => voiceOnLabel(model, n.on)}
      handle={handle}
      onSelect={(row) => {
        // Auditioning a take holds its section, so the playhead crossing into the next can't hide it.
        if (row.sub && shown) setChosen(shown);
      }}
      toast={toast}
      onChanged={onChanged}
      onPendingChange={onPendingChange}
    />
  );
}
