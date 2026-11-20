// §35.5: an Attention item in Activity. The agent raised it because it can't go on without the user outside Rushes (a
// sign-in, a missing key, a missing file). It reads as needing the user's focus, never as done: the alert icon and the
// alert colour. Clicking it goes back to the agent's conversation: on this computer a terminal opens resuming it;
// otherwise a small panel gives the command to copy and where to run it. Dismiss clears it. A cleared one is an
// ordinary line (ActivityList's Row).
import { useState } from "preact/hooks";
import { agentName } from "../../agent.js";
import { api } from "../../api.js";
import { clock } from "../../changelog.js";
import { hereKey } from "../../here.js";
import type { AgentId, LogLine } from "../../types.js";
import { Icon } from "../Icon.js";

/** What POST /api/attention/:id/open answers. */
export interface AttentionOpen {
  opened: boolean;
  local: boolean;
  host: string;
  folder: string;
  agent: AgentId | null;
  session: string | null;
  command: string | null;
}

/** The panel's words: where to run the command, or, with no conversation kept, where the work is. */
export function resumeWhere(r: Pick<AttentionOpen, "host" | "folder" | "command">): string {
  return r.command ? `Run this on ${r.host}, in ${r.folder}` : `No conversation is kept for this project yet. Open your agent on ${r.host}, in ${r.folder}`;
}

export function AttentionRow({ entry: e, toast }: { entry: LogLine; toast(message: string, ms?: number): void }) {
  const [panel, setPanel] = useState<AttentionOpen | null>(null);
  const [busy, setBusy] = useState(false);
  const time = clock(new Date(e.at));
  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const key = hereKey();
      const r = await api.post<AttentionOpen>(`/api/attention/${encodeURIComponent(e.id)}/open`, {}, key ? { headers: { "x-rushes-here": key } } : undefined);
      if (r.opened) {
        setPanel(null);
        toast(`Opened ${agentName(r.agent)} in a terminal on ${r.host}`);
      } else setPanel(r);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dismiss = async () => {
    try {
      await api.post(`/api/attention/${encodeURIComponent(e.id)}/dismiss`);
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast("Command copied");
    } catch {
      toast("Couldn't reach the clipboard: select the command and copy it");
    }
  };
  return (
    <div class="lattn" data-entry={e.id} data-attention="">
      <div class="lattn-row">
        <span class="ltime">{time}</span>
        <span class="lattn-ic" role="img" aria-label="Needs your attention"><Icon name="alert" /></span>
        <button type="button" class="lattn-go" aria-label={`Needs your attention: ${e.text}. Go back to the agent`} aria-busy={busy} onClick={() => void open()}>
          <span class="lattn-text" dir="auto">{e.text}</span>
          <span class="lattn-sub">Needs your attention · back to the agent</span>
        </button>
        <button type="button" class="btn lattn-x" onClick={() => void dismiss()}>Dismiss</button>
      </div>
      {panel && (
        <div class="lattn-panel" role="group" aria-label="Go back to the agent">
          {panel.command && (
            <div class="lattn-cmd">
              <code dir="ltr">{panel.command}</code>
              <button type="button" class="btn" onClick={() => void copy(panel.command!)}>Copy</button>
            </div>
          )}
          <p class="lattn-where">{resumeWhere(panel)}</p>
        </div>
      )}
    </div>
  );
}
