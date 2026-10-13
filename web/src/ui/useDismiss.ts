import { useLayoutEffect } from "preact/hooks";
import type { RefObject } from "preact";

/**
 * A popup list closes on a click or focus anywhere outside it, and on Escape. Escape is stopped here so it does not also
 * close the shortcuts sheet behind it. `close(true)` also puts focus back on the button that opened the list. The listeners are
 * bound as the list appears (a layout effect, not one after the next paint), so a key pressed at once is not missed.
 */
export function useDismiss(open: boolean, wrap: RefObject<HTMLElement>, close: (focusButton: boolean) => void): void {
  useLayoutEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("focusin", away, true);
    // In the capture phase, so it runs before App's own Escape handler on window.
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("focusin", away, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
}
