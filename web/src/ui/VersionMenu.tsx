// §22.8: Picture's version control. A menu button opens a list with one line per version (id, short
// label, how long ago, a lock on the locked one) and the full note beside it. On a touch screen the
// note shows under the row instead. It replaces the native <select>, which can't truncate. Also the
// cut's full note under the picture, two lines at most.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { Version } from "../types.js";
import { ago, agoSpoken, moveActive, oneLineOf, shortLabel, typeAhead, versionMeta } from "../versions.js";
import { Icon } from "./Icon.js";

export interface VersionMenuProps {
  /** The film's versions, oldest first, as stored. */
  versions: Version[];
  /** The version on screen. */
  shown: Version;
  lockedVersion: string | null;
  onPick(id: string): void;
  /** §27, 5.2: the word the button and its accessible name start with ("Version" when left out; the top bar's is "Cut"). */
  name?: string;
  /** A cut newer than the one on screen: the button carries a dot, and says so to a screen reader. */
  newer?: string | null;
  /** Rows under the list (the Cut menu's lock row). `close(true)` closes the menu and puts focus back on its button. */
  footer?: (close: (focusButton: boolean) => void) => ComponentChildren;
  /** Changed (a count above 0) to open the list with focus on the first row under it (m6: the lock row). */
  openFooter?: number;
}

/** Digits typed within this long of each other make one version number (type-ahead). */
const TYPE_AHEAD_MS = 700;
/** The list keeps this far from the window's edges (the page's side gutter). */
const EDGE = 16;
const touchScreen = () => typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

