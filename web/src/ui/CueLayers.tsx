// §23: a pass's layers by sound, under its row. Each cue name gets one layer, in order of first
// appearance. A layer has its count, a tick everywhere that sound comes in, its own playhead line
// (moved by AudioStage with the lane's, never by state here) and, when the agent sent one, the
// sample's file as a play button on the one-player bus.
import { useEffect, useRef, useState } from "preact/hooks";
import { type SampleState, samples } from "../audio/sample.js";
import { baseName, cueLabel, cueLayers, cuesInTime, rovingIndex, tickLeft } from "../cues.js";
import type { Cue } from "../types.js";
import { type CardApi, type CardCue, CUE_CARD_ID, cardHover } from "./CueCard.js";
import { Icon } from "./Icon.js";

/** What rovingKeyDown reads off a key event. */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  currentTarget: EventTarget | null;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * ←/→/Home/End move focus among the `selector` buttons beside this one (DOM order is time order);
 * Esc hides the card. Those keys stop here, so the transport's ←/→ frame steps (AudioStage's
 * window handler) don't fire while a cue has focus (ruling R7).
 */
export function rovingKeyDown(e: KeyLike, selector: string, card: CardApi): void {
  if (e.key === "Escape") {
    if (card.shown !== null) {
      e.preventDefault();
      e.stopPropagation();
      card.hide();
    }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const self = e.currentTarget as HTMLElement;
  const all = [...(self.parentElement?.querySelectorAll<HTMLElement>(`:scope > ${selector}`) ?? [])];
  const next = rovingIndex(e.key, all.indexOf(self), all.length);
  if (next === null) return;
  e.preventDefault();
  e.stopPropagation();
  all[next].focus();
}

export interface CueLayersProps {
  /** The element id, which the chevron's aria-controls names. */
  id: string;
  /** The pass's name, for the group's accessible name. */
  name: string;
  cues: Cue[];
  /** The timeline's length in seconds, as the lanes use. */
  length: number;
  color: string;
  card: CardApi;
  /** A tick was pressed: move the playhead to `t` and aim the note at the cue. */
  onSeek(t: number, cueId: string): void;
  toast(message: string): void;
}

function useSample(): SampleState {
  const [state, setState] = useState(samples.state());
  useEffect(() => samples.subscribe(setState), []);
  return state;
}

export function CueLayers({ id, name, cues, length, color, card, onSeek, toast }: CueLayersProps) {
  const order = cuesInTime(cues);
  const place = new Map(order.map((c, i) => [c, i + 1] as const));
  const layers = cueLayers(cues);
  // Each layer's Tab stop: the tick last focused, else its first.
  const [active, setActive] = useState<Record<string, number>>({});
  const sample = useSample();
  const ownFiles = useRef(new Set<string>());
  ownFiles.current = new Set(cues.flatMap((c) => (c.file ? [c.file] : [])));
  // Closing the layers (or leaving the tab) stops a sample they started.
  useEffect(
    () => () => {
      const s = samples.state();
      if (s.playing && s.path !== null && ownFiles.current.has(s.path)) samples.stop();
    },
    [],
  );
  const audition = async (file: string) => {
    try {
      await samples.toggle(file);
    } catch {
      toast(`Couldn't play ${baseName(file)}`);
    }
  };

  return (
    <div class="clayers" id={id} role="group" aria-label={`Layers for ${name}`} style={`--lane: ${color}`}>
      {layers.map((l) => {
        const at = Math.min(active[l.name] ?? 0, l.cues.length - 1);
        const file = l.file;
        const playing = file !== null && sample.playing && sample.path === file;
        return (
          <div class="clayer" key={l.name} data-layer={l.name}>
            <div class="clname">
              <span>{l.name}</span>
              <em>×{l.cues.length}</em>
            </div>
            <div class="cltrack">
              {l.cues.map((c, j) => {
                const cc: CardCue = { key: `l:${id}:${c.id}`, name: l.name, t: c.t, n: place.get(c) ?? j + 1, of: order.length, file: c.file ?? null, color };
                const shown = card.shown === cc.key;
                return (
                  <button
                    type="button"
                    class={`ltick${shown ? " hot" : ""}`}
                    key={c.id}
                    tabIndex={j === at ? 0 : -1}
                    style={{ left: tickLeft(c.t, length) }}
                    aria-label={cueLabel(c)}
                    aria-describedby={shown ? CUE_CARD_ID : undefined}
                    {...cardHover(card, cc)}
                    onFocus={(e) => {
                      setActive((a) => (a[l.name] === j ? a : { ...a, [l.name]: j }));
                      card.show(e.currentTarget, cc);
                    }}
                    onBlur={() => card.hide()}
                    onKeyDown={(e) => rovingKeyDown(e, "button.ltick", card)}
                    onClick={() => onSeek(c.t, c.id)}
                  />
                );
              })}
              <div class="playhead" />
            </div>
            <div class="clfile">
              {file !== null && (
                <button type="button" aria-pressed={playing} aria-label={`Play ${file}`} onClick={() => void audition(file)}>
                  <Icon name={playing ? "pause" : "play"} />
                  <span>{baseName(file)}</span>
                </button>
              )}
              {l.moreFiles > 0 && <small>+{l.moreFiles}</small>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
