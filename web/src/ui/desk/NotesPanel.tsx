// §27, 5.7: the notes panel, the right-hand column of Review and Plan. Two tabs, Notes (the list, its filter and the note
// box with its target line) and Activity (the Change Log), and at its foot Send, with what is waiting. It is as tall as
// the work area, 360 px wide until its divider is dragged (remembered per browser), and `\` hides or shows it; under
// 1100 px it is a drawer over the work area. One component, mounted by every view that has notes: what they share (the
// tab chosen, Activity, Send, whether it is shown and how wide) comes from the desk through PanelContext. §28: above Send,
// the Send to AI row (AgentRow); under it, what Send does now (footLine). Under the tab row, on every tab, the agent's
// pending permission asks (AskCards).
import { createContext, type RefObject } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { footLine, revealText } from "../../agent.js";
import { AgentRow, type AgentPanel } from "../agent/AgentRow.js";
import { AskCards } from "../agent/AskCard.js";
import { LiveStrip } from "../agent/LiveStrip.js";
import type { ChangeLogState } from "../ChangeLog.js";
import { Icon } from "../Icon.js";
import { type Filter, NoteFilterMenu, Notes, type NotesProps } from "../Notes.js";
import { ActivityList, type ActivityListProps } from "./ActivityList.js";
import { ProxiesTab, type ProxiesTabProps } from "./ProxiesTab.js";

/** The panel's width: 360 px until dragged (Red, 16 Nov: room for the notes), kept between these. */
export const PANEL_WIDTH = 360;
export const PANEL_MIN = 240;
export const PANEL_MAX = 560;
/** Below this the panel is a drawer over the work area. */
export const PANEL_DRAWER_BELOW = 1100;

export interface PanelShared {
  log: ChangeLogState;
  activity: Omit<ActivityListProps, "log" | "onEscape">;
  /** What Send sends that is still waiting, and Send itself. `always`: shown even with nothing waiting (on its own Brief or
   *  Storyboard page, Send always carries that page's line). */
  send: {
    count: number;
    always?: boolean;
    onSend(): void;
    /** I3: notes Send filed that never reached the agent (refused while Send to AI was on), and §35.7 notes the agent's
     *  turn ended without answering: the row's line, its colour (to do, or sent), and Send again. */
    again?: { count: number; text: string; tone: "todo" | "sent"; onSendAgain(): void } | null;
  };
  /** §35.7: by batch id, the status line of a batch the agent's turn ended without answering ("Not finished: …"). */
  unfinished?: Readonly<Record<string, string>>;
  /** §28: the Send to AI row, from the agent's status; null before the first answer and from a server without Send to AI. */
  agent: AgentPanel | null;
  /** §36.7: the Proxies tab, after Activity: whether it is the tab on show (over Notes and Activity), and what it shows. */
  proxies?: { open: boolean; setOpen(open: boolean): void; view: ProxiesTabProps };
  /** On screen: not hidden (wide), or the drawer open (narrow). */
  shown: boolean;
  /** Under 1100 px: the panel is a drawer. */
  narrow: boolean;
  setShown(shown: boolean): void;
  width: number;
  /** A new width while dragging; `keep` saves it for this browser. */
  setWidth(width: number, keep: boolean): void;
  /** Send is to be brought into view and given focus (the status bar's Send, from a page with no panel), by whichever
   *  panel is mounted. */
  reveal: boolean;
  onRevealed(): void;
  /** Shows the panel on its Notes tab (opening the drawer under 1100 px), then runs `then` once it is on screen. */
  revealNotes(then: () => void): void;
}

export const PanelContext = createContext<PanelShared | null>(null);

/**
 * Focuses a view's note box (N, the Note tool): the panel is shown on its Notes tab first when it is hidden, the drawer
 * is closed or Activity is on show, since a box inside a hidden panel cannot take focus.
 */
