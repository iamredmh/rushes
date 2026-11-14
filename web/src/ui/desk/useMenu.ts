// §27, 5.2: what the top bar's menus share, after the version list's pattern (§22.8): while a menu is open its active row has
// focus (roving), the arrows, Home and End move it, typing jumps to a row, and a click, focus or Escape outside closes it.
import type { RefObject } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { moveActive } from "../../versions.js";
import { useDismiss } from "../useDismiss.js";

/** Characters typed within this long of each other make one search (as in the version list). */
const TYPE_AHEAD_MS = 700;

export interface Menu {
  open: boolean;
  /** Opens the menu with row `at` active. */
  show(at?: number): void;
  close(focusButton: boolean): void;
  toggle(at?: number): void;
  /** The ref for row `i`, in the order the arrows move through them. */
  row(i: number): (el: HTMLElement | null) => void;
  /** Goes on the menu's own element. */
  onKeyDown(e: KeyboardEvent): void;
  button: RefObject<HTMLButtonElement>;
  wrap: RefObject<HTMLSpanElement>;
}

/**
 * `count` rows; `find(text)` names the row typed text leads to, or null. Every key the menu handles stops in it, so a digit
 * does not switch workspace, Space does not play and an arrow does not step a frame behind it.
 */
export function useMenu(count: number, find?: (text: string) => number | null): Menu {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  const rows = useRef<(HTMLElement | null)[]>([]);
  const typed = useRef({ text: "", at: -Infinity });

  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  const show = (at = 0) => {
    setActive(Math.max(0, Math.min(count - 1, at)));
    typed.current = { text: "", at: -Infinity };
    setOpen(true);
  };
  useDismiss(open, wrap, close);
  useLayoutEffect(() => {
    if (open) rows.current[active]?.focus();
  }, [open, active]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") return close(false);
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const focused = rows.current.findIndex((el) => el === document.activeElement);
    let to = moveActive(e.key, focused < 0 ? active : focused, count);
    // A disabled row (Shelve film with no film) cannot take focus: the arrows step over it, Home and End to the nearest.
    const disabled = (i: number) => (rows.current[i] as HTMLButtonElement | null)?.disabled === true;
    const onward = e.key === "Home" ? "ArrowDown" : e.key === "End" ? "ArrowUp" : e.key;
    for (let n = 0; to !== null && n < count && disabled(to); n++) to = moveActive(onward, to, count);
    if (to !== null && disabled(to)) to = null;
    if (to !== null) {
      e.preventDefault();
      e.stopPropagation();
      setActive(to);
      rows.current[to]?.focus();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Enter and Space press the row (the browser's own click); only the page behind must not hear them.
    if (e.key === "Enter" || e.key === " ") return void e.stopPropagation();
    if (e.key.length === 1) {
      e.stopPropagation();
      if (!find) return;
      const text = e.timeStamp - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + e.key : e.key;
      typed.current = { text, at: e.timeStamp };
      const hit = find(text.toLowerCase());
      if (hit !== null) {
        e.preventDefault();
        setActive(hit);
        rows.current[hit]?.focus();
      }
    }
  };

  return {
    open,
    show,
    close,
    toggle: (at) => (open ? close(false) : show(at)),
    row: (i) => (el) => {
      rows.current[i] = el;
    },
    onKeyDown,
    button,
    wrap,
  };
}
