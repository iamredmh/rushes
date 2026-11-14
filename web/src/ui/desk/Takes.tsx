// §27, 5.8: a sound's takes, under the ruler and the Picture row of its tab. New (a heading per round), In use, Earlier
// (a heading per round, all open), then Put away folded into one line, and last the takes on other films, folded too.
// One list for Voice, Music and Effects: what differs (Blind's names, an effects pass's cues and layers) comes in on the
// items and props.
//
// A row is a circle (a radio: the take in use is checked; pressed again, it unpicks), the name (a click selects the take
// and auditions it), a tag with the cut it was made for, Films, Put away (Bring back on a put-away take) and the take's
// waveform as a block on the shared time scale. Every circle is one radio group: one Tab stop, moved by the arrows.
//
// Nothing here re-renders per frame: the playheads are plain elements the tab moves through a ref.
import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { LoadResult } from "../../audio/engine.js";
import { type Clip, mediaKey } from "../../audio/timeline.js";
import { cueKeys, cueLabel, cueName, cuesInTime } from "../../cues.js";
import type { TakeRow } from "../../desk.js";
import { cueRoom } from "../../lib.js";
import type { Cue } from "../../types.js";
import { Missing } from "../AssetViews.js";
import { type CardCue, CUE_CARD_ID, CueCard, cardHover, useCueCard } from "../CueCard.js";
import { CueLayers, rovingKeyDown } from "../CueLayers.js";
import { FilmsMenu, type FilmsControl } from "../FilmsMenu.js";
import { Icon } from "../Icon.js";
import { Wave } from "../Lanes.js";

/** One take as its tab shows it. */
export interface TakeItem {
  take: TakeRow;
  /** "<lane>/<variant>": the row's key, the engine's clip id and the `on` of a note on it. */
  key: string;
  /** As shown: Blind names it "Read 2". */
  name: string;
  /** Its description, or BPM and key, and an effects pass's cue count ("·····" in Blind). */
  meta: string | null;
  /** Its file isn't on disk: nothing plays. */
  missing: boolean;
  /** What the engine plays for it (null when its file is missing). */
  clip: Clip | null;
  /** An effects pass's cues, labelled on its block. Empty on Voice and Music. */
  cues: Cue[];
  films?: FilmsControl;
}

/** A take on other films (or none), listed under "Not on this film" with only its Films button: put it on this film first. */
export interface LooseItem {
  key: string;
  name: string;
  meta: string | null;
  films?: FilmsControl;
  /** On no film at all. */
  none: boolean;
}

export interface TakeListSection {
  kind: "fresh" | "inUse" | "earlier";
  heading: string;
  items: TakeItem[];
}

/** A note drawn on a take's block: a marker at `t`, plus a span to `tOut` for a range. */
export interface TakeMark {
  id: string;
  t: number;
  tOut: number | null;
  status: "todo" | "done";
  text: string;
}

export interface TakesProps {
  /** "Voice takes": the radio group's name. */
  label: string;
  /** The sound's colour token, for the waveforms. */
  color: string;
  sections: TakeListSection[];
  /** Put away: folded into one line with a count and Show. `dot`: one of its takes has an open note. */
  away: { items: TakeItem[]; open: boolean; dot: boolean; onToggle(): void };
  loose: { items: LooseItem[]; what: string; open: boolean; onToggle(): void };
  /** Said in the list when the film has no takes of this sound. */
  none: string;
  length: number;
  media: Record<string, LoadResult | "error">;
  /** The selected take's key: auditioned, and the note's target. */
  selected: string | null;
  marks: Record<string, TakeMark[]>;
  /** The In/Out being marked, drawn on every block. */
  range: { in: number | null; out: number | null };
  /** An effects pass's layers by sound (§23): which are open, and the chevron's toggle. */
  layers?: { open(key: string): boolean; toggle(key: string): void };
  /** The take's name (t null) or a point on its block (t), or one of its cues, was clicked. */
  onSelect(item: TakeItem, t: number | null, cue?: string): void;
  onPick(item: TakeItem): void;
  onUnpick(item: TakeItem): void;
  onPutAway(item: TakeItem, away: boolean): void;
  toast(message: string): void;
}

/** What's cut off by its column: "n" a take's name, "m" its meta line, "h" a heading. By row key, or "h:<heading>". */
type Cut = Record<string, string>;