export function VersionMenu({ versions, shown, lockedVersion, onPick, name = "Version", newer = null, footer, openFooter = 0 }: VersionMenuProps) {
  const rows = [...versions].reverse(); // newest at the top, as before
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(shown.id);
  const [hover, setHover] = useState<string | null>(null);
  const [touch, setTouch] = useState(false);
  const [tapped, setTapped] = useState<string | null>(null);
  // How far the list moves left so it never runs past the window's right edge (and widens the page).
  const [shift, setShift] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const rowEls = useRef<Record<string, HTMLButtonElement | null>>({});
  const foot = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: -Infinity });
  // The dot's words, for the button's description: an id of its own, so two menus never share one.
  const newerId = useId();
  const now = new Date();
  const label = shortLabel(shown);

  const show = (id: string) => {
    setActive(id);
    setHover(null);
    setTapped(null);
    setTouch(touchScreen());
    setOpen(true);
  };
  const close = (focusButton: boolean) => {
    setOpen(false);
    setTapped(null);
    if (focusButton) button.current?.focus();
  };
  const pick = (id: string) => {
    close(true);
    if (id !== shown.id) onPick(id);
  };

  // Roving focus: while the list is open, the active row has it. If that cut has gone (deleted by
  // hand while the list was open), the list closes and focus goes back to the button, rather than
  // falling to the page where the shortcuts would work behind the open list.
  const activeGone = open && !versions.some((v) => v.id === active);
  // Opened for the rows under the list (openFooter): focus goes there instead of to the active row, once.
  const toFooter = useRef(false);
  useLayoutEffect(() => {
    if (activeGone) close(true);
    else if (open && toFooter.current) {
      toFooter.current = false;
      foot.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    } else if (open) rowEls.current[active]?.focus();
  }, [open, active, activeGone]);
  useLayoutEffect(() => {
    if (openFooter <= 0 || !footer) return;
    toFooter.current = true;
    show(shown.id);
  }, [openFooter]);
  // Keep the list inside the window: measured as it opens, after every render while it is open (the button can move
  // when what is beside it changes), and again if the window is resized.
  const place = () => {
    const w = wrap.current?.getBoundingClientRect();
    const m = menu.current?.getBoundingClientRect();
    if (!w || !m) return;
    const room = document.documentElement.clientWidth - EDGE;
    setShift(Math.max(0, Math.min(w.left + m.width - room, w.left - EDGE)));
  };
  useLayoutEffect(() => {
    if (open) place();
  });
  useLayoutEffect(() => {
    if (!open) return;
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  // A click or focus anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("focusin", away, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("focusin", away, true);
    };
  }, [open]);

  // Every key the list handles stops here, so Space doesn't play, the arrows don't step frames and
  // the digits don't switch tabs (App's and Picture's handlers listen on window). Other letters stop
  // here too while the list is open (G would grab a frame behind it).
  const onListKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      // Tab moves on to the rows under the list when there are any; otherwise (or Alt+Tab in Safari) it closes the list
      // and carries on to the next control.
      const first = !e.shiftKey ? foot.current?.querySelector<HTMLButtonElement>("button:not(:disabled)") : null;
      if (first) {
        e.preventDefault();
        e.stopPropagation();
        first.focus();
        return;
      }
      close(false);
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const i = rows.findIndex((v) => v.id === active);
    const to = moveActive(e.key, i, rows.length);
    if (to !== null) {
      e.preventDefault();
      e.stopPropagation();
      setHover(null); // the detail follows the keyboard, not a pointer resting on another row
      setActive(rows[to].id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      pick(active);
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      // The list is vertical: sideways arrows do nothing here, and never step frames behind it.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (/^\d$/.test(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      const text = e.timeStamp - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + e.key : e.key;
      typed.current = { text, at: e.timeStamp };
      const hit = typeAhead(rows.map((v) => v.id), text);
      if (hit) {
        setHover(null);
        setActive(hit);
      }
      return;
    }
    if (e.key.length === 1) e.stopPropagation();
  };
  const onRowClick = (id: string) => {
    // R20: on a touch screen the first tap shows the row's note under it; a second tap picks it.
    if (touch && tapped !== id) {
      setTapped(id);
      setActive(id);
      return;
    }
    pick(id);
  };
  const detail = rows.find((v) => v.id === (hover ?? active)) ?? shown;

  return (
    <div class="vwrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        class="vbtn"
        data-version={shown.id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? "vlist" : undefined}
        aria-label={`${name}: ${shown.id} · ${label}`}
        aria-describedby={newer ? newerId : undefined}
        onClick={() => (open ? close(false) : show(shown.id))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            e.stopPropagation();
            show(shown.id);
          }
        }}
      >
        {name !== "Version" && <small>{name}</small>}
        <span class="vid">{shown.id}</span>
        <span class="vlbl" dir="auto">{label}</span>
        {newer && (
          <span class="vnewer" id={newerId}>
            <span class="vh">{newer} is ready</span>
          </span>
        )}
        <Icon name="chev" />
      </button>
      {open && (
        <div ref={menu} class={`vmenu${touch ? " touch" : ""}`} style={shift ? { left: `${-shift}px` } : undefined}>
          <div class="vlist" id="vlist" role="listbox" aria-label="Versions" onKeyDown={onListKey} onMouseLeave={() => setHover(null)}>
            {rows.map((v) => (
              <button
                type="button"
                role="option"
                class="vrow"
                data-version={v.id}
                data-on={v.id === (hover ?? active) ? "true" : "false"}
                aria-selected={v.id === shown.id}
                aria-label={rowName(v, lockedVersion, now)}
                aria-describedby={!touch && v.id === detail.id ? "vdetail" : undefined}
                tabIndex={v.id === active ? 0 : -1}
                ref={(el) => { rowEls.current[v.id] = el; }}
                onMouseEnter={() => setHover(v.id)}
                onClick={() => onRowClick(v.id)}
              >
                <span class="vid">{v.id}</span>
                <span class="vlbl" dir="auto">{shortLabel(v)}</span>
                <span class="vwhen">
                  {v.id === lockedVersion && <Icon name="lock" />}
                  {ago(v.addedAt, now)}
                </span>
                {touch && tapped === v.id && (
                  <span class="vinline" dir="auto">
                    {oneLineOf(v.note) || "No note."}
                    <span class="vmeta">{versionMeta(v, now)}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          {footer && (
            <div
              ref={foot}
              class="vfoot"
              onKeyDown={(e) => {
                if (e.metaKey || e.ctrlKey || e.altKey) return;
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  close(true);
                } else if (e.key === "Tab") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.shiftKey) rowEls.current[active]?.focus();
                  else close(false);
                } else if (e.key.length === 1 || e.key === "Enter" || e.key.startsWith("Arrow")) {
                  // Printable keys, Enter and the arrows stay here: nothing behind the menu hears them.
                  e.stopPropagation();
                }
              }}
            >
              {footer(close)}
            </div>
          )}
          {!touch && (
            <div class="vdetail" id="vdetail">
              <h4>{detail.id}</h4>
              <p dir="auto">{oneLineOf(detail.note) || "No note."}</p>
              <span class="vmeta">{versionMeta(detail, now)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A row's accessible name, in full words with commas (M4): "v6, launch 1.45x slower, locked, 2 hours ago". */
function rowName(v: Version, lockedVersion: string | null, now: Date): string {
  return [v.id, shortLabel(v), v.id === lockedVersion ? "locked" : "", agoSpoken(v.addedAt, now)].filter(Boolean).join(", ");
}

