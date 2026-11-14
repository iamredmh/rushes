// §27, 5.6: sound on the timeline. Under the Picture track, one row each for Voice, Music and Effects (a swatch, the
// name, its take count, M, S and the level, then one block: the take in use with its waveform), and a Cut sound row
// when the cut file has a sound of its own. The takes in use play through one engine that follows the picture.
// What they play, how loud and what is heard is useMix's (useMix.ts); these are its rows and its loudness readout.
import { useState } from "preact/hooks";
import { mediaKey } from "../../audio/timeline.js";
import { cueKeys, cueLabel, cueName, cuesInTime } from "../../cues.js";
import { markTitle, noteState, pctOf, takeCount } from "../../desk.js";
import { LEVEL_MAX, LEVEL_MIN, LEVEL_STEP, levelText, loudnessReadout, type MixLane } from "../../lib.js";
import type { Note } from "../../types.js";
import { CUE_CARD_ID, CueCard, cardHover, useCueCard } from "../CueCard.js";
import { rovingKeyDown } from "../CueLayers.js";
import { Icon } from "../Icon.js";
import { Wave } from "../Lanes.js";
import { PictureWave } from "../PictureWave.js";
import { type Mix, NAME, type SoundRow } from "./useMix.js";

const COLOR: Record<MixLane, string> = { vo: "var(--vo)", music: "var(--music)", sfx: "var(--sfx)" };
/** What a sound's takes are called, for its count's tooltip. */
const NOUN: Record<MixLane, string> = { vo: "read", music: "bed", sfx: "pass" };
/** The tab each sound's count opens. */
export type SoundTab = "voice" | "music" | "sfx";

export interface SoundTracksProps {
  mix: Mix;
  /** The cut's length: the rows share the Picture track's time scale. */
  duration: number;
  t: number;
  onSeek(t: number): void;
  /** A take count was clicked: open that sound's tab. */
  onOpenTab?(tab: SoundTab): void;
  /** §27, 5.7: a row with a take in use was picked: its block clicked at `t` (the note is at that point, and the playhead
   *  goes there too), or its name clicked (`t` null: the whole take). Its take becomes the note's target. */
  onPick?(row: SoundRow, t: number | null): void;
  /** The row whose take is the note's target. */
  selected?: MixLane | null;
  /** The notes marked on the rows (each on the row `mix.noteRow` names). */
  notes?: Note[];
}

const TAB: Record<MixLane, SoundTab> = { vo: "voice", music: "music", sfx: "sfx" };

/** The rows under the Picture track. */
export function SoundTracks({ mix, duration, t, onSeek, onOpenTab, onPick, selected = null, notes = [] }: SoundTracksProps) {
  const pct = (s: number) => pctOf(s, duration);
  const timeAt = (e: MouseEvent): number | null => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return r.width > 0 ? Math.min(duration, Math.max(0, ((e.clientX - r.left) / r.width) * duration)) : null;
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
        const count = takeCount(row.groups);
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
        const chip = count.fresh > 0 ? `${count.fresh} new` : String(count.all);
        const here = notes.filter((n) => n.t !== null && mix.noteRow(n) === row.lane);
        const picked = selected === row.lane && take !== null;
        return (
          <div key={row.lane} class={`trow strack${take ? "" : " idle"}${picked ? " picked" : ""}`} role="group" aria-label={`${name} track`} data-sound={row.lane} aria-current={picked ? "true" : undefined} style={{ "--c": COLOR[row.lane] }}>
            <div class="thead shead">
              <i class="sw" aria-hidden="true" />
              {take && onPick ? (
                <button type="button" class="snm" aria-pressed={picked} aria-label={`${name}: note on the whole take`} data-tip={`Note on the whole of ${take.variant.name}`} onClick={() => onPick(row, null)}>{name}</button>
              ) : (
                <span class="snm">{name}</span>
              )}
              {count.all > 0 && (
                <button
                  type="button"
                  class={`tcount mono${count.fresh > 0 ? " new" : ""}`}
                  aria-label={`${chip}: see every ${NOUN[row.lane]}`}
                  data-tip={`See every ${NOUN[row.lane]}`}
                  onClick={() => onOpenTab?.(TAB[row.lane])}
                >
                  {chip}
                </button>
              )}
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
            <div
              class="tlane"
              onClick={(e) => {
                const at = timeAt(e);
                if (at === null) return;
                if (take && onPick) onPick(row, at);
                else onSeek(at);
              }}
            >
              {row.block === "take" ? (
                <>
                  <div
                    class={`sblock${take!.stale ? " stale" : ""}`}
                    title={take!.stale ? `${take!.round} · ${take!.variant.name} · made for an older cut` : `${take!.round} · ${take!.variant.name}`}
                    style={{ left: "0%", width: `${pct(end)}%` }}
                  >
                    <span class="slbl">{label}</span>
                  </div>
                  <Wave segments={[{ offset: 0, duration: loaded?.duration ?? 0, peaks: loaded ? loaded.peaks : null }]} length={duration} color={COLOR[row.lane]} />
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
          </div>
        );
      })}
      {mix.cut.shown && (
        <div class="trow strack csound" role="group" aria-label="Cut sound track" style={{ "--c": "var(--pic)" }}>
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
                <PictureWave wave={mix.cut.wave} length={duration} />
              </>
            ) : (
              <div class="sblock none" style={{ left: "0%", width: "100%" }}>
                <span class="slbl">{mix.cut.known ? "No waveform" : ""}</span>
              </div>
            )}
            <span class="playhead" style={{ left: `${pct(t)}%` }} />
          </div>
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
