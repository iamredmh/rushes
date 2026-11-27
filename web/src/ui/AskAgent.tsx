// §38.7: a prompt for the agent, from a Plan page or a locked tab. With Send to AI on, the main button sends it to the
// user's agent (a request batch with no notes, through /api/agent/ask) and Copy sits beside it; with Send to AI off,
// Copy is the main button and a second one turns Send to AI on. A refused hand-over copies the prompt instead.
import { useContext, useState } from "preact/hooks";
import type { AgentId } from "../../../src/core/schema.js";
import { agentName } from "../agent.js";
import { api } from "../api.js";
import { copyShortcut } from "../lib.js";
import { PanelContext } from "./desk/NotesPanel.js";
import { Icon } from "./Icon.js";

async function copyText(text: string, toast: (m: string) => void, lead = "Prompt copied", refused?: () => string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(lead);
  } catch {
    toast(refused?.() ?? `Couldn't copy. Select the prompt and press ${copyShortcut(navigator.platform)}`);
  }
}

/**
 * `label` names the agent's turn in Activity ("the EU only brief"). `small` is for a line inside a card. `copyWords` is
 * Copy's words when it is the main button.
 */
export function AskAgent({ prompt, label, video = null, toast, small = false, copyWords = "Copy prompt for your agent", onCopyRefused }: { prompt: string; label: string; video?: string | null; toast(m: string): void; small?: boolean; copyWords?: string; /** The clipboard was refused: what to do instead (select the prompt), and what to say. */ onCopyRefused?(): string }) {
  const panel = useContext(PanelContext);
  const status = panel?.agent?.status ?? null;
  const on = !!status?.on && !!status.agent;
  const [sending, setSending] = useState(false);
  const send = async () => {
    if (sending) return;
    setSending(true);
    try {
      const r = await api.post<{ agent: { handedTo: AgentId | null; why?: string; starting?: boolean } }>("/api/agent/ask", { prompt, label, ...(video ? { video } : {}) });
      if (r.agent.handedTo) toast(`Sent to ${agentName(r.agent.handedTo)}${r.agent.starting ? ". It's starting up" : ""}`);
      else await copyText(prompt, toast, `${r.agent.why ?? "It couldn't be sent"}, so the prompt is copied instead`, onCopyRefused);
    } catch (e) {
      await copyText(prompt, toast, `Couldn't send it (${(e as Error).message}), so the prompt is copied instead`);
    } finally {
      setSending(false);
    }
  };
  const cls = small ? " sm" : "";
  return (
    <span class={`askagent${cls}`}>
      {on ? (
        <>
          <button class="btn primary" disabled={sending} onClick={() => void send()}>
            <Icon name="send" />
            Send to {agentName(status!.agent)}
          </button>
          <button class="btn ghost" onClick={() => void copyText(prompt, toast, "Prompt copied", onCopyRefused)}>
            <Icon name="copy" />
            Copy prompt
          </button>
        </>
      ) : (
        <>
          <button class={`btn${small ? "" : " primary"}`} onClick={() => void copyText(prompt, toast, "Prompt copied", onCopyRefused)}>
            <Icon name="copy" />
            {copyWords}
          </button>
          {panel?.agent && (
            <button
              class="btn ghost"
              onClick={() => (status?.asked ? panel.agent!.menu.current?.() : panel.agent!.onSetUp())}
            >
              <Icon name="send" />
              Turn on Send to AI
            </button>
          )}
        </>
      )}
    </span>
  );
}