export function useNoteBox(box: RefObject<HTMLTextAreaElement>): () => void {
  const desk = useContext(PanelContext);
  return () => {
    if (desk && (!desk.shown || desk.log.open || desk.proxies?.open)) desk.revealNotes(() => box.current?.focus());
    else box.current?.focus();
  };
}

/** What a menu, a dialog or a popover that an Escape closes looks like on the page. */
const CLOSES_ON_ESCAPE = '[role="dialog"], [role="menu"], [role="listbox"], .fmtpop.open';

/**
 * Whether an Escape pressed on the desk itself is free to let go of the note's target (§27, 5.7): not when something
 * else takes it (a field, or a menu, dialog or popover it closes; one Escape does one thing), and not from a control in
 * the notes panel, whose own Escape is the note box's.
 */
export function escapeIsFree(e: KeyboardEvent): boolean {
  if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(CLOSES_ON_ESCAPE) !== null) return false;
  const from = e.target instanceof Element ? e.target : null;
  return !from?.closest(".npanel");
}

const WIDTH_KEY = "rushes:notes-width";
const ALL_TABS_KEY = "rushes:notes-all-tabs";
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

/** §35.3: the sound tabs' "All tabs" switch, off by default and remembered per browser. */
export function useAllTabs(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => recall(ALL_TABS_KEY) === "1");
  return [on, (to: boolean) => {
    setOn(to);
    keep(ALL_TABS_KEY, to ? "1" : null);
  }];
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
  const proxiesTab = useRef<HTMLButtonElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLElement>(null);
  const drag = useRef<{ right: number } | null>(null);
  // The notes' filter, in the tab row beside Notes and Activity (Red, round 2: the list gets the line it had).
  const [noteFilter, setNoteFilter] = useState<Filter>("all");
  // The status bar's Send brings Send into view and gives it focus, once the panel it opened is on screen.
  useEffect(() => {
    if (!desk?.reveal || !desk.shown) return;
    const el = sendRef.current;
    desk.onRevealed();
    if (!el) return;
    el.scrollIntoView({ block: "nearest" });
    el.focus();
  }, [desk?.reveal, desk?.shown]);
  if (!desk) return <Notes {...props} />;
  const { log, activity, send, shown, narrow, agent } = desk;
  // Send shows while something waits. The Send to AI row and its who-line stay whenever the desk knows the agent's
  // status, so the switch never vanishes under the pointer and Set up is there before the first note.
  const sendShown = send.count > 0 || !!send.always;
  // I3: notes that read "With your agent" but never reached it get their own way out, so they are never stranded.
  const again = send.again && send.again.count > 0 ? send.again : null;
  const proxies = desk.proxies;
  type Tab = "notes" | "activity" | "proxies";
  const tab: Tab = proxies?.open ? "proxies" : log.open ? "activity" : "notes";
  const todo = props.todoCount ?? props.notes.filter((n) => n.status === "todo").length;
  const choose = (to: Tab, focusList = true) => {
    if (to === "proxies") return proxies?.setOpen(true);
    if (proxies?.open) proxies.setOpen(false);
    if ((to === "activity") !== log.open) log.setOpen(to === "activity", focusList);
  };
  // A radio-like tablist: the arrows move between the tabs.
  const order: Tab[] = proxies ? ["notes", "activity", "proxies"] : ["notes", "activity"];
  const refs: Record<Tab, typeof notesTab> = { notes: notesTab, activity: activityTab, proxies: proxiesTab };
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    e.stopPropagation();
    const i = order.indexOf(tab);
    const to = order[(i + (e.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    choose(to, false);
    refs[to].current?.focus();
  };
  // A strip line that names a note: back to the Notes tab, the card in view.
  const showNote = (id: string) => {
    choose("notes", false);
    setNoteFilter("all");
    requestAnimationFrame(() => {
      const card = root.current?.querySelector<HTMLElement>(`[data-note="${CSS.escape(id)}"]`);
      if (!card) return;
      card.scrollIntoView({ block: "nearest" });
      card.tabIndex = -1;
      card.focus({ preventScroll: true });
    });
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
            aria-label={log.alert ? "Activity (needs your attention)" : log.dot ? "Activity (new entries)" : "Activity"}
            tabIndex={tab === "activity" ? 0 : -1}
            onClick={() => choose("activity")}
            onKeyDown={onTabKey}
          >
            Activity{(log.dot || log.alert) && <span class={`cdot${log.alert ? " alert" : ""}`} aria-hidden="true" />}
          </button>
          {proxies && (
            <button
              ref={proxiesTab}
              type="button"
              role="tab"
              id="ntab-proxies"
              class="ntab"
              aria-selected={tab === "proxies"}
              aria-controls="npanel-proxies"
              tabIndex={tab === "proxies" ? 0 : -1}
              onClick={() => choose("proxies")}
              onKeyDown={onTabKey}
            >
              Proxies
            </button>
          )}
        </div>
        <span class="sp" />
        {tab === "notes" && props.allTabs && (
          <button
            type="button"
            class={`ntabs-all${props.allTabs.on ? " on" : ""}`}
            role="switch"
            aria-checked={props.allTabs.on}
            data-tip="Show this film's notes from every tab"
            onClick={() => props.allTabs!.onChange(!props.allTabs!.on)}
          >
            All tabs
          </button>
        )}
        {tab === "notes" && <NoteFilterMenu filter={noteFilter} onChange={setNoteFilter} />}
        {narrow && (
          <button type="button" class="ibtn" aria-label={HIDE} data-tip={HIDE} onClick={() => desk.setShown(false)}>
            <Icon name="x" />
          </button>
        )}
      </div>
      {agent && <AskCards {...agent} />}
      {/* Hidden, never unmounted, while Activity shows: a half-typed note stays where it was. */}
      <div class="ntabpanel" role="tabpanel" id="npanel-notes" aria-labelledby="ntab-notes" hidden={tab !== "notes"}>
        <Notes {...props} filter={noteFilter} agent={{ status: agent?.status ?? null, onJump: activity.onJump, unfinished: desk.unfinished }} />
      </div>
      {tab === "proxies" && proxies && (
        <div class="ntabpanel" role="tabpanel" id="npanel-proxies" aria-labelledby="ntab-proxies">
          <ProxiesTab {...proxies.view} />
        </div>
      )}
      {tab === "activity" && (
        <div class="ntabpanel" role="tabpanel" id="npanel-activity" aria-label="Activity">
          <ActivityList {...activity} log={log} live={<LiveStrip status={agent?.status ?? null} notes={props.notes} onNote={showNote} elsewhere={(id) => {
            const film = activity.film;
            const v = activity.notes.find((n) => n.id === id)?.video;
            return film !== null && activity.project.videos.length > 1 && !!v && v !== film;
          }} />} onEscape={() => activityTab.current?.focus()} />
        </div>
      )}
      {(sendShown || agent || again) && (
        <div class={`nfoot${agent ? " agentfoot" : ""}`}>
          {agent && <AgentRow {...agent} />}
          {again && (
            <div class={`sendagain ${again.tone}`} role="status">
              <p class="sendagain-why" dir="auto">{revealText(again.text)}</p>
              <button type="button" class={`btn${sendShown ? "" : " primary"} sendbtn`} aria-label={`Send again ${again.count}`} data-tip="Hand these notes to the agent again" onClick={again.onSendAgain}>
                Send again<span class="count">{again.count}</span>
              </button>
            </div>
          )}
          {sendShown && (
            <button ref={sendRef} type="button" class="btn primary sendbtn" aria-label={send.count > 0 ? `Send ${send.count}` : "Send"} data-tip="Notes and edits on this film not sent yet, from every tab" onClick={send.onSend}>
              Send{send.count > 0 && <span class="count">{send.count}</span>}
            </button>
          )}
          {agent && <p class="awho">{footLine(agent.status)}</p>}
        </div>
      )}
    </aside>
  );
}
