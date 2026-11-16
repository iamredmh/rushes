// §27, 5.6: sound on the timeline. Under the Picture track, one row each for Voice, Music and Effects (a swatch, the
// name, M, S and the level, then one block: the take in use with its waveform), and a Cut sound row
// when the cut file has a sound of its own. The takes in use play through one engine that follows the picture.
// What they play, how loud and what is heard is useMix's (useMix.ts); these are its rows and its loudness readout.
// Red, round 2: no take counts here (what is new is on the sound's tab), and a row is never a note's target.
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { mediaKey } from "../../audio/timeline.js";
import { cueKeys, cueLabel, cueName, cuesInTime } from "../../cues.js";
import { fullView, markTitle, noteState, type TimeView, viewPct, viewTime } from "../../desk.js";
import { LEVEL_MAX, LEVEL_MIN, LEVEL_STEP, levelText, loudnessReadout, type MixLane } from "../../lib.js";
import type { Note } from "../../types.js";
import { CUE_CARD_ID, CueCard, cardHover, useCueCard } from "../CueCard.js";
import { rovingKeyDown } from "../CueLayers.js";
import { Icon } from "../Icon.js";
import { Wave } from "../Lanes.js";
import { PictureWave } from "../PictureWave.js";
import { type Mix, NAME } from "./useMix.js";

const COLOR: Record<MixLane, string> = { vo: "var(--vo)", music: "var(--music)", sfx: "var(--sfx)" };

export interface SoundTracksProps {
  mix: Mix;
  /** The cut's length: the rows share the Picture track's time scale. */
  duration: number;
  t: number;
  onSeek(t: number): void;
  /** The notes marked on the rows (each on the row `mix.noteRow` names). */
  notes?: Note[];
  /** The stretch of the cut on screen (the whole cut without one). */
  view?: TimeView;
  /** A row's height once the tracks have been sized, and the handle at its foot (tracks.ts). */
  rowStyle?(row: string): Record<string, string> | undefined;
  sizer?(row: string): ComponentChildren;
}

/** The rows under the Picture track. */
export function SoundTracks({ mix, duration, t, onSeek, notes = [], view: shown, rowStyle, sizer }: SoundTracksProps) {
  const view = shown ?? fullView(duration);
  const pct = (s: number) => viewPct(s, view);
  const timeAt = (e: MouseEvent): number | null => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return r.width > 0 ? Math.min(duration, Math.max(0, viewTime((e.clientX - r.left) / r.width, view))) : null;
  };
  const seekAt = (e: MouseEvent) => {
    const at = timeAt(e);
    if (at !== null) onSeek(at);
  };
  // §23: the one hover card for the Effects block's cues.
  const { shown: shownCard, api: card } = useCueCard();
  const [focusCue, setFocusCue] = useState(0);

  return (
    <>
      {mix.rows.map((row) => {
        const name = NAME[row.lane];
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
        const here = notes.filter((n) => n.t !== null && mix.noteRow(n) === row.lane);
        return (
          <div key={row.lane} class={`trow strack${take ? "" : " idle"}`} role="group" aria-label={`${name} track`} data-sound={row.lane} data-row={row.lane} style={{ "--c": COLOR[row.lane], ...rowStyle?.(row.lane) }}>
            <div class="thead shead">
              <i class="sw" aria-hidden="true" />
              <span class="snm">{name}</span>
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
                  {/* No name on the block (Red, 16 Nov: it was distracting): which take is in use is on the sound's tab. */}
                  <div
                    class={`sblock${take!.stale ? " stale" : ""}`}
                    role="img"
                    aria-label={take!.stale ? `${take!.round} · ${label} · made for an older cut` : `${take!.round} · ${label}`}
                    style={{ left: `${pct(0)}%`, width: `${pct(end) - pct(0)}%` }}
                  />
                  <Wave segments={[{ offset: 0, duration: loaded?.duration ?? 0, peaks: loaded ? loaded.peaks : null }]} length={view.end - view.start} from={view.start} color={COLOR[row.lane]} />
                </>
              ) : (
                <div class={`sblock none${row.block === "missing" || row.block === "broken" ? " gone" : ""}`} style={{ left: "0%", width: "100%" }}>
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
              {here.map((n) => n.tOut !== null ? (
                <span key={n.id} class={`span ${noteState(n)}`} data-note={n.id} title={markTitle(noteState(n), n.text)} style={{ left: `${pct(n.t!)}%`, width: `${pct(n.tOut) - pct(n.t!)}%` }} />
              ) : (
                <span key={n.id} class={`mk ${noteState(n)}`} data-note={n.id} title={markTitle(noteState(n), n.text)} style={{ left: `${pct(n.t!)}%` }} />
              ))}
              <span class="playhead" style={{ left: `${pct(t)}%` }} />
            </div>
            {sizer?.(row.lane)}
          </div>
        );
      })}
      {mix.cut.shown && (
        <div class="trow strack csound" role="group" aria-label="Cut sound track" data-row="cut" style={{ "--c": "var(--pic)", ...rowStyle?.("cut") }}>
          <div class="thead shead">
            <i class="sw" aria-hidden="true" />
            <span class="snm">Cut sound</span>
            <span class="sp" />
            <button type="button" class="ms" aria-pressed={mix.cutMuted} aria-label="Mute Cut sound" data-tip="Mute Cut sound" onClick={mix.toggleCut}>M</button>
          </div>
          <div class="tlane" onClick={seekAt}>
            {mix.cut.wave ? (
              <>
                <div class="sblock cut" style={{ left: "0%", width: "100%" }} />
                <PictureWave wave={mix.cut.wave} length={view.end - view.start} from={view.start} />
              </>
            ) : (
              <div class="sblock none" style={{ left: "0%", width: "100%" }}>
                <span class="slbl">{mix.cut.known ? "No waveform" : ""}</span>
              </div>
            )}
            <span class="playhead" style={{ left: `${pct(t)}%` }} />
          </div>
          {sizer?.("cut")}
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
