// §24, §27: what the three Plan pages (Brief, Script, Storyboard) share. The switch at the top of the Plan workspace, the
// field every editable text sits in, the "Edited by you" mark with the baseline struck through beneath it, and the status
// line at each page's foot. One of each, used by all three pages.
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { wordDiff, type PlanPage } from "../lib.js";
import { Icon } from "./Icon.js";

/** Run `fn` once input has paused for `ms`; flush() runs it now. A pending run is flushed, not dropped, on unmount. */
export function useDebounced(fn: () => void, ms: number) {
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(
    () => () => {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      latest.current();
    },
    [],
  );
  return {
    schedule() {
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        latest.current();
      }, ms);
    },
    flush() {
      if (timer.current === undefined) return;
      clearTimeout(timer.current);
      timer.current = undefined;
      latest.current();
    },
  };
}

export interface PlanTabRow {
  page: PlanPage;
  name: string;
  icon: string;
  /** The page has something in it; a page that doesn't is still listed, and opens its "nothing here yet" page. */
  unlocked: boolean;
  /** What a locked page's tooltip asks your agent for. */
  ask: string;
  /** Brief approved, every script line approved, or every shot approved. */
  approved: boolean;
  /** Edits on this page that have not been sent yet. */
  open: number;
}

/** The Plan page on show is the switch's tab panel: its id, and each tab's. */
export const PLAN_PANEL_ID = "plan-page";
export const planTabId = (page: PlanPage) => `ptab-${page}`;

/**
 * The Plan workspace's three-part switch. Left and right (and Home, End) move along it without opening anything, the way a
 * tab list does; Enter or a click opens the page. The keys it handles stop here, so nothing behind it hears them.
 */
export function PlanSwitch({ rows, selected, onPick }: { rows: PlanTabRow[]; selected: PlanPage | null; onPick(page: PlanPage): void }) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(0, rows.findIndex((r) => r.page === selected));
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const from = tabs.current.findIndex((t) => t === document.activeElement);
    if (from < 0) return;
    const to = e.key === "ArrowRight" ? Math.min(rows.length - 1, from + 1) : e.key === "ArrowLeft" ? Math.max(0, from - 1) : e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    tabs.current[to]?.focus();
  };
  return (
    <nav class="rtabs ptabs" role="tablist" aria-label="Plan" onKeyDown={onKey}>
      {rows.map((r, i) => (
        <button
          key={r.page}
          ref={(el) => {
            tabs.current[i] = el;
          }}
          type="button"
          class="tab"
          role="tab"
          id={planTabId(r.page)}
          aria-controls={PLAN_PANEL_ID}
          aria-selected={selected === r.page}
          tabIndex={i === at ? 0 : -1}
          data-locked={r.unlocked ? undefined : "true"}
          data-tip={r.unlocked ? undefined : `Locked: ask your agent for ${r.ask}`}
          onClick={() => onPick(r.page)}
        >
          <Icon name={r.icon} />
          {r.name}
          {r.unlocked ? (
            <>
              {r.approved && (
                <>
                  <Icon name="check" class="pready" />
                  <span class="vh"> Approved</span>
                </>
              )}
              {r.open > 0 && <span class="dot" title={`${r.open} not sent`} />}
            </>
          ) : (
            <>
              <Icon name="lock" class="lk" />
              {/* Visually hidden, not aria-hidden: an enabled, clickable tab is announced as locked. */}
              <span class="vh"> Locked</span>
            </>
          )}
        </button>
      ))}
    </nav>
  );
}

/** Sets a field's height to its text's: as many lines as the text takes at the field's width now. */
function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 2}px`;
}

/**
 * A text you can edit on a Plan page: a field with a visible edge at rest, that grows with its text and never hides any.
 * It sizes again when its text changes and when its width does (a narrower window, the notes panel shown, the one-column
 * layout), since the same text then wraps onto a different number of lines.
 */
export function PlanField({ value, label, onInput, onBlur }: { value: string; label: string; onInput(text: string): void; onBlur(): void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (area.current) fitHeight(area.current);
  }, [value]);
  useEffect(() => {
    const el = area.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Only a change of width re-measures: setting the height is itself a resize, and must not start another.
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      ref={area}
      class="input pfield"
      rows={1}
      aria-label={label}
      value={value}
      onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)}
      onBlur={onBlur}
    />
  );
}

/** One wording an edit replaced: the agent's text, what it is now, and what it is when the row has more than one ("Direction"). */
export interface Baseline {
  label?: string;
  text: string;
  after: string;
}

/** §38.6: two wordings as one, removed words struck through in red and added words in green. */
export function Diff({ before, after }: { before: string; after: string }) {
  const runs = wordDiff(before, after);
  if (runs.length === 0) return <span class="diff dsame" data-before="">(none)</span>;
  // data-before: the agent's wording whole, for whoever needs it without the markup (the tests).
  return (
    <span class="diff" data-before={before}>
      {runs.map((r, i) =>
        r.kind === "same" ? <span key={i} class="dsame">{r.text}</span> : r.kind === "del" ? <del key={i} class="ddel">{r.text}</del> : <ins key={i} class="dins">{r.text}</ins>,
      )}
    </span>
  );
}

/** Under a row whose wording differs from the agent's: "Edited by you", what changed marked word by word, and the way back. */
export function EditedMark({ baseline, revertLabel, onRevert }: { baseline: Baseline[]; revertLabel: string; onRevert(): void }) {
  return (
    <div class="edited">
      <div class="ehead">
        <span class="etag">Edited by you</span>
        <button class="btn ghost ib" data-tip={revertLabel} aria-label={revertLabel} onClick={onRevert}>
          <Icon name="undo" />
        </button>
      </div>
      {baseline.map((b) => (
        <p key={b.label ?? "text"} class="was">
          {b.label && <span class="wl">{b.label}: </span>}
          <Diff before={b.text} after={b.after} />
        </p>
      ))}
    </div>
  );
}

/**
 * The line at a page's foot that counts what is approved and what is edited ("1 of 3 lines approved · 2 edited"), with the
 * page's own action beside it. `counts` is null while the page has nothing to count yet.
 */
export function PlanStatus({ counts, children }: { counts: { approved: string; edited: number } | null; children?: ComponentChildren }) {
  if (!counts && !children) return null;
  return (
    <div class="pfoot">
      {counts && (
        <p class="pstatus">
          {counts.approved} · {counts.edited} edited
        </p>
      )}
      {children}
    </div>
  );
}

/** "1 of 3 lines approved": how many of a page's items are approved, in words. */
export const approvedOf = (approved: number, total: number, noun: string): string => `${approved} of ${total} ${noun}${total === 1 ? "" : "s"} approved`;
