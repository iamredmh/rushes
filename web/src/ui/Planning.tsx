// §24: Brief and Script live under one Planning tab. It is a tab with a menu: click it and the pages drop down,
// so planning, which is not a daily habit, costs one tab and the review stages stay where they were.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { PlanPage, Progress } from "../lib.js";
import { Icon } from "./Icon.js";

export interface PlanRow {
  page: PlanPage;
  name: string;
  icon: string;
  unlocked: boolean;
  /** A tick or a half mark while a plan is in progress; null when the row has no mark to show. */
  progress: Progress | null;
  /** What a locked row asks your agent for. */
  ask: string;
}

export interface PlanningTabProps {
  /** The planning page on screen, or null when another tab is. */
  selected: PlanPage | null;
  rows: PlanRow[];
  /** While a plan is in progress the tab carries one mark per page; otherwise just a dot when something is open. */
  marks: { brief: Progress; script: Progress; storyboard: Progress } | null;
  open: number;
  /** Neither page has anything in it yet. */
  locked: boolean;
  /** Brief, script and storyboard are all approved: the menu then says so, with the prompt to build. */
  ready: boolean;
  onCopyReady(): void;
  onPick(page: PlanPage): void;
}

export function PlanningTab({ selected, rows, marks, open, locked, ready, onCopyReady, onPick }: PlanningTabProps) {
  const [shown, setShown] = useState(false);
  const [active, setActive] = useState(0);
  const [at, setAt] = useState({ left: 0, top: 0 });
  const wrap = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const show = () => {
    const r = button.current?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, r.left), top: r.bottom });
    setActive(Math.max(0, rows.findIndex((x) => x.page === selected)));
    setShown(true);
  };
  const close = (focusButton: boolean) => {
    setShown(false);
    if (focusButton) button.current?.focus();
  };
  useLayoutEffect(() => {
    if (shown) items.current[active]?.focus();
  }, [shown, active]);
  // A click or focus anywhere else closes the menu.
  useEffect(() => {
    if (!shown) return;
    const away = (e: Event) => {
      if (!wrap.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("focusin", away, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("focusin", away, true);
    };
  }, [shown]);

  // The keys the menu handles stop here, so the digits and arrows don't also switch tabs or step frames behind it.
  const onMenuKey = (e: KeyboardEvent) => {
    if (e.key === "Tab") return close(false);
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // The menu is a column: left and right do nothing here, and must not reach Picture and step a frame behind it.
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const move = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : e.key === "Home" ? -rows.length : e.key === "End" ? rows.length : 0;
    if (move !== 0) {
      e.preventDefault();
      e.stopPropagation();
      setActive((a) => Math.min(rows.length - 1, Math.max(0, a + move)));
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key.length === 1) {
      // Printable keys stay in the menu: a digit doesn't switch tabs, and ? doesn't open the shortcuts, behind it.
      e.stopPropagation();
    }
  };

  const dot = (p: Progress) => <i class={`pm ${p}`} />;
  return (
    <span class="plan" ref={wrap}>
      <button
        ref={button}
        class="tab"
        role="tab"
        aria-selected={selected !== null}
        aria-haspopup="menu"
        aria-expanded={shown}
        data-locked={locked ? "true" : undefined}
        onClick={() => (shown ? close(false) : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !shown) {
            e.preventDefault();
            show();
          }
        }}
      >
        <Icon name="list" />
        Planning
        {marks ? (
          <span class="pmarks" title={ready ? "Ready to build" : "Brief, script and storyboard"}>
            {ready ? <Icon name="check" class="pready" /> : <>{dot(marks.brief)}{dot(marks.script)}{dot(marks.storyboard)}</>}
          </span>
        ) : locked ? (
          <Icon name="lock" class="lk" />
        ) : (
          open > 0 && <span class="dot" title={`${open} open`} />
        )}
        <Icon name="chev" class="chev" />
      </button>
      {shown && (
        <div class="planmenu" role="menu" aria-label="Planning" style={{ left: `${at.left}px`, top: `${at.top}px` }} onKeyDown={onMenuKey}>
          {rows.map((r, i) => (
            <button
              key={r.page}
              ref={(el) => {
                items.current[i] = el;
              }}
              role="menuitem"
              class={`planitem${r.page === selected ? " cur" : ""}`}
              data-locked={r.unlocked ? undefined : "true"}
              tabIndex={i === active ? 0 : -1}
              data-tip={r.unlocked ? undefined : `Locked: ask your agent for ${r.ask}`}
              onClick={() => {
                // Focus goes back to the Planning tab, not to nowhere, so the keyboard carries on from where it was.
                close(true);
                onPick(r.page);
              }}
            >
              <Icon name={r.icon} />
              <span>{r.name}</span>
              {r.unlocked ? r.progress === null ? null : r.progress === "ok" ? <Icon name="check" class="pi" /> : <i class={`pm ${r.progress}`} /> : <Icon name="lock" class="lk" />}
            </button>
          ))}
          {ready && (
            <div class="planready">
              <div class="rd">
                <Icon name="check" />
                Ready to build
              </div>
              <button
                role="menuitem"
                class="btn"
                tabIndex={-1}
                onClick={() => {
                  close(false);
                  onCopyReady();
                }}
              >
                <Icon name="copy" />
                Copy prompt for your agent
              </button>
            </div>
          )}
        </div>
      )}
    </span>
  );
}
