// §22.8: the header's Change Log button and the drawer it opens, newest first by day and live. Not
// modal: the dashboard stays usable. Its open state and filter last the session; the last line seen
// is kept in the browser, for the dot.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import {
  AREA_LABELS, BY_UI, FILTERS, clock, footText, groupByDay, isFilter, jumpOf, localDate, newCount, problemText, recall, remember, rowName, storageKey,
  type Filter, type JumpTarget, type KeyStore,
} from "../changelog.js";
import { moveActive } from "../versions.js";
import type { LogHead, LogLine, LogView, Project, Stage } from "../types.js";

/** How many lines the drawer loads (R16): the footer says when there are more. */
const LIMIT = 1000;
/** Scrolled further than this counts as reading: new lines wait behind the pill (§22.8). */
const READING_PX = 40;
/** Keys the drawer uses itself (moving through the chips, scrolling the list, pressing a row): they stop here, so they never step the picture's frames or play it. */
const OWN_KEYS = new Set([" ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

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
  open: boolean;
  /** True when the person opened it just now (the input takes focus); false when it reopens with the session. */
  focusOnOpen: boolean;
  /** Lines arrived since it was last open (R19). */
  dot: boolean;
  setOpen(open: boolean): void;
}

export function useChangeLog(projectId: string, head: LogHead | null | undefined): ChangeLogState {
  const [open, setOpenState] = useState(() => recall(session(), storageKey(projectId, "log-open")) === "1");
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  const [seen, setSeen] = useState(() => recall(local(), storageKey(projectId, "log-seen")));
  const mark = head?.mark ?? null;
  // Whatever arrives while it's open has been seen.
  useEffect(() => {
    if (!open || !mark || mark === seen) return;
    setSeen(mark);
    remember(local(), storageKey(projectId, "log-seen"), mark);
  }, [open, mark]);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    setFocusOnOpen(o);
    remember(session(), storageKey(projectId, "log-open"), o ? "1" : "0");
  };
  return { open, focusOnOpen, dot: !open && !!mark && mark !== seen, setOpen };
}