function measureCut(root: HTMLElement): Cut {
  const out: Cut = {};
  const over = (el: Element | null) => el !== null && el.scrollWidth > el.clientWidth;
  for (const row of root.querySelectorAll<HTMLElement>(".take[data-take]")) {
    const flags = (over(row.querySelector("[data-name]")) ? "n" : "") + (over(row.querySelector("[data-meta-text]")) ? "m" : "");
    if (flags) out[row.dataset.take!] = flags;
  }
  for (const h of root.querySelectorAll<HTMLElement>(".khd[data-h]")) if (over(h)) out[`h:${h.dataset.h}`] = "h";
  return out;
}
const sameCut = (a: Cut, b: Cut) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k]);

export function Takes(props: TakesProps) {
  const { label, color, sections, away, loose, none, length, media, selected, marks, range, layers, onSelect, onPick, onUnpick, onPutAway, toast } = props;
  const pct = (s: number) => (length > 0 ? Math.min(100, Math.max(0, (s / length) * 100)) : 0);
  const root = useRef<HTMLDivElement>(null);

  // A name, meta line or heading cut off by its column shows in full as a tooltip. Measured when the text changes or the
  // list's width changes, never per frame.
  const [cut, setCut] = useState<Cut>({});
  const measure = () => {
    if (!root.current) return;
    const next = measureCut(root.current);
    setCut((prev) => (sameCut(prev, next) ? prev : next));
  };
  const shown = [...sections.flatMap((s) => s.items), ...(away.open ? away.items : [])];
  // A block's width (its file's length on the scale) and its marks (long file, won't play) change what fits.
  const marksOf = (it: TakeItem) => {
    const r = it.clip ? media[mediaKey(it.clip)] : undefined;
    return (r !== undefined && r !== "error" ? `${r.duration}${r.streamed ? "s" : ""}` : "") + (r === "error" ? "b" : "");
  };
  const shape = JSON.stringify([length, sections.map((s) => s.heading), shown.map((it) => [it.key, it.name, it.meta ?? "", it.missing, marksOf(it), it.take.madeFor ?? ""]), loose.open ? loose.items.map((l) => l.key) : null]);
  useLayoutEffect(measure, [shape]);
  useEffect(() => {
    // The list narrows with the window, the notes panel and its divider.
    const ro = new ResizeObserver(measure);
    if (root.current) ro.observe(root.current);
    // Text measured before the web font lands is the fallback font's width.
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, []);

  // §23: the one hover card for every pass's cues, and which cue label is each block's Tab stop.
  const { shown: shownCard, api: card } = useCueCard();
  const [focusCue, setFocusCue] = useState<Record<string, number>>({});

  // One radio group: the take in use is its Tab stop, else the first circle. The arrows move focus between circles
  // without picking (a pick changes the timeline, so it waits for Enter or Space) and never step a frame.
  const radios = sections.flatMap((s) => s.items);
  const tabStop = radios.find((it) => it.take.inUse)?.key ?? radios[0]?.key ?? null;
  const rove = (e: KeyboardEvent) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    e.stopPropagation();
    const all = [...(root.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const i = all.indexOf(e.currentTarget as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? Math.max(0, i - 1) : Math.min(all.length - 1, i + 1);
    all[next]?.focus();
  };

  const heading = (text: string) => (
    <h3 class="khd tip-wrap" data-h={text} data-tip={cut[`h:${text}`] ? text : undefined}>{text}</h3>
  );

  const row = (it: TakeItem, put: "away" | "back" | null) => {
    const take = it.take;
    const current = it.key === selected;
    const flags = cut[it.key] ?? "";
    const result = it.clip ? media[mediaKey(it.clip)] : undefined;
    const loaded = result !== undefined && result !== "error" ? result : null;
    const broken = result === "error";
    const streamed = !!loaded?.streamed;
    // The take's own length on the shared scale; the whole width until its file has loaded.
    const end = loaded ? Math.min(length || loaded.duration, loaded.duration) : length;
    // §23: cues in time order, so the labels, ←/→ and "cue n of N" all follow time.
    const timed = cuesInTime(it.cues);
    const ckeys = cueKeys(timed);
    const rooms = cueRoom(timed, length);
    const tabCue = Math.min(focusCue[it.key] ?? 0, Math.max(0, timed.length - 1));
    const cardCue = (c: Cue, i: number): CardCue => ({ key: `m:${it.key}:${ckeys[i]}`, name: cueName(c), t: c.t, n: i + 1, of: timed.length, file: c.file ?? null, color });
    const here = marks[it.key] ?? [];
    const layersOpen = !!layers?.open(it.key);
    const timeAt = (e: MouseEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      return r.width > 0 ? Math.min(length, Math.max(0, ((e.clientX - r.left) / r.width) * length)) : 0;
    };
    const tip = take.inUse ? "In use" : "Use this one";
    const label = it.missing ? "File not found" : broken ? "This file won't play in a browser" : null;
    return (
      <Fragment key={it.key}>
        <div class={`trow take${current ? " picked" : ""}`} role="group" aria-label={it.name} data-take={it.key} aria-current={current ? "true" : undefined}>
          <div class="thead khead">
            {layers && (
              // §23: the chevron that opens this pass's layers by sound.
              <button
                type="button"
                class="chev tip-start"
                aria-expanded={layersOpen}
                aria-controls={layersOpen && timed.length > 0 ? `cl-${it.key}` : undefined}
                aria-label={`Layers for ${it.name}`}
                aria-description={timed.length === 0 ? "No cues in this pass" : undefined}
                data-tip={timed.length === 0 ? "No cues in this pass" : layersOpen ? "Hide the layers" : "Show the layers"}
                disabled={timed.length === 0}
                onClick={() => layers.toggle(it.key)}
              >
                <Icon name="chev" />
              </button>
            )}
            {put !== "back" && (
              <button
                type="button"
                role="radio"
                class="kpick tip-start"
                aria-checked={take.inUse}
                aria-label={tip}
                aria-description={take.inUse ? "Press again to unpick it" : undefined}
                data-tip={tip}
                tabIndex={it.key === tabStop ? 0 : -1}
                onKeyDown={rove}
                onClick={(e) => {
                  e.stopPropagation();
                  if (take.inUse) onUnpick(it);
                  else onPick(it);
                }}
              />
            )}
            <button
              type="button"
              class="knm"
              // Part of the player: Space still plays with a name focused (§19.8).
              data-player
              aria-label={it.name}
              aria-pressed={current}
              aria-description={it.missing ? "Missing" : undefined}
              data-tip={flags.includes("n") ? it.name : undefined}
              onClick={() => onSelect(it, null)}
            >
              <span data-name>{it.name}</span>
              {it.missing && <Missing />}
            </button>
            {take.madeFor && (
              <span class={`ktag mono${take.stale ? " stale" : ""}`} data-tip={take.stale ? `Made for ${take.madeFor}, an older cut` : `Made for ${take.madeFor}`}>
                {take.madeFor}
              </span>
            )}
            <span class="sp" />
            {it.films && <FilmsMenu name={it.name} control={it.films} />}
            {put && (
              <button type="button" class="btn ghost sm kput" onClick={() => onPutAway(it, put === "away")}>
                {put === "away" ? "Put away" : "Bring back"}
              </button>
            )}
          </div>
          <div class="tlane" onClick={(e) => onSelect(it, timeAt(e))}>
            <div class={`sblock${take.stale ? " stale" : ""}${label ? " empty gone" : ""}`} style={{ left: "0%", width: `${label ? 100 : pct(end)}%` }}>
              <span class="slbl" data-meta data-tip={label === null && flags.includes("m") && it.meta ? it.meta : undefined}>
                {label ?? (
                  <>
                    {streamed && <span class="smk" data-tip="Long file: switching isn't sample-exact"><Icon name="stream" /></span>}
                    <span data-meta-text>{it.meta ?? ""}</span>
                  </>
                )}
              </span>
            </div>
            {it.clip && <Wave segments={[{ offset: 0, duration: loaded?.duration ?? 0, peaks: loaded ? loaded.peaks : null }]} length={length} color={color} />}
            {timed.map((c, i) => (
              <i
                class={`cue-tick${card.shown === `m:${it.key}:${ckeys[i]}` ? " hot" : ""}`}
                aria-hidden="true"
                key={`t${ckeys[i]}:${c.t}:${c.name}`}
                style={{ left: `${pct(c.t)}%`, color }}
                {...cardHover(card, cardCue(c, i))}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(it, c.t, c.id);
                }}
              />
            ))}
            {timed.map((c, i) => {
              const cc = cardCue(c, i);
              const hot = card.shown === cc.key;
              return (
                // Each label gets the gap to its nearest cue, so close cues are cut short rather than overlap.
                <button
                  type="button"
                  class={`cue${hot ? " hot" : ""}`}
                  data-cue={c.id}
                  key={`c${ckeys[i]}:${c.t}:${c.name}`}
                  tabIndex={i === tabCue ? 0 : -1}
                  aria-label={cueLabel(c)}
                  aria-describedby={hot ? CUE_CARD_ID : undefined}
                  style={{ left: `${pct(c.t)}%`, color, maxWidth: `calc(${(rooms[i] * 100).toFixed(3)}% - 8px)` }}
                  {...cardHover(card, cc)}
                  onFocus={(e) => {
                    setFocusCue((f) => (f[it.key] === i ? f : { ...f, [it.key]: i }));
                    card.show(e.currentTarget, cc);
                  }}
                  onBlur={() => card.hide()}
                  onKeyDown={(e) => rovingKeyDown(e, "button.cue", card)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(it, c.t, c.id);
                  }}
                >
                  <span>{cueName(c)}</span>
                </button>
              );
            })}
            {here.map((m) => m.tOut !== null && <span key={`s${m.id}`} class={`span ${m.status}`} data-note={m.id} title={m.text} style={{ left: `${pct(m.t)}%`, width: `${pct(m.tOut) - pct(m.t)}%` }} />)}
            {here.map((m) => <span key={m.id} class={`mk ${m.status}`} data-note={m.id} title={m.text} style={{ left: `${pct(m.t)}%` }} />)}
            {range.in !== null && <span class="span live" style={{ left: `${pct(range.in)}%`, width: `${pct(range.out ?? range.in + Math.max(0.2, length / 200)) - pct(range.in)}%` }} />}
            <span class="playhead" />
          </div>
        </div>
        {layersOpen && timed.length > 0 && (
          <CueLayers id={`cl-${it.key}`} name={it.name} cues={timed} length={length} color={color} card={card} onSeek={(t, cue) => onSelect(it, t, cue)} toast={toast} />
        )}
      </Fragment>
    );
  };

  const nothing = sections.length === 0 && away.items.length === 0;
  const looseCount = loose.items.length;
  const onNoFilm = loose.items.filter((l) => l.none).length;
  return (
    <div class="takes" ref={root} role="radiogroup" aria-label={label} style={{ "--c": color }}>
      {nothing && <p class="knone">{none}</p>}
      {sections.map((s, i) => (
        // Two rounds can share a name: keyed by place, not by heading.
        <Fragment key={`${s.kind}:${i}`}>
          {heading(s.heading)}
          {s.items.map((it) => row(it, it.take.inUse ? null : "away"))}
        </Fragment>
      ))}
      {away.items.length > 0 && (
        <>
          <div class="kfold" data-fold="away">
            {heading(`Put away · ${away.items.length}`)}
            {away.dot && <span class="fdot" data-dot data-tip="Open notes" aria-label="Open notes" role="img" />}
            <button type="button" class="btn ghost sm" aria-expanded={away.open} onClick={away.onToggle}>{away.open ? "Hide" : "Show"}</button>
          </div>
          {away.open && away.items.map((it) => row(it, "back"))}
        </>
      )}
      {looseCount > 0 && (
        <>
          <div class="kfold" data-fold="loose">
            {heading(`Not on this film · ${looseCount} ${loose.what}${onNoFilm ? ` · ${onNoFilm} on no film` : ""}`)}
            <span class="khint">Use Films to put one on it</span>
            <button type="button" class="btn ghost sm" aria-expanded={loose.open} onClick={loose.onToggle}>{loose.open ? "Hide" : "Show"}</button>
          </div>
          {loose.open && loose.items.map((l) => (
            <div key={l.key} class="trow take loose" role="group" aria-label={l.name} data-loose={l.key}>
              <div class="thead khead">
                <span class="knm"><span data-name>{l.name}</span></span>
                <span class="sp" />
                {l.films && <FilmsMenu name={l.name} control={l.films} />}
              </div>
              <div class="tlane">
                <div class="sblock empty" style={{ left: "0%", width: "100%" }}>
                  <span class="slbl">{l.meta ?? ""}</span>
                </div>
              </div>
            </div>
          ))}
        </>
      )}
      <CueCard shown={shownCard} onHide={card.hide} />
    </div>
  );
}
