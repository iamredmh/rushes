import type { ComponentChildren } from "preact";
import { fmt } from "../../lib.js";
import { Icon } from "../Icon.js";

export interface TransportProps {
  t: number;
  duration: number;
  playing: boolean;
  onToggle(): void;
  onStep(frames: number): void;
  /** The In/Out being marked ("0:01.00 →" or "0:01.00–0:02.00"), or null. */
  rangeLabel: string | null;
  onClearRange(): void;
  volume: number;
  muted: boolean;
  onVolume(level: number): void;
  onMute(): void;
  /** Full screen is the monitor's; with no picture (no cut yet) there is no button. */
  onFullScreen?(): void;
  /** §27, 5.6: the loudness of what you hear, beside the volume while a take is in use. */
  loudness?: ComponentChildren;
}

/** §27, 5.5: the row under the monitor. Where you are at the left, play in the middle, how it sounds and full screen at the right. */
export function Transport({ t, duration, playing, onToggle, onStep, rangeLabel, onClearRange, volume, muted, onVolume, onMute, onFullScreen, loudness }: TransportProps) {
  const silent = muted || volume === 0;
  return (
    <div class="transport" role="group" aria-label="Transport">
      <div class="tleft">
        <span class="tc" aria-label="Timecode">{fmt(t)}<small>/ <span class="dur">{fmt(duration)}</span></small></span>
        {rangeLabel && (
          <span class="chipx">
            <span class="mono">{rangeLabel}</span>
            <button aria-label="Clear range" data-tip="Clear range" onClick={onClearRange}><Icon name="x" /></button>
          </span>
        )}
      </div>
      <div class="tmid">
        <button class="btn ghost ib" data-tip="Back one frame · ←" aria-label="Back one frame · ←" onClick={() => onStep(-1)}><Icon name="prev" /></button>
        <button class="btn ib tplay" data-tip={playing ? "Pause · Space" : "Play · Space"} aria-label={playing ? "Pause · Space" : "Play · Space"} onClick={onToggle}>
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <button class="btn ghost ib" data-tip="Forward one frame · →" aria-label="Forward one frame · →" onClick={() => onStep(1)}><Icon name="next" /></button>
      </div>
      <div class="tright">
        {loudness}
        <button class="btn ghost ib" data-tip={muted ? "Unmute" : "Mute"} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted} onClick={(e) => { if (e.detail > 0) (e.currentTarget as HTMLElement).blur(); onMute(); }}>
          <Icon name={silent ? "mute" : "volume"} />
        </button>
        <input
          type="range"
          class="vol"
          aria-label="Volume"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onInput={(e) => onVolume(Number((e.currentTarget as HTMLInputElement).value))}
          // So Space, the arrows and the other keys go back to the player once the level is set.
          onPointerUp={(e) => (e.currentTarget as HTMLElement).blur()}
        />
        {onFullScreen && (
          <button class="btn ghost ib" data-tip="Full screen · F" aria-label="Full screen · F" onClick={(e) => { if (e.detail > 0) (e.currentTarget as HTMLElement).blur(); onFullScreen(); }}>
            <Icon name="expand" />
          </button>
        )}
      </div>
    </div>
  );
}
