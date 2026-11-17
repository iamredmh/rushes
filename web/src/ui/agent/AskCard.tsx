// §28.4, 5.5: the agent's permission asks, as cards at the top of the notes panel on every tab. A card says who asks
// and what for, the exact command in mono (wrapped, never cut short), and offers Allow once, the server's own Always
// when it offers one, and No (askChoices). This is where the user decides whether a command runs on their machine:
// the choice posted is the button pressed, nothing else, and while it is on its way no other button can be pressed.
// A card leaves when the next status no longer lists its ask.
import { type MutableRef, useRef, useState } from "preact/hooks";
import { askChoices, askLead } from "../../agent.js";
import { api, ApiError } from "../../api.js";
import type { AgentStatus, AskChoice, PendingAsk } from "../../types.js";
import type { AgentPanel } from "./AgentRow.js";

type AskCardProps = { ask: PendingAsk; latest: MutableRef<AgentStatus> } & Pick<AgentPanel, "status" | "onStatus" | "toast">;

function AskCard({ ask, latest, status, onStatus, toast }: AskCardProps) {
  const [posting, setPosting] = useState(false);
  // A second press before the first has re-rendered the card is held here, not sent.
  const sent = useRef(false);
  const lead = askLead(status.agent);
  const answer = async (choice: AskChoice) => {
    if (sent.current) return;
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
    <section class="askcard" aria-label={ask.title ? `${lead} ${ask.title}` : lead} aria-busy={posting}>
      <p class="asklead">{lead}</p>
      {ask.title && <p class="asktitle">{ask.title}</p>}
      {ask.command && <code class="askcmd">{ask.command}</code>}
      <div class="askacts">
        {askChoices(ask).map((c) => (
          <button key={c.choice} type="button" class="btn" disabled={posting} onClick={() => void answer(c.choice)}>
            {c.label}
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
  // A live region that is always there, so a card arriving in it is read out.
  return (
    <div class="asks" aria-live="polite">
      {status.asks.map((a) => (
        <AskCard key={a.id} ask={a} latest={latest} status={status} onStatus={onStatus} toast={toast} />
      ))}
    </div>
  );
}
