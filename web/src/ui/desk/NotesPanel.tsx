// §27, 5.7: the notes panel, the right-hand column of Review and Plan. Two tabs, Notes (the list, its filter and the note
// box with its target line) and Activity (the Change Log), and at its foot Send, with what is waiting. It is as tall as
// the work area, 300 px wide until its divider is dragged (remembered per browser), and `\` hides or shows it; under
// 1100 px it is a drawer over the work area. One component, mounted by every view that has notes: what they share (the
// tab chosen, Activity, Send, whether it is shown and how wide) comes from the desk through PanelContext.
import { createContext, type RefObject } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import type { ChangeLogState } from "../ChangeLog.js";
import { Icon } from "../Icon.js";
import { Notes, type NotesProps } from "../Notes.js";
import { ActivityList, type ActivityListProps } from "./ActivityList.js";

/** The panel's width: 300 px until dragged, kept between these. */
export const PANEL_WIDTH = 300;
export const PANEL_MIN = 240;
export const PANEL_MAX = 560;
/** Below this the panel is a drawer over the work area. */
export const PANEL_DRAWER_BELOW = 1100;

export interface PanelShared {
  log: ChangeLogState;
  activity: Omit<ActivityListProps, "log" | "onEscape">;
  /** What Send sends that is still waiting, and Send itself. */
  send: { count: number; onSend(): void };
  /** On screen: not hidden (wide), or the drawer open (narrow). */
  shown: boolean;
  /** Under 1100 px: the panel is a drawer. */
  narrow: boolean;
  setShown(shown: boolean): void;
  width: number;
  /** A new width while dragging; `keep` saves it for this browser. */
  setWidth(width: number, keep: boolean): void;
  /** Send is to be brought into view and given focus (the status bar's "send N notes"), by whichever panel is mounted. */
  reveal: boolean;
  onRevealed(): void;
}

export const PanelContext = createContext<PanelShared | null>(null);

const WIDTH_KEY = "rushes:notes-width";
const HIDDEN_KEY = "rushes:notes-hidden";

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function keep(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage refused (a private window): the setting holds for this visit only.
  }
}
const narrowQuery = () => (typeof matchMedia === "function" ? matchMedia(`(max-width: ${PANEL_DRAWER_BELOW - 1}px)`) : null);

/**
 * The panel's place on the desk: its width and whether it is hidden, both remembered per browser; under 1100 px, whether
 * the drawer is open (closed until asked for, and not remembered).
 */
