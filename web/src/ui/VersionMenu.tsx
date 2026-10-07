// §22.8: Picture's version control. A menu button opens a list with one line per version (id, short
// label, how long ago, a lock on the locked one) and the full note beside it. On a touch screen the
// note shows under the row instead. It replaces the native <select>, which can't truncate. Also the
// cut's full note under the picture, two lines at most.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Version } from "../types.js";
import { ago, moveActive, shortLabel, typeAhead, versionMeta } from "../versions.js";
import { Icon } from "./Icon.js";

export interface VersionMenuProps {
  /** The film's versions, oldest first, as stored. */
  versions: Version[];
  /** The version on screen. */
  shown: Version;
  lockedVersion: string | null;
  onPick(id: string): void;
}

/** Digits typed within this long of each other make one version number (type-ahead). */
const TYPE_AHEAD_MS = 700;
/** The list keeps this far from the window's edges (the page's side gutter). */
const EDGE = 16;
const touchScreen = () => typeof matchMedia === "function" && matchMedia("(hover: none)").matches;

export function VersionMenu({ versions, shown, lockedVersion, onPick }: VersionMenuProps) {
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
  const typed = useRef({ text: "", at: -Infinity });
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

  // Roving focus: while the list is open, the active row has it.
  useLayoutEffect(() => {
    if (open) rowEls.current[active]?.focus();
  }, [open, active]);
  // Keep the list inside the window: measured once as it opens, and again if the window is resized.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const w = wrap.current?.getBoundingClientRect();
      const m = menu.current?.getBoundingClientRect();
      if (!w || !m) return;
      const room = document.documentElement.clientWidth - EDGE;
      setShift(Math.max(0, Math.min(w.left + m.width - room, w.left - EDGE)));
    };
    place();
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
      // Tab (or Alt+Tab in Safari) closes the list and carries on to the next control.
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
        aria-label={`Version: ${shown.id} · ${label}`}
        onClick={() => (open ? close(false) : show(shown.id))}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            e.stopPropagation();
            show(shown.id);
          }
        }}
      >
        <span class="vid">{shown.id}</span>
        <span class="vlbl">{label}</span>
        <Icon name="chev" />
      </button>
      {open && (
        <div ref={menu} class={`vmenu${touch ? " touch" : ""}`} style={shift ? { left: `${-shift}px` } : undefined}>
          <div class="vlist" role="listbox" aria-label="Versions" onKeyDown={onListKey} onMouseLeave={() => setHover(null)}>
            {rows.map((v) => (
              <button
                type="button"
                role="option"
                class="vrow"
                data-version={v.id}
                data-on={v.id === (hover ?? active) ? "true" : "false"}
                aria-selected={v.id === shown.id}
                aria-describedby={!touch && v.id === detail.id ? "vdetail" : undefined}
                tabIndex={v.id === active ? 0 : -1}
                ref={(el) => { rowEls.current[v.id] = el; }}
                onMouseEnter={() => setHover(v.id)}
                onClick={() => onRowClick(v.id)}
              >
                <span class="vid">{v.id}</span>
                <span class="vlbl">{shortLabel(v)}</span>
                <span class="vwhen">
                  {v.id === lockedVersion && (
                    <>
                      <Icon name="lock" />
                      <span class="vh">Locked, </span>
                    </>
                  )}
                  {ago(v.addedAt, now)}
                </span>
                {touch && tapped === v.id && (
                  <span class="vinline">
                    {v.note.trim() || "No note."}
                    <span class="vmeta">{versionMeta(v, now)}</span>
                  </span>
                )}
              </button>
            ))}
          </div>
          {!touch && (
            <div class="vdetail" id="vdetail">
              <h4>{detail.id}</h4>
              <p>{detail.note.trim() || "No note."}</p>
              <span class="vmeta">{versionMeta(detail, now)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** §22.8: the full note of the cut on show, under the picture. Two lines at most, with More when it's cut short (R23). */
export function VersionNote({ version }: { version: Version }) {
  const [more, setMore] = useState(false);
  const [clamped, setClamped] = useState(false);
  const text = useRef<HTMLSpanElement>(null);
  useEffect(() => setMore(false), [version.id]);
  useLayoutEffect(() => {
    const el = text.current;
    if (!el) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [version.id, version.note, more]);
  const note = version.note.trim();
  if (!note) return null;
  const id = `vnote-${version.id}`;
  return (
    <div class="vnote">
      <span ref={text} id={id} class={more ? "vtext" : "vtext vclamp"}>{note}</span>
      {(clamped || more) && (
        <button type="button" class="vmore" aria-expanded={more} aria-controls={id} onClick={() => setMore(!more)}>
          {more ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}
