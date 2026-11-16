import type { ComponentChildren } from "preact";
import { fullView, type TimeView, viewPct } from "../../desk.js";
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
  /** The stretch of the cut on screen (the whole cut without one). */
  view?: TimeView;
  /** The row's height once the tracks have been sized (tracks.ts). */
  style?: Record<string, string>;
  /** The handle at the row's foot that sizes it. */
  sizer?: ComponentChildren;
}

/**
 * §27, 5.6: the Picture row. One block per shot, from its start to the next shot's; a cut with no shots is one block. It
 * sits at the foot of the timeline (Red, 16 Nov: the shots were distracting beside the ruler) and each block shows only
 * its shot's number; the name is in its tooltip. A cut with no shots shows its label on its one block.
 */
export function PictureTrack({ shots, duration, t, current, cutLabel, locked, onSeek, view: shown, style, sizer }: PictureTrackProps) {
  const view = shown ?? fullView(duration);
  const pct = (s: number) => viewPct(s, view);
  const blocks = shots.length > 0
    ? shots.map((s, i) => ({ key: String(s.n), start: s.start, end: shots[i + 1]?.start ?? duration, short: shotLabel(s.n), label: `${shotLabel(s.n)} ${s.name}`, tag: s.tag, current: current === s.n }))
    : [{ key: "cut", start: 0, end: duration, short: cutLabel, label: cutLabel, tag: "", current: true }];
  return (
    <div class="trow ptrack" role="group" aria-label="Picture track" data-row="picture" style={style}>
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
            aria-label={b.label}
            data-tip={b.tag ? `${b.label} · ${b.tag}` : b.label}
            style={{ left: `${pct(b.start)}%`, width: `${Math.max(0, pct(b.end) - pct(b.start))}%` }}
            onClick={(e) => {
              // A mouse click hands the keys back to the player; a key press keeps focus here.
              if (e.detail > 0) (e.currentTarget as HTMLElement).blur();
              onSeek(b.start);
            }}
          >
            <span class="plbl">{b.short}</span>
          </button>
        ))}
        <span class="playhead" style={{ left: `${pct(t)}%` }} />
      </div>
      {sizer}
    </div>
  );
}
