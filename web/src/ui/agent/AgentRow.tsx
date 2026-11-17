// §28, 5.3: the Send to AI row in the notes panel's foot, above Send. The agent's name opens the agent menu (AgentMenu);
// the switch on the right turns Send to AI on and off. With no agent chosen the row is the way in, "Set up Send to AI".
// Every change goes to the server, and the status it answers is folded in at once (the SSE event follows).
import type { MutableRef } from "preact/hooks";
import { useEffect, useRef, useState } from "preact/hooks";
import { menuAgents, menuRowCount, rowText } from "../../agent.js";
import { api, ApiError } from "../../api.js";
import type { AgentId, AgentInfo, AgentRules, AgentStatus, AlwaysRule } from "../../types.js";
import { Icon } from "../Icon.js";
import { useMenu } from "../desk/useMenu.js";
import { AgentMenu } from "./AgentMenu.js";

/** What the desk gives the notes panel for the row (PanelShared.agent). */
export interface AgentPanel {
  status: AgentStatus;
  /** "Set up Send to AI": opens the first-Send sheet (task 4). Until that is built, the desk opens the agent menu. */
  onSetUp(): void;
  /** The row puts its menu's opener here, so the desk can open the menu. */
  menu: MutableRef<(() => void) | null>;
  /** A status an agent route just answered with. */
  onStatus(status: AgentStatus): void;
  toast(message: string): void;
}

/** A refusal the menu shows under the agent's row: the agent isn't signed in (or installed) now. */
const isRefusal = (e: unknown): e is ApiError => e instanceof ApiError && e.status === 409 && (e.code === "agent_not_signed_in" || e.code === "agent_not_installed");

export function AgentRow({ status, onSetUp, menu: opener, onStatus, toast }: AgentPanel) {
  const [detected, setDetected] = useState<AgentInfo[] | null>(null);
  const [refused, setRefused] = useState<{ agent: AgentId; message: string } | null>(null);
  const agents = menuAgents(detected, status);
  const menu = useMenu(menuRowCount(status, agents));

  const detect = (fresh: boolean) =>
    void api
      .get<{ agents: AgentInfo[] }>(`/api/agent/detect${fresh ? "?fresh=1" : ""}`)
      .then((r) => setDetected(r.agents))
      .catch(() => undefined);
  // Known before the menu first opens, so its rows are there to take focus; checked again (fresh) each time it opens,
  // so an agent just signed in to says so.
  useEffect(() => detect(false), []);
  const show = () => {
    setRefused(null);
    detect(true);
    menu.show(0);
  };
  // The desk's opener reaches this row's menu while it is mounted (one notes panel is on screen at a time).
  const latest = useRef(show);
  latest.current = show;
  useEffect(() => {
    const open = () => latest.current();
    opener.current = open;
    return () => {
      if (opener.current === open) opener.current = null;
    };
  }, [opener]);

  /** A setup change; a refusal for an agent shows under its row, with the menu open. */
  const setup = async (body: { on: boolean; agent?: AgentId; permissions?: AgentRules["permissions"] }, agent: AgentId | null): Promise<boolean> => {
    try {
      onStatus((await api.post<{ status: AgentStatus }>("/api/agent/setup", body)).status);
      return true;
    } catch (e) {
      if (isRefusal(e) && agent) {
        if (!menu.open) show();
        setRefused({ agent, message: e.message });
      } else toast((e as Error).message);
      return false;
    }
  };
  const call = async (run: () => Promise<{ status: AgentStatus }>) => {
    try {
      onStatus((await run()).status);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const pick = async (agent: AgentId) => {
    setRefused(null);
    if (agent === status.agent && status.on) return menu.close(true);
    if (await setup({ on: true, agent }, agent)) menu.close(true);
  };
  const signIn = (agent: AgentId) => void api.post("/api/agent/sign-in", { agent }).catch((e: Error) => toast(e.message));
  const fresh = async () => {
    menu.close(true);
    await call(() => api.post("/api/agent/fresh"));
  };
  // A setting: the menu stays open, ticked where it is.
  const permissions = (p: AgentRules["permissions"]) => void setup({ on: status.on, permissions: p }, status.agent);
  const remove = (rule: AlwaysRule) => void call(() => api.del("/api/agent/always", rule));

  const text = rowText(status);
  return (
    <div class="agentrow">
      <span class="mwrap" ref={menu.wrap}>
        <button
          ref={menu.button}
          type="button"
          class="aname"
          aria-haspopup={status.agent ? "menu" : undefined}
          aria-expanded={menu.open}
          onClick={() => (menu.open ? menu.close(false) : status.agent ? show() : onSetUp())}
        >
          <span class="alabel">{text}</span>
          {status.agent && <Icon name="chev" />}
        </button>
        {menu.open && (
          <AgentMenu
            menu={menu}
            status={status}
            agents={agents}
            refused={refused}
            onPick={(a) => void pick(a)}
            onSignIn={signIn}
            onFresh={() => void fresh()}
            onPermissions={permissions}
            onRemove={remove}
          />
        )}
      </span>
      {status.agent && (
        <button type="button" role="switch" class="aswitch" aria-label="Send to AI" aria-checked={status.on} onClick={() => void setup({ on: !status.on }, status.agent)} />
      )}
    </div>
  );
}
