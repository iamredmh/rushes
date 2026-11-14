// §26.6: the Film menu: a button beside the Change Log that opens a short list of actions for the film you are in. Pills only
// switch films; anything done to a film is done here, to the film named at the top of the list.
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { Video } from "../types.js";
import { Icon } from "./Icon.js";
import { applyTheme, nextTheme, readTheme, safeStorage, saveTheme, THEME_LABEL } from "../theme.js";
import { useDismiss } from "./useDismiss.js";

export function FilmMenu({ video, onToggleShelved }: { video: Video | undefined; onToggleShelved(): void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const close = (focusButton: boolean) => {
    setOpen(false);
    if (focusButton) button.current?.focus();
  };
  useDismiss(open, wrap, close);
  // The first entry has focus as the list opens, so Enter acts and Tab leaves.
  useLayoutEffect(() => {
    if (open) first.current?.focus();
  }, [open]);
  const shelved = !!video?.shelved;
  // The browser's own setting, not the film's: it lives here until the desk has a menu of its own (§27, 5.2).
  const [theme, setTheme] = useState(() => readTheme(safeStorage()));
  const cycleTheme = () => {
    const next = nextTheme(theme);
    saveTheme(next);
    applyTheme(next);
    setTheme(next);
  };

  return (
    <span class="fmwrap" ref={wrap}>
      <button
        ref={button}
        type="button"
        class="btn ghost ib tip-below"
        data-tip={video ? `Film actions · ${video.name}` : "Film actions"}
        aria-label="Film actions"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!video}
        onClick={() => setOpen(!open)}
      >
        <Icon name="more" />
      </button>
      {open && video && (
        <div class="fmenu" role="menu" aria-label={`Film actions for ${video.name}`}>
          <div class="fmtitle">
            Film
            <b dir="auto">{video.name}</b>
          </div>
          <button
            ref={first}
            type="button"
            role="menuitem"
            class="fmitem"
            onClick={() => {
              close(true);
              onToggleShelved();
            }}
          >
            <Icon name={shelved ? "undo" : "shelve"} />
            {shelved ? "Restore film" : "Shelve film"}
            <kbd>Shift+S</kbd>
          </button>
          {/* Stays open, so one more press tries the next setting. */}
          <button type="button" role="menuitem" class="fmitem" onClick={cycleTheme}>
            <Icon name="circle" />
            Appearance: {THEME_LABEL[theme]}
          </button>
        </div>
      )}
    </span>
  );
}
