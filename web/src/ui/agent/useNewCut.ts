// §28: a cut the agent adds while the desk is open. When nothing holds the picture it switches to the cut and says
// "<v> is in"; when something does (playing, a note or mark in the making, a locked picture) it says so with a Show
// button and the Cut menu carries a dot until that cut is on screen. Never on first load: stepCuts (agent.ts) keeps what
// the desk has already seen.
import { useEffect, useRef, useState } from "preact/hooks";
import { cutAction, stepCuts, unseenCut, type CutMemory } from "../../agent.js";

/** How long a toast with Show waits for a press. */
const OFFER_MS = 8000;

export interface NewCut {
  /** The film on screen (its id), or null with none. */
  film: string | null;
  /** The film's version ids, oldest first. */
  versions: readonly string[];
  /** The cut on screen. */
  shown: string | null | undefined;
  /** Something holds the picture where it is: a new cut is offered, not shown. */
  busy: boolean;
  /** Shows a cut (the desk's own Cut menu pick). */
  select(id: string): void;
  toast(message: string, ms?: number, action?: { label: string; run(): void } | null): void;
}

/** The cut for the Cut menu's dot, or null. */
export function useNewCut({ film, versions, shown, busy, select, toast }: NewCut): string | null {
  const seen = useRef<CutMemory | null>(null);
  const [unseen, setUnseen] = useState<{ film: string | null; id: string } | null>(null);
  const latest = useRef({ shown, busy, select, toast });
  latest.current = { shown, busy, select, toast };
  const key = `${film}\n${versions.join("\n")}`;
  useEffect(() => {
    const step = stepCuts(seen.current, film, versions);
    seen.current = step.memory;
    const now = latest.current;
    const act = cutAction(step.arrived, now.shown, now.busy);
    if (!act || step.arrived === null) return;
    const id = step.arrived;
    if (act.show) now.select(id);
    if (act.dot) setUnseen({ film, id });
    now.toast(act.text, act.offer ? OFFER_MS : undefined, act.offer ? { label: "Show", run: () => latest.current.select(id) } : null);
  }, [key]);
  return unseenCut(unseen, film, shown, versions);
}

/** True while the desk's picture is playing: the video in `player` is neither paused nor ended nor gone. */
export function usePlaying(player: { current: HTMLVideoElement | null }): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const look = (e: Event) => {
      const el = player.current;
      if (e.target === el || e.target instanceof HTMLVideoElement) setOn(!!el && !el.paused && !el.ended);
    };
    // Media events don't bubble; the capture phase sees them all.
    const names = ["play", "playing", "pause", "ended", "emptied"];
    for (const n of names) document.addEventListener(n, look, true);
    return () => names.forEach((n) => document.removeEventListener(n, look, true));
  }, []);
  const el = player.current;
  return on && !!el && el.isConnected && !el.paused && !el.ended;
}
