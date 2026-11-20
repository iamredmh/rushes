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
  /** §35.5: an Attention item is open on this film: the dot shows, in the alert colour, until it clears. */
  alert: boolean;
  /** Chooses the tab (true: Activity). `focus`: the "add a line" box takes focus as the list opens (the default when opening). */
  setOpen(open: boolean, focus?: boolean): void;
  /** The list has given the box its focus: a later mount (another view's panel) leaves focus where it is. */
  focused(): void;
  /** The drawer has shown the line `mark` (`id@at`) at the top of the whole log: it's seen. */
  saw(mark: string): void;
}

/**
 * `visible`: the Activity tab is on screen (chosen, in a workspace with the panel, and the panel shown). §31.5: `film`,
 * in a project with several films: `head` is that film's, and what was seen is kept per film, so a line about one film
 * neither lights nor clears another's dot. Null: the project's, as with one film.
 */
export function useChangeLog(projectId: string, head: LogHead | null | undefined, visible: (open: boolean) => boolean, film: string | null = null): ChangeLogState {
  const seenKey = film ? `${storageKey(projectId, "log-seen")}:${film}` : storageKey(projectId, "log-seen");
  const [open, setOpenState] = useState(() => recall(session(), storageKey(projectId, "log-open")) === "1");
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [seenAll, setSeenAll] = useState<Record<string, string | null>>({});
  const seen = seenKey in seenAll ? seenAll[seenKey] : recall(local(), seenKey);
  const setSeen = (m: string | null) => setSeenAll((all) => ({ ...all, [seenKey]: m }));
  const mark = head?.mark ?? null;
  const seenRef = useRef(seen);
  seenRef.current = seen;
  const see = (m: string) => {
    setSeen(m);
    remember(local(), seenKey, m);
  };
  const shown = visible(open);
  // Whatever arrives while it's on screen has been seen.
  useEffect(() => {
    if (shown && mark && isNews(mark, seen)) see(mark);
  }, [shown, mark, seenKey]);
  // Seen in another tab of this project is seen here too (fix round 1, M3).
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === seenKey && e.newValue) setSeen(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [seenKey]);
  const setOpen = (o: boolean, focus = o) => {
    setOpenState(o);
    setFocusOnOpen(o && focus);
    remember(session(), storageKey(projectId, "log-open"), o ? "1" : "0");
  };
  // What the drawer showed counts too: its own fetch can be ahead of the page's (fix round 1).
  const saw = (m: string) => {
    if (isNews(m, seenRef.current)) see(m);
  };
  return { open, focusOnOpen, dot: !shown && isNews(mark, seen), alert: (head?.attention ?? 0) > 0, setOpen, saw, focused: () => setFocusOnOpen(false) };
}

/** R18: after a jump, a variant's lane row takes focus once its tab has drawn it (for up to about a second). */
export function focusRow(row: string): void {
  let tries = 0;
  const attempt = () => {
    const el = document.querySelector<HTMLElement>(`.take[data-take="${CSS.escape(row)}"] .knm`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      el.focus({ preventScroll: true });
      return;
    }
    if (++tries < 60) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}
