// §28, 5.2: the run's chip in the top bar, before the notes panel's toggle. It says what the agent is doing (chipText),
// opens Activity when clicked, and carries Stop while there is something to stop. It shows while a run goes and for ten
// minutes after one ends (plan 2, decision 2); a minute's tick lets an ended run's chip go on its own.
import { useEffect, useState } from "preact/hooks";
import { agentName, canStop, chipShows, chipText, chipTone, type NoteLite } from "../../agent.js";
import type { AgentStatus } from "../../types.js";
import { Icon } from "../Icon.js";

export interface AgentChipProps {
  /** Live.agent: null before the first answer, and from a server without Send to AI. */
  status: AgentStatus | null;
  /** The desk's notes, for "note 2 of 3". */
  notes: readonly NoteLite[];
  /** Opens the notes panel on Activity. */
  onOpen(): void;
  /** POST /api/agent/stop. */
  onStop(): void;
}

export function AgentChip({ status, notes, onOpen, onStop }: AgentChipProps) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!status || !chipShows(status, Date.now())) return null;
  const text = chipText(status, notes);
  if (text === null) return null;
  const tone = chipTone(status.phase);
  const stop = `Stop ${agentName(status.agent)}`;
  // A failed run's tooltip says why; otherwise it repeats the words, which a narrow bar cuts short. The name is set, so a
  // browser that reads the tooltip's generated text into it doesn't say the words twice.
  const why = status.phase === "failed" && status.error ? status.error : null;
  return (
    <div class={`agentchip ${tone}`}>
      <button type="button" class="achip" aria-label={text} aria-description={why ?? undefined} data-tip={why ?? text} onClick={onOpen}>
        {tone === "busy" ? <Icon name="spin" class="aspin" /> : <span class="adot" aria-hidden="true" />}
        <span class="atext">{text}</span>
      </button>
      {canStop(status.phase) && (
        <button type="button" class="ibtn astop" aria-label={stop} data-tip={stop} onClick={onStop}>
          <Icon name="stop" />
        </button>
      )}
    </div>
  );
}
