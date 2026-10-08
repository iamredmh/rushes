// §22.8: the header's Change Log button and the drawer it opens, newest first by day and live. Not
// modal: the dashboard stays usable. Its open state and filter last the session; the last line seen
// is kept in the browser, for the dot.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api.js";
import {
  AREA_LABELS, BY_UI, FILTERS, clock, filterShows, footText, groupByDay, isFilter, isNews, jumpOf, localDate, newCount, ownKey, problemText, recall, remember, rowName, storageKey,
  type Filter, type JumpTarget, type KeyStore,
} from "../changelog.js";
import { moveActive } from "../versions.js";
import type { LogHead, LogLine, LogView, Project, Stage } from "../types.js";

/** How many lines the drawer loads (R16): the footer says when there are more. */
const LIMIT = 1000;
/** Scrolled further than this counts as reading: new lines wait behind the pill (§22.8). */
const READING_PX = 40;

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
  /** The drawer has shown the line `mark` (`id@at`) at the top of the whole log: it's seen. */
  saw(mark: string): void;
}

export function useChangeLog(projectId: string, head: LogHead | null | undefined): ChangeLogState {
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
  // Whatever arrives while it's open has been seen.
  useEffect(() => {
    if (open && mark && isNews(mark, seen)) see(mark);
  }, [open, mark]);
  // Seen in another tab of this project is seen here too (fix round 1, M3).
  useEffect(() => {
    const key = storageKey(projectId, "log-seen");
    const onStorage = (e: StorageEvent) => {
      if (e.key === key && e.newValue) setSeen(e.newValue);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);
  const setOpen = (o: boolean) => {
    setOpenState(o);
    setFocusOnOpen(o);
    remember(session(), storageKey(projectId, "log-open"), o ? "1" : "0");
  };
  // What the drawer showed counts too: its own fetch can be ahead of the page's (fix round 1).
  const saw = (m: string) => {
    if (isNews(m, seenRef.current)) see(m);
  };
  return { open, focusOnOpen, dot: !open && isNews(mark, seen), setOpen, saw };
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
      class="btn clog tip-below"
      // The label hides under 1100 px (changes.css): the tooltip names the icon there. The name is
      // given outright, since a tooltip's text would otherwise be read as part of it.
      data-tip="Change Log"
      aria-label={log.dot ? "Change Log (new entries)" : "Change Log"}
      aria-expanded={log.open}
      aria-controls={log.open ? "changelog" : undefined}
      onClick={() => log.setOpen(!log.open)}
    >
      <HistoryIcon />
      <span class="clabel">Change Log</span>
      {log.dot && <span class="cdot" aria-hidden="true" />}
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
      <span class="ltext" dir="auto">
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
  /** Puts `next` on show. When it's the whole log, its newest line is seen, whatever the page's head says yet. */
  const apply = (next: LogView) => {
    setView(next);
    setWaiting(null);
    if (filterRef.current === "all" && next.entries[0]) log.saw(`${next.entries[0].id}@${next.entries[0].at}`);
  };
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
      else apply(next);
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

  // Under the header, whatever its height. Written straight to the element, not kept as state: the
  // header scrolls with the page, and a render per scroll event would trail it by a frame (fix round 1, I2).
  useLayoutEffect(() => {
    const el = header.current;
    if (!el) return;
    const place = () => {
      if (root.current) root.current.style.top = `${Math.max(0, Math.round(el.getBoundingClientRect().bottom))}px`;
    };
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

  // With the commit, so a key pressed straight after opening already lands in the input.
  useLayoutEffect(() => {
    if (log.focusOnOpen) input.current?.focus();
  }, []);

  const close = () => {
    log.setOpen(false);
    buttonRef.current?.focus();
  };
  // R13: Esc closes it when the key comes from inside it, from its button or from the page itself.
  // Bound with the commit, so an Esc pressed straight after opening is never missed.
  useLayoutEffect(() => {
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
      // A line the filter on show leaves out would just vanish: say where it went (fix round 1, M1).
      if (!filterShows(filter, stage)) {
        const label = AREA_LABELS[stage];
        toast(`Added under ${label}. Choose All${FILTERS.some(([f]) => f === stage) ? ` or ${label}` : ""} to see it.`);
      }
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
    apply(waiting);
    if (list.current) list.current.scrollTop = 0;
    // The pill goes; focus moves to the newest line (or, when that line goes nowhere, the list)
    // rather than being lost, and never scrolls the list away from the top.
    requestAnimationFrame(() => {
      const first = list.current?.querySelector<HTMLElement>(".lrow");
      (first instanceof HTMLButtonElement ? first : list.current)?.focus({ preventScroll: true });
    });
  };
  const onScroll = () => {
    if (waiting && !reading()) apply(waiting);
  };
  const go = (to: JumpTarget) => {
    onJump(to);
    // R18: full width covers the page, so it closes. Focus goes back to its button rather than
    // falling to the page; a lane row the jump opens takes it a frame later (fix round 1, M2).
    if (window.innerWidth < 560) {
      log.setOpen(false);
      buttonRef.current?.focus();
    }
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
    return groupByDay(view.entries, new Date()).map((g) => (
      <div class="dgroup" key={g.key}>
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
      onKeyDown={(e) => {
        if (ownKey(e)) e.stopPropagation();
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
