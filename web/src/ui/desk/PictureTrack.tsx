import { pctOf } from "../../desk.js";
import { shotLabel } from "../../lib.js";
import type { Shot } from "../../types.js";
import { Icon } from "../Icon.js";

export interface PictureTrackProps {
  /** The cut's shots, those that start inside it. */
  shots: Shot[];
  duration: number;
  t: number;
  /** The shot under the playhead (its number), or null. */
  current: number | null;
  /** The block's name when the cut has no shots: the cut's label. */
  cutLabel: string;
  locked: boolean;
  /** Seek to a block's start; the player snaps it into the shot. */
  onSeek(start: number): void;
}

/** §27, 5.6: the Picture row. One block per shot, from its start to the next shot's; a cut with no shots is one block. */
export function PictureTrack({ shots, duration, t, current, cutLabel, locked, onSeek }: PictureTrackProps) {
  const pct = (s: number) => pctOf(s, duration);
  const blocks = shots.length > 0
    ? shots.map((s, i) => ({ key: String(s.n), start: s.start, end: shots[i + 1]?.start ?? duration, label: `${shotLabel(s.n)} ${s.name}`, tag: s.tag, current: current === s.n }))
    : [{ key: "cut", start: 0, end: duration, label: cutLabel, tag: "", current: true }];
  return (
    <div class="trow ptrack" role="group" aria-label="Picture track">
      <div class="thead">
        <span>Picture</span>
        {locked && <span class="tlock" role="img" aria-label="Picture locked" data-tip="Picture locked"><Icon name="lock" /></span>}
      </div>
      <div class="tlane">
        {blocks.map((b) => (
          <button
            key={b.key}
            type="button"
            class="pblock"
            aria-current={b.current ? "true" : undefined}
            data-tip={b.tag ? `${b.label} · ${b.tag}` : b.label}
            style={{ left: `${pct(b.start)}%`, width: `${Math.max(0, pct(b.end) - pct(b.start))}%` }}
            onClick={(e) => {
              // A mouse click hands the keys back to the player; a key press keeps focus here.
              if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
              onSeek(b.start);
            }}
          >
            <span class="plbl">{b.label}</span>
          </button>
        ))}
        <span class="playhead" style={{ left: `${pct(t)}%` }} />
      </div>
    </div>
  );
}
