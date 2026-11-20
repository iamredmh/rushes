// §22.8, §27 5.7: the notes panel's Activity tab, the Change Log. Newest first by day and live, with the "add a line" box,
// the filter (one menu, kept for the session) and Export as Markdown. What the drawer was, in the panel.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { api } from "../../api.js";
import {
  AREA_LABELS, BY_UI, FILTERS, clock, filterShows, footText, groupByDay, isFilter, jumpOf, localDate, newCount, ownKey, problemText, recall, remember, rowName, storageKey,
  type Filter, type JumpTarget, type KeyStore,
} from "../../changelog.js";
import { Icon } from "../Icon.js";
import type { LogHead, LogLine, LogView, Note, Project, Stage } from "../../types.js";
import { onFilm } from "../../lib.js";
import type { ChangeLogState } from "../ChangeLog.js";
import { AttentionRow } from "./AttentionRow.js";

/** How many lines the list loads (R16): the footer says when there are more. */
const LIMIT = 1000;
/** Scrolled further than this counts as reading: new lines wait behind the pill (§22.8). */
const READING_PX = 40;

/**
 * The last list loaded, per project and filter, with the log head it was loaded at. Every view mounts its own notes panel,
 * so switching view remounts the list: it shows this at once, and asks the server again only when the head has moved.
 */
const loaded = new Map<string, { head: string; view: LogView }>();
const headKey = (h: LogHead | null | undefined) => `${h?.rev ?? ""}:${h?.mark ?? ""}`;

const session = (): KeyStore | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

export interface ActivityListProps {
  log: ChangeLogState;
  projectId: string;
  head: LogHead | null | undefined;
  project: Pick<Project, "videos" | "lanes">;
  /** The tab on screen: a line added here is about it (R15). */
  stage: Stage | "assets";
  toast(message: string): void;
  onJump(to: JumpTarget): void;
  /** §30: the film on screen: Activity shows its lines and the project's, never another film's. Null: every line. */
  film: string | null;
  /** Every note in the project, to tell the film of an older line that names notes (lineFilms). */
  notes: readonly Pick<Note, "id" | "video">[];
  /** §28: the agent's live strip, shown above the day groups (LiveStrip). */
  live?: ComponentChildren;
  /** Esc from inside the list: the panel takes focus back to its Activity tab. */
  onEscape(): void;
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

export function ActivityList({ log, projectId, head, project, stage, film, notes, toast, onJump, live, onEscape }: ActivityListProps) {
  const [filter, setFilter] = useState<Filter>(() => {
    const saved = recall(session(), storageKey(projectId, "log-filter"));
    return isFilter(saved) ? saved : "all";
  });
  // §31.5: with several films, the list is the film's (the server leaves out other films' lines), and so is its cache.
  const scoped = film !== null && project.videos.length > 1 ? film : null;
  const cacheKey = (f: Filter) => `${projectId}\n${f}\n${scoped ?? ""}`;
  const [view, setView] = useState<LogView | null>(() => loaded.get(cacheKey(filter))?.view ?? null);
  const [waiting, setWaiting] = useState<LogView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const headNow = useRef(head);
  headNow.current = head;
  const [text, setText] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
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
    const asked = filterRef.current;
    const at = headKey(headNow.current);
    if (asked !== "all") q.set("area", asked);
    if (scoped) q.set("video", scoped);
    try {
      const next = await api.get<LogView>(`/api/log?${q}`);
      loaded.set(cacheKey(asked), { head: at, view: next });
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
  // A new filter starts at the top. Mounted again on a list already loaded at this head (a switch of view), it is shown
  // as it was, with no fetch.
  const mounted = useRef(false);
  useEffect(() => {
    const first = !mounted.current;
    mounted.current = true;
    const kept = loaded.get(cacheKey(filter));
    if (first && kept && kept.head === headKey(head)) {
      apply(kept.view);
      return;
    }
    if (list.current) list.current.scrollTop = 0;
    setWaiting(null);
    void load(true);
  }, [filter, scoped]);
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

  // With the commit, so a key pressed straight after choosing the tab already lands in the input.
  useLayoutEffect(() => {
    if (!log.focusOnOpen) return;
    input.current?.focus();
    log.focused();
  }, []);

  const add = async () => {
    const line = text.trim();
    if (!line) return;
    try {
      // §31.5: a line added on a film is that film's.
      await api.post("/api/log", { text: line, area: stage, ...(scoped ? { video: scoped } : {}) });
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
  // The rows below are memoised, so they call the page's newest jump through a ref.
  const goRef = useRef(onJump);
  goRef.current = onJump;
  const goLatest = useRef((to: JumpTarget) => goRef.current(to)).current;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const toastLatest = useRef((message: string) => toastRef.current(message)).current;
  const exportMd = async () => {
    try {
      const r = await api.post<{ path: string }>("/api/exports/change-log", {});
      toast(`Saved to ${r.path}`);
    } catch (e) {
      toast(problemText("export", e));
    }
  };

  // The rows are built once per fetched view (and when the project or the day changes), not on
  // every render of the page around them: a thousand of them is the most the list shows (R16).
  const today = localDate(new Date());
  // §30: this film's lines and the project's.
  const onScreen = useMemo(() => (view ? view.entries.filter((e) => onFilm(e, film, project, notes)) : []), [view, film, project, notes]);
  const rows = useMemo(() => {
    if (!view) return null;
    return groupByDay(onScreen, new Date()).map((g) => (
      <div class="dgroup" key={g.key}>
        <h3 class="dday">{g.heading}</h3>
        <ul>
          {g.entries.map((e) => (
            <li key={e.id}>
              {e.kind === "attention" && !e.resolved ? <AttentionRow entry={e} toast={toastLatest} /> : <Row entry={e} to={jumpOf(e, project)} onGo={goLatest} />}
            </li>
          ))}
        </ul>
      </div>
    ));
  }, [view, onScreen, project, today]);

  const fresh = view && waiting ? newCount(view.entries, waiting.entries) : 0;
  const nothing = view !== null && view.total === 0 && view.undated.length === 0;
  const nothingHere = view !== null && !nothing && onScreen.length === 0 && view.undated.length === 0;
  return (
    <div
      id="changelog"
      class="activity"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          e.stopPropagation();
          onEscape();
          return;
        }
        if (ownKey(e)) e.stopPropagation();
      }}
    >
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
      {/* Red, round 2: one menu, not two lines of chips. */}
      <div class="dshow">
        <span class="onwrap">
          <select class="sel" aria-label="Show" value={filter} onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (isFilter(v)) choose(v);
          }}>
            {FILTERS.map(([f, label]) => <option key={f} value={f}>{label}</option>)}
          </select>
          <Icon name="chev" />
        </span>
      </div>
      {/* The pill sits over the list, outside the scroller, so showing it never moves a line (§22.8). */}
      <div class="dwrap">
        {fresh > 0 && <button type="button" class="dpill" onClick={showWaiting}>{fresh} new</button>}
        <div class="dlist" ref={list} tabIndex={0} role="group" aria-label="Entries" onScroll={onScroll}>
          {live}
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
        {/* §30: the count is this film's lines (an older page beyond the newest LIMIT can't be told apart, so it is left out). */}
        <span>{view ? footText(onScreen.length === view.entries.length ? view : { entries: onScreen, earlier: 0, dropped: view.dropped }) : ""}</span>
        <button type="button" class="btn" onClick={() => void exportMd()}>Export as Markdown</button>
      </div>
    </div>
  );
}
