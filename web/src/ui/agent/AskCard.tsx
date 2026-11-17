// §28.4, 5.5: the agent's permission asks, as cards at the top of the notes panel on every tab. A card says who asks
// and what for, the exact command in mono (wrapped, never cut short), and offers Allow once, the server's own Always
// when it offers one, and No (askChoices). This is where the user decides whether a command runs on their machine:
// the choice posted is the button pressed, nothing else, and while it is on its way no other button can be pressed.
// A card leaves when the next status no longer lists its ask.
//
// Two guards keep what the user sees and presses honest (task 5 review):
// - A card takes presses only once it has stayed in place for ASK_ARM_MS (it has just arrived, or one above it was
//   answered and it slid up). Until then a press, by pointer or key, is dropped, so the second click of a double-click
//   never answers the card that moved under the pointer. Nothing changes on screen while it waits.
// - Characters that change how the command reads without being seen (bidi controls, zero widths, other invisibles) are
//   shown as their code, <U+202E>, in their own style; the command block is laid out left to right, isolated. Display
//   only: the server holds the real command and never takes it from the desk.
import { type MutableRef, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ASK_ARM_MS, askArmKey, askChoices, askLead, revealParts, revealText } from "../../agent.js";
import { api, ApiError } from "../../api.js";
import type { AgentStatus, AskChoice, PendingAsk } from "../../types.js";
import type { AgentPanel } from "./AgentRow.js";

type AskCardProps = { ask: PendingAsk; place: string; latest: MutableRef<AgentStatus> } & Pick<AgentPanel, "status" | "onStatus" | "toast">;

/**
 * True once the card has stayed at `place` for ASK_ARM_MS. Set back before the browser paints or handles another input
 * (a layout effect, in the same task as the change that moved the card), so a click already queued can't get through.
 */
function useArmed(place: string): { ready: MutableRef<boolean>; armed: boolean } {
  const ready = useRef(false);
  const [armed, setArmed] = useState(false);
  useLayoutEffect(() => {
    ready.current = false;
    setArmed(false);
    const t = setTimeout(() => {
      ready.current = true;
      setArmed(true);
    }, ASK_ARM_MS);
    return () => clearTimeout(t);
  }, [place]);
  return { ready, armed };
}

function AskCard({ ask, place, latest, status, onStatus, toast }: AskCardProps) {
  const [posting, setPosting] = useState(false);
  // A second press before the first has re-rendered the card is held here, not sent.
  const sent = useRef(false);
  const { ready, armed } = useArmed(place);
  const lead = askLead(status.agent);
  const title = revealText(ask.title);
  const answer = async (choice: AskChoice) => {
    if (sent.current || !ready.current) return;
    sent.current = true;
    setPosting(true);
    const before = latest.current;
    try {
      const r = await api.post<{ status: AgentStatus }>(`/api/agent/permission/${encodeURIComponent(ask.id)}`, { choice });
      // The answer's status is folded in only if no event came meanwhile. One that did is as new as it (the answer itself
      // sends one) or newer: the run may have gone on and finished, and this status would take the desk back.
      if (latest.current === before) onStatus(r.status);
    } catch (e) {
      // Already answered (another tab) or cancelled (Stop): the next status takes the card away; nothing to say.
      if (e instanceof ApiError && e.status === 404) return;
      sent.current = false;
      setPosting(false);
      toast((e as Error).message);
    }
  };
  return (
    <section class="askcard" aria-label={title ? `${lead} ${title}` : lead} aria-busy={posting} data-armed={armed ? "true" : "false"}>
      <p class="asklead">{lead}</p>
      {title && <p class="asktitle">{title}</p>}
      {ask.command && (
        <code class="askcmd">
          {revealParts(ask.command).map((p) => ("text" in p ? p.text : <span class="askhid">{p.hidden}</span>))}
        </code>
      )}
      <div class="askacts">
        {askChoices(ask).map((c) => (
          <button key={c.choice} type="button" class="btn" disabled={posting} onClick={() => void answer(c.choice)}>
            {revealText(c.label)}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Every pending ask, in the server's order, above the tab's own content. While none is pending the strip is empty and
 *  not drawn (agent.css), so the panel's layout is as it was. */
export function AskCards({ status, onStatus, toast }: AgentPanel) {
  const latest = useRef(status);
  latest.current = status;
  const ids = status.asks.map((a) => a.id);
  // A live region that is always there, so a card arriving in it is read out.
  return (
    <div class="asks" aria-live="polite">
      {status.asks.map((a, i) => (
        <AskCard key={a.id} ask={a} place={askArmKey(ids, i)} latest={latest} status={status} onStatus={onStatus} toast={toast} />
      ))}
    </div>
  );
}