export function usePanelPlace() {
  const [width, setWidthState] = useState(() => {
    const n = Number(recall(WIDTH_KEY));
    return recall(WIDTH_KEY) !== null && Number.isFinite(n) ? Math.min(PANEL_MAX, Math.max(PANEL_MIN, n)) : PANEL_WIDTH;
  });
  const [hidden, setHidden] = useState(() => recall(HIDDEN_KEY) === "1");
  const [drawer, setDrawer] = useState(false);
  const [narrow, setNarrow] = useState(() => narrowQuery()?.matches ?? false);
  useEffect(() => {
    const q = narrowQuery();
    if (!q) return;
    const on = () => setNarrow(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  const shown = narrow ? drawer : !hidden;
  const setShown = (to: boolean) => {
    if (narrow) setDrawer(to);
    else {
      setHidden(!to);
      keep(HIDDEN_KEY, to ? null : "1");
    }
  };
  const setWidth = (w: number, save: boolean) => {
    setWidthState(w);
    if (save) keep(WIDTH_KEY, w === PANEL_WIDTH ? null : String(w));
  };
  return { width, setWidth, narrow, shown, setShown, toggle: () => setShown(!shown) };
}

/** The top bar's button that hides and shows the panel (opens and closes the drawer under 1100 px). */
const HIDE = "Hide the notes panel · \\";

export function PanelToggle({ shown, onToggle, buttonRef }: { shown: boolean; onToggle(): void; buttonRef?: RefObject<HTMLButtonElement> }) {
  const name = shown ? "Hide the notes panel · \\" : "Show the notes panel · \\";
  return (
    <button ref={buttonRef} type="button" class="ibtn ntoggle" aria-label={name} data-tip={name} aria-pressed={shown} onClick={onToggle}>
      <Icon name="note" />
    </button>
  );
}

export type NotesPanelProps = NotesProps;

export function NotesPanel(props: NotesPanelProps) {
  const desk = useContext(PanelContext);
  const notesTab = useRef<HTMLButtonElement>(null);
  const activityTab = useRef<HTMLButtonElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);
  const drag = useRef<{ right: number } | null>(null);
  // The status bar's "send N notes" brings Send into view and gives it focus, once the panel it opened is on screen.
  useEffect(() => {
    if (!desk?.reveal || !desk.shown) return;
    const el = sendRef.current;
    desk.onRevealed();
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.focus();
  }, [desk?.reveal, desk?.shown]);

  if (!desk) return <Notes {...props} />;
  const { log, activity, send, shown, narrow } = desk;
  const tab = log.open ? "activity" : "notes";
  const todo = props.notes.filter((n) => n.status === "todo").length;
  const choose = (to: "notes" | "activity", focusList = true) => {
    if ((to === "activity") !== log.open) log.setOpen(to === "activity", focusList);
  };
  // A radio-like tablist: the arrows move between the two tabs.
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const to = tab === "notes" ? "activity" : "notes";
    choose(to, false);
    (to === "notes" ? notesTab : activityTab).current?.focus();
  };
  const widthAt = (clientX: number) => {
    const d = drag.current;
    if (!d) return null;
    const w = Math.round(Math.min(PANEL_MAX, Math.max(PANEL_MIN, d.right - clientX)));
    desk.setWidth(w, false);
    return w;
  };

  return (
    <aside class={`npanel${narrow ? " drawer" : ""}`} ref={root} aria-label="Notes panel" hidden={!shown}>
      {!narrow && (
        <div
          class="nresize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the notes panel"
          aria-valuemin={PANEL_MIN}
          aria-valuemax={PANEL_MAX}
          aria-valuenow={desk.width}
          tabIndex={0}
          onPointerDown={(e) => {
            if (e.button !== 0 || !root.current) return;
            drag.current = { right: root.current.getBoundingClientRect().right };
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => widthAt(e.clientX)}
          onPointerUp={(e) => {
            const w = widthAt(e.clientX);
            drag.current = null;
            if (w !== null) desk.setWidth(w, true);
          }}
          onDblClick={() => desk.setWidth(PANEL_WIDTH, true)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            desk.setWidth(Math.min(PANEL_MAX, Math.max(PANEL_MIN, desk.width + (e.key === "ArrowLeft" ? 16 : -16))), true);
          }}
        />
      )}
      <div class="ntabs">
        <div class="ntablist" role="tablist" aria-label="Notes panel">
          <button
            ref={notesTab}
            type="button"
            role="tab"
            id="ntab-notes"
            class="ntab"
            aria-selected={tab === "notes"}
            aria-controls="npanel-notes"
            tabIndex={tab === "notes" ? 0 : -1}
            onClick={() => choose("notes")}
            onKeyDown={onTabKey}
          >
            Notes{todo > 0 && <span class="n">{todo}</span>}
          </button>
          <button
            ref={activityTab}
            type="button"
            role="tab"
            id="ntab-activity"
            class="ntab"
            aria-selected={tab === "activity"}
            aria-controls="npanel-activity"
            aria-label={log.dot ? "Activity (new entries)" : "Activity"}
            tabIndex={tab === "activity" ? 0 : -1}
            onClick={() => choose("activity")}
            onKeyDown={onTabKey}
          >
            Activity{log.dot && <span class="cdot" aria-hidden="true" />}
          </button>
        </div>
        <span class="sp" />
        {narrow && (
          <button type="button" class="ibtn" aria-label={HIDE} data-tip={HIDE} onClick={() => desk.setShown(false)}>
            <Icon name="x" />
          </button>
        )}
      </div>
      {/* Hidden, never unmounted, while Activity shows: a half-typed note stays where it was. */}
      <div class="ntabpanel" role="tabpanel" id="npanel-notes" aria-labelledby="ntab-notes" hidden={tab !== "notes"}>
        <Notes {...props} />
      </div>
      {tab === "activity" && (
        <div class="ntabpanel" role="tabpanel" id="npanel-activity" aria-label="Activity">
          <ActivityList {...activity} log={log} onEscape={() => activityTab.current?.focus()} />
        </div>
      )}
      {send.count > 0 && (
        <div class="nfoot">
          <button ref={sendRef} type="button" class="btn primary sendbtn" aria-label={`Send ${send.count}`} data-tip="Every tab's open notes, on every film" onClick={send.onSend}>
            Send<span class="count">{send.count}</span>
          </button>
        </div>
      )}
    </aside>
  );
}
