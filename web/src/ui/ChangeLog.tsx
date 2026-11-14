// §22.8, §27 5.7: the Change Log's state, for the notes panel's Activity tab: whether the tab is the one chosen (kept for
// the session), and the dot that says lines arrived since it was last on screen (the last line seen is kept in the
// browser). The list itself is ActivityList.
import { useEffect, useRef, useState } from "preact/hooks";
import { isNews, recall, remember, storageKey, type KeyStore } from "../changelog.js";
import type { LogHead } from "../types.js";

const session = (): KeyStore | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};
const local = (): KeyStore | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

export interface ChangeLogState {
  /** Activity is the panel's tab chosen (it shows when the panel does). */
  open: boolean;
  /** True when the person opened it just now (the input takes focus); false when it reopens with the session. */
  focusOnOpen: boolean;
  /** Lines arrived since it was last on screen (R19). */
  dot: boolean;
  /** Chooses the tab (true: Activity). `focus`: the "add a line" box takes focus as the list opens (the default when opening). */
  setOpen(open: boolean, focus?: boolean): void;
  /** The list has given the box its focus: a later mount (another view's panel) leaves focus where it is. */
  focused(): void;
  /** The drawer has shown the line `mark` (`id@at`) at the top of the whole log: it's seen. */
  saw(mark: string): void;
}

/** `visible`: the Activity tab is on screen (chosen, in a workspace with the panel, and the panel shown). */
export function useChangeLog(projectId: string, head: LogHead | null | undefined, visible: (open: boolean) => boolean): ChangeLogState {
  const [open, setOpenState] = useState(() => recall(session(), storageKey(projectId, "log-open")) === "1");
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [seen, setSeen] = useState(() => recall(local(), storageKey(projectId, "log-seen")));
  const mark = head?.mark ?? null;
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const see = (m: string) => {
    setSeen(m);
    remember(local(), storageKey(projectId, "log-seen"), m);
  };
  const shown = visible(open);
  // Whatever arrives while it's on screen has been seen.
  useEffect(() => {
    if (shown && mark && isNews(mark, seen)) see(mark);
  }, [shown, mark]);
  // Seen in another tab of this project is seen here too (fix round 1, M3).
  useEffect(() => {
    const key = storageKey(projectId, "log-seen");
    const onStorage = (e: StorageEvent) => {
      if (e.key === key && e.newValue) setSeen(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);
  const setOpen = (o: boolean, focus = o) => {
    setOpenState(o);
    setFocusOnOpen(o && focus);
    remember(session(), storageKey(projectId, "log-open"), o ? "1" : "0");
  };
  // What the drawer showed counts too: its own fetch can be ahead of the page's (fix round 1).
  const saw = (m: string) => {
    if (isNews(m, seenRef.current)) see(m);
  };
  return { open, focusOnOpen, dot: !shown && isNews(mark, seen), setOpen, saw, focused: () => setFocusOnOpen(false) };
}

/** R18: after a jump, a variant's lane row takes focus once its tab has drawn it (for up to about a second). */
export function focusRow(row: string): void {
  let tries = 0;
  const attempt = () => {
    const el = document.querySelector<HTMLElement>(`.lane[data-row="${CSS.escape(row)}"] .nm`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      el.focus({ preventScroll: true });
      return;
    }
    if (++tries < 60) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
