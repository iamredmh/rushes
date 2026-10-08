// Fix round 3 (M2): Picture's player column is capped at the window's height, and only the frame
// box gives way, down to its 200px floor. In a window too short for even that, the column must
// grow to hold what's in it rather than spill over the shot strip below. CSS can't say "this
// column's content with the frame at 200px", so it's measured here, as --player-floor on the
// column, which the cap never goes below.
import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";

/** The frame box's smallest height, as in styles.css. */
export const FRAME_FLOOR_PX = 200;

/** Keeps `--player-floor` on the column current: its content's height with the frame box at its floor. */
export function usePlayerFloor(column: RefObject<HTMLElement>): void {
  useEffect(() => {
    const el = column.current;
    if (!el) return;
    const measure = () => {
      // Only what's drawn: a hidden row (the proxy bar on another format) has no box, and its zero rect would count as the top.
      const kids = ([...el.children] as HTMLElement[]).filter((k) => k.getClientRects().length > 0);
      if (kids.length === 0) return;
      const box = kids.find((k) => k.classList.contains("framebox"));
      const top = Math.min(...kids.map((k) => k.getBoundingClientRect().top));
      const bottom = Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
      const rest = bottom - top - (box ? box.getBoundingClientRect().height : 0);
      const floor = `${Math.ceil(rest + (box ? FRAME_FLOOR_PX : 0))}px`;
      if (el.style.getPropertyValue("--player-floor") !== floor) el.style.setProperty("--player-floor", floor);
    };
    const ro = new ResizeObserver(measure);
    const watch = () => {
      ro.disconnect();
      for (const k of el.children) ro.observe(k);
      measure();
    };
    // A row that comes or goes (the proxy offer, say) is watched too.
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true });
    watch();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, []);
}
