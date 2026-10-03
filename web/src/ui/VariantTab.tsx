// Music (§17.3) and Sound effects (§17.4): one lane per variant of the stage's lanes. Clicking a
// lane auditions it at the playhead; Use sets the pick. Music adds Blind; Sound effects labels
// each pass's cues and lists them in the On menu.
import { useState } from "preact/hooks";
import { api } from "../api.js";
import { assetRev, type Clip } from "../audio/timeline.js";
import { blindOrder, defaultVersion, STAGE_NAMES, type VariantRow, variantNoteRow, variantOnLabel, variantOnOptions, variantRows } from "../lib.js";
import type { Asset, State, Video } from "../types.js";
import { AudioStage, type Preview } from "./AudioStage.js";
import { Icon } from "./Icon.js";
import type { StageRow } from "./Lanes.js";

const COLOR = { music: "#A78BFA", sfx: "#FB923C" } as const;

// Blind holds for the session: its shuffle is fixed at page load, and the switch survives a trip
// to another tab.
const BLIND_SEED = Math.floor(Math.random() * 2 ** 31);
let blindSession = false;

export interface VariantTabProps {
  stage: "music" | "sfx";
  state: State;
  assets: Asset[];
  /** The film whose cut the preview plays. */
  video: Video | null;
  toast(message: string): void;
  onChanged(): void;
  /** A half-typed note or a range is waiting: the caller refuses a film switch meanwhile. */
  onPendingChange?(pending: boolean): void;
}

export function VariantTab({ stage, state, assets, video, toast, onChanged, onPendingChange }: VariantTabProps) {
  const [blind, setBlindState] = useState(stage === "music" && blindSession);
  const setBlind = (on: boolean) => {
    blindSession = on;
    setBlindState(on);
  };

  const all = variantRows(state.project.lanes, stage);
  const order = blind ? blindOrder(all.map((r) => r.key), BLIND_SEED) : all.map((r) => r.key);
  const rows = order.map((k) => all.find((r) => r.key === k)!);
  const nameOf = (r: VariantRow) => (blind ? `Bed ${order.indexOf(r.key) + 1}` : r.name);
  const picks = state.picks.lanes;

  // null clears the lane's pick (Unpick).
  const use = async (r: VariantRow, variant: string | null) => {
    try {
      await api.put("/api/picks", { lanes: { [r.lane]: variant } });
    } catch (e) {
      toast(`Couldn't ${variant === null ? "clear" : "set"} the pick: ${(e as Error).message}`);
    }
    onChanged();
  };

  const stageRows: StageRow[] = rows.map((r) => {
    const asset = assets.find((a) => a.path === r.file);
    const clip: Clip = { id: r.key, lane: r.lane, path: r.file, offset: 0, duration: 0, rev: asset ? assetRev(asset) : undefined };
    const picked = picks[r.lane] === r.variant;
    return {
      key: r.key,
      name: nameOf(r),
      meta: blind ? "·····" : r.meta,
      color: COLOR[stage],
      clips: [clip],
      cues: stage === "sfx" ? r.cues : undefined,
      audition: { lane: r.lane, clip: r.key },
      picked,
      // Manifest order: with nothing picked or selected, the first bed plays, Blind or not.
      order: all.indexOf(r),
      use: { inUse: picked, onUse: () => void use(r, r.variant), onUnpick: () => void use(r, null) },
      on: `v:${r.key}`,
    };
  });

  const options = variantOnOptions(rows, nameOf, stage === "sfx");
  const notes = state.notes.notes.filter((n) => n.stage === stage);
  const cut = defaultVersion(video ?? undefined);
  const preview: Preview | null = video && cut ? { video: video.id, version: cut.id, file: cut.file, duration: cut.duration } : null;
  // ←/→ step one frame of the project's rate (§17.1).
  const fps = state.project.fps || 30;

  return (
    <AudioStage
      stage={stage}
      film={video?.id ?? null}
      title={STAGE_NAMES[stage]}
      headerExtra={stage === "music" && (
        <button
          class="btn ghost ib"
          aria-label="Blind"
          aria-pressed={blind}
          data-tip={blind ? "Show names" : "Blind: hide names"}
          onClick={() => setBlind(!blind)}
        >
          <Icon name="eyeoff" />
        </button>
      )}
      rows={stageRows}
      preview={preview}
      fps={fps}
      notes={notes}
      onOptions={options}
      noteRow={(n) => variantNoteRow(rows, n.on)}
      onLabel={(n) => variantOnLabel(rows, options, n.on)}
      toast={toast}
      onChanged={onChanged}
      onPendingChange={onPendingChange}
    />
  );
}
