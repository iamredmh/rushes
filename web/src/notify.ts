// §28, Send to AI: the browser notification when the agent needs you and the page is out of sight (plan 2, task 5).
// A new ask notifies "<A> is waiting for you"; the run turning to a question notifies "<A> has a question". Each ask id,
// and each turn to a question, notifies at most once, and only while the page is out of sight (outOfSight). Leave to notify is never
// asked for here: only in the press that sends notes to an agent (sendFollow.askNotificationsOnce). Without it granted,
// nothing shows, and the chip and the ask cards still say what needs you.
import { useEffect, useRef } from "preact/hooks";
import { agentName } from "./agent.js";
import type { AgentPhase, AgentStatus } from "./types.js";

/** What the desk has already heard of: the asks pending at the last status, and its phase. */
export interface Heard { asks: ReadonlySet<string>; phase: AgentPhase | null }
export const NOTHING_HEARD: Heard = { asks: new Set(), phase: null };

/** A notification to show: its words, and a tag naming what it is about (an ask id, or "question"). */
export interface Notice { body: string; tag: string }

/**
 * The notices a status calls for, given what was heard before it, and what is heard now. An ask or a question that
 * arrives while the page is shown is heard there, so it never notifies later. Asks arriving together notify once. An
 * answered ask leaves the heard set, so a server restarted with its ids counting from one again still notifies.
 * No status (no Send to AI) changes nothing.
 */
export function notices(before: Heard, s: AgentStatus | null, hidden: boolean): { heard: Heard; notes: Notice[] } {
  if (!s) return { heard: before, notes: [] };
  const heard: Heard = { asks: new Set(s.asks.map((a) => a.id)), phase: s.phase };
  if (!hidden) return { heard, notes: [] };
  const notes: Notice[] = [];
  const fresh = s.asks.find((a) => !before.asks.has(a.id));
  if (fresh) notes.push({ body: `${agentName(s.agent)} is waiting for you`, tag: fresh.id });
  if (s.phase === "question" && before.phase !== "question") notes.push({ body: `${agentName(s.agent)} has a question`, tag: "question" });
  return { heard, notes };
}

/**
 * Whether the person can't be looking at the desk (I5): the page is hidden (a background tab, a minimised window), or it
 * is shown but has no focus, as when another app's window is in front of it. Safari reports a page covered by another
 * window as visible, so `hidden` alone would never notify there.
 */
export const outOfSight = (doc: Pick<Document, "hidden" | "hasFocus"> = document): boolean => doc.hidden || !doc.hasFocus();

/**
 * Shows the notice, if the browser has already granted leave. The tag carries the page's path, so two tabs on one
 * project show one notification, and two projects never replace each other's. Clicking it brings the desk forward.
 */
export function showNotice(n: Notice): void {
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const shown = new Notification("Rushes", { body: n.body, tag: `rushes:${location.pathname}:${n.tag}` });
    shown.onclick = () => {
      window.focus();
      shown.close();
    };
  } catch {
    // A browser that only notifies from a service worker throws here: the chip and the cards still say it.
  }
}

/** Notifies for each status the desk receives (Live.agent), as `notices` says. */
export function useAskNotify(s: AgentStatus | null): void {
  const heard = useRef<Heard>(NOTHING_HEARD);
  useEffect(() => {
    const r = notices(heard.current, s, outOfSight());
    heard.current = r.heard;
    for (const n of r.notes) showNotice(n);
  }, [s]);
}
