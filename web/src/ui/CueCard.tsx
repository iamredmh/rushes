// §23: the hover card for a cue -- its full name, its time, where it falls in the pass and, when
// the agent sent one, its source file in the lane colour. One per audio tab: Lanes owns it. It shows
// on hover or focus, never takes the pointer, follows its cue when anything scrolls (focusing a tick
// can scroll the layers), and goes on leave, blur or Esc, or when its cue leaves the page.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { cardPosition, cueCount } from "../cues.js";
import { fmt } from "../lib.js";

/** The card's id: the cue it's showing is described by it. */
export const CUE_CARD_ID = "cue-card";

/** What the card says about one cue. `key` tells cues apart across a lane and its layers. */
export interface CardCue {
  key: string;
  name: string;
  t: number;
  /** Its place in time order, from 1. */
  n: number;
  of: number;
  file: string | null;
  color: string;
}

interface Shown {
  cue: CardCue;
  anchor: HTMLElement;
}

export interface CardApi {
  /** The key of the cue on show, or null. */
  shown: string | null;
  show(anchor: HTMLElement, cue: CardCue): void;
  hide(): void;
}

/** The card's state, for a Lanes: what it shows, and the calls that change it. Never per frame. */
export function useCueCard(): { shown: Shown | null; api: CardApi } {
  const [shown, setShown] = useState<Shown | null>(null);
  return {
    shown,
    api: {
      shown: shown?.cue.key ?? null,
      show: (anchor, cue) => setShown((s) => (s && s.anchor === anchor && s.cue.key === cue.key ? s : { anchor, cue })),
      hide: () => setShown(null),
    },
  };
}

/** The pointer half of the card's triggers, for a cue's label or tick. Each button wires focus itself. */
export function cardHover(api: CardApi, cue: CardCue) {
  return {
    onPointerEnter: (e: { currentTarget: EventTarget | null }) => api.show(e.currentTarget as HTMLElement, cue),
    onPointerLeave: () => api.hide(),
  };
}

export function CueCard({ shown, onHide }: { shown: Shown | null; onHide(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    setAt(null);
    if (!shown) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const r = shown.anchor.getBoundingClientRect();
      const next = cardPosition(
        { left: r.left, top: r.top, width: r.width, height: r.height },
        { width: el.offsetWidth, height: el.offsetHeight },
        // The visible area: innerWidth/Height include a classic scrollbar.
        { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
      );
      setAt((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [shown]);
  // Its cue gone from the page (the layers closed under it): the card goes too.
  useLayoutEffect(() => {
    if (shown && !shown.anchor.isConnected) onHide();
  });
  if (!shown) return null;
  const c = shown.cue;
  return (
    <div
      ref={ref}
      id={CUE_CARD_ID}
      class="cuecard"
      role="tooltip"
      style={at ? { left: `${at.left}px`, top: `${at.top}px` } : { left: "0px", top: "0px", visibility: "hidden" }}
    >
      <b>{c.name}</b>
      <span class="m">
        {fmt(c.t)} · {cueCount(c.n, c.of)}
      </span>
      {c.file !== null && (
        <span class="f" style={{ color: c.color }}>
          {c.file}
        </span>
      )}
    </div>
  );
}