/** The mockup's clock-arrow. */
function HistoryIcon() {
  return (
    <svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function ChangeLogButton({ log, buttonRef }: { log: ChangeLogState; buttonRef: { current: HTMLButtonElement | null } }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      class="btn clog"
      aria-expanded={log.open}
      aria-controls={log.open ? "changelog" : undefined}
      onClick={() => log.setOpen(!log.open)}
    >
      <HistoryIcon />
      Change Log
      {log.dot && (
        <>
          <span class="cdot" aria-hidden="true" />
          <span class="vh"> (new entries)</span>
        </>
      )}
    </button>
  );
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

export interface ChangeLogDrawerProps {
  log: ChangeLogState;
  projectId: string;
  head: LogHead | null | undefined;
  project: Pick<Project, "videos" | "lanes">;
  /** The tab on screen: a line added here is about it (R15). */
  stage: Stage | "assets";
  /** The page header: the drawer sits under it. */
  header: { current: HTMLElement | null };
  buttonRef: { current: HTMLButtonElement | null };
  toast(message: string): void;
  onJump(to: JumpTarget): void;
}

export function ChangeLogDrawer(props: ChangeLogDrawerProps) {
  return props.log.open ? <Drawer {...props} /> : null;
}

function Row({ entry: e, to, onGo }: { entry: LogLine; to: JumpTarget | null; onGo(to: JumpTarget): void }) {
  const time = clock(new Date(e.at));
  const inner = (
    <>
      <span class="ltime">{time}</span>
      <span class={`ltag ${e.area}`}>{AREA_LABELS[e.area]}</span>
      <span class="ltext">
        {e.text}
        <span class="lby">{BY_UI[e.by]}</span>
      </span>
      <span class="lgo" aria-hidden="true">{to ? "›" : ""}</span>
    </>
  );
  // R14: a row with somewhere to go is a button; the rest are text, so Tab doesn't stop on every line.
  return to ? (
    <button type="button" class="lrow" data-entry={e.id} data-go="" aria-label={rowName(e, time)} onClick={() => onGo(to)}>{inner}</button>
  ) : (
    <div class="lrow" data-entry={e.id}>{inner}</div>
  );
}

function Drawer({ log, projectId, head, project, stage, header, buttonRef, toast, onJump }: ChangeLogDrawerProps) {
  const [view, setView] = useState<LogView | null>(null);
  const [waiting, setWaiting] = useState<LogView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(() => {
    const saved = recall(session(), storageKey(projectId, "log-filter"));
    return isFilter(saved) ? saved : "all";
  });
  const [text, setText] = useState("");
  const [top, setTop] = useState(0);
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const chips = useRef<Record<string, HTMLButtonElement | null>>({});
  const shown = useRef<LogView | null>(null);
  shown.current = view;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const seq = useRef(0);

  const reading = () => (list.current?.scrollTop ?? 0) > READING_PX;
  /** Fetches the newest lines. While someone reads further down, they wait behind the pill instead (§22.8). */
  const load = async (force = false) => {
    const n = ++seq.current;
    const q = new URLSearchParams({ limit: String(LIMIT) });
    if (filterRef.current !== "all") q.set("area", filterRef.current);
    try {
      const next = await api.get<LogView>(`/api/log?${q}`);
      if (n !== seq.current) return;
      setProblem(null);
      if (!force && shown.current && reading()) setWaiting(next);
      else {
        setView(next);
        setWaiting(null);
      }
    } catch (e) {
      if (n !== seq.current) return;
      // With nothing on show the list says why; with lines on show they stay, and a toast says so.
      if (shown.current) toast(problemText("read", e));
      else setProblem(problemText("read", e));
    }
  };
  // A new filter starts at the top.
  useEffect(() => {
    if (list.current) list.current.scrollTop = 0;
    setWaiting(null);
    void load(true);
  }, [filter]);
  // Every write moves the head's rev (the existing change event refreshes it): fetch again. Not on
  // the first render, which the filter's effect has just loaded.
  const firstRev = useRef(true);
  useEffect(() => {
    if (firstRev.current) {
      firstRev.current = false;
      return;
    }
    void load();
  }, [head?.rev, head?.mark]);

  // Under the header, whatever its height.
  useLayoutEffect(() => {
    const el = header.current;
    if (!el) return;
    const place = () => setTop(Math.max(0, Math.round(el.getBoundingClientRect().bottom)));
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, { passive: true });
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place);
    };
  }, []);

  useEffect(() => {
    if (log.focusOnOpen) input.current?.focus();
  }, []);

  const close = () => {
    log.setOpen(false);
    buttonRef.current?.focus();
  };
  // R13: Esc closes it when the key comes from inside it, from its button or from the page itself.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as Node | null;
      const here = !t || t === document.body || t === document.documentElement || t === buttonRef.current || !!root.current?.contains(t);
      if (!here) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const add = async () => {
    const line = text.trim();
    if (!line) return;
    try {
      await api.post("/api/log", { text: line, area: stage });
      setText("");
      if (list.current) list.current.scrollTop = 0;
      await load(true);
    } catch (e) {
      toast(problemText("add", e));
    }
  };
  const choose = (f: Filter) => {
    setFilter(f);
    remember(session(), storageKey(projectId, "log-filter"), f);
  };
  // A radio group: the arrows move and choose.
  const onChipKey = (e: KeyboardEvent, i: number) => {
    const to = moveActive(e.key, i, FILTERS.length, true);
    if (to === null) return;
    e.preventDefault();
    const f = FILTERS[to][0];
    choose(f);
    chips.current[f]?.focus();
  };
  const showWaiting = () => {
    if (!waiting) return;
    setView(waiting);
    setWaiting(null);
    if (list.current) list.current.scrollTop = 0;
    // The pill goes; focus moves to the newest line (or, when that line goes nowhere, the list)
    // rather than being lost, and never scrolls the list away from the top.
    requestAnimationFrame(() => {
      const first = list.current?.querySelector<HTMLElement>(".lrow");
      (first instanceof HTMLButtonElement ? first : list.current)?.focus({ preventScroll: true });
    });
  };
  const onScroll = () => {
    if (waiting && !reading()) {
      setView(waiting);
      setWaiting(null);
    }
  };
  const go = (to: JumpTarget) => {
    onJump(to);
    if (window.innerWidth < 560) log.setOpen(false); // R18: full width covers the page
  };
  // The rows below are memoised, so they call the newest `go` (and the page's newest jump) through a ref.
  const goRef = useRef(go);
  goRef.current = go;
  const goLatest = useRef((to: JumpTarget) => goRef.current(to)).current;
  const exportMd = async () => {
    try {
      const r = await api.post<{ path: string }>("/api/exports/change-log", {});
      toast(`Saved to ${r.path}`);
    } catch (e) {
      toast(problemText("export", e));
    }
  };

  // The rows are built once per fetched view (and when the project or the day changes), not on
  // every render of the page around them: a thousand of them is the most the drawer shows (R16).
  const today = localDate(new Date());
  const rows = useMemo(() => {
    if (!view) return null;
    return groupByDay(view.entries, new Date()).map((g, i) => (
      <div class="dgroup" key={`${g.key}#${i}`}>
        <h3 class="dday">{g.heading}</h3>
        <ul>
          {g.entries.map((e) => (
            <li key={e.id}>
              <Row entry={e} to={jumpOf(e, project)} onGo={goLatest} />
            </li>
          ))}
        </ul>
      </div>
    ));
  }, [view, project, today]);

  const fresh = view && waiting ? newCount(view.entries, waiting.entries) : 0;
  const nothing = view !== null && view.total === 0 && view.undated.length === 0;
  const nothingHere = view !== null && !nothing && view.entries.length === 0 && view.undated.length === 0;
  return (
    <aside
      id="changelog"
      class="drawer"
      ref={root}
      aria-label="Change Log"
      style={{ top: `${top}px` }}
      onKeyDown={(e) => {
        if (OWN_KEYS.has(e.key)) e.stopPropagation();
      }}
    >
      <div class="dhead">
        <h2>Change Log</h2>
        <span class="dquiet">newest first</span>
        <button type="button" class="btn dclose" aria-label="Close the change log" onClick={close}>Close</button>
      </div>
      <form class="dadd" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input
          ref={input}
          value={text}
          maxLength={160}
          placeholder="Add a line to the log"
          aria-label="Add a line to the log"
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn">Add</button>
      </form>
      <div class="dchips" role="radiogroup" aria-label="Show">
        {FILTERS.map(([f, label], i) => (
          <button
            type="button"
            role="radio"
            aria-checked={filter === f}
            tabIndex={filter === f ? 0 : -1}
            ref={(el) => { chips.current[f] = el; }}
            onClick={() => choose(f)}
            onKeyDown={(e) => onChipKey(e, i)}
          >
            {label}
          </button>
        ))}
      </div>
      {/* The pill sits over the list, outside the scroller, so showing it never moves a line (§22.8). */}
      <div class="dwrap">
        {fresh > 0 && <button type="button" class="dpill" onClick={showWaiting}>{fresh} new</button>}
        <div class="dlist" ref={list} tabIndex={0} role="group" aria-label="Entries" onScroll={onScroll}>
          {view === null && !problem && <p class="dempty">Loading…</p>}
          {view === null && problem && <p class="dempty dproblem" role="alert">{problem}</p>}
          {nothing && <p class="dempty">Nothing yet. Rushes writes a line here whenever a cut, a take or a variant is added.</p>}
          {nothingHere && <p class="dempty">Nothing for this filter.</p>}
          {rows}
          {view && view.undated.length > 0 && (
            <section class="dbefore" aria-label="Before the log">
              <h3>Before the log</h3>
              <ul>{view.undated.map((u, i) => <li key={i}>{u.text}</li>)}</ul>
            </section>
          )}
        </div>
      </div>
      <div class="dfoot">
        <span>{view ? footText(view) : ""}</span>
        <button type="button" class="btn" onClick={() => void exportMd()}>Export as Markdown</button>
      </div>
    </aside>
  );
}
