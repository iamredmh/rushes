// §28, 5.3: the agent menu (look B), opened from the agent's name in the Send to AI row. Five short parts: which agent
// Send sends to (and whether it is signed in), a fresh conversation when there is one to leave, what the agent may do
// without asking, the Always rules, and what switching off does. The row (AgentRow) talks to the server; this draws.
import { Fragment } from "preact";
import { MENU_WORDS, PERMISSION_CHOICES, ruleRows, type MenuAgent } from "../../agent.js";
import type { AgentId, AgentRules, AgentStatus, AlwaysRule } from "../../types.js";
import { Icon } from "../Icon.js";
import type { Menu } from "../desk/useMenu.js";

export interface AgentMenuProps {
  menu: Menu;
  status: AgentStatus;
  /** The installed agents (menuAgents). */
  agents: readonly MenuAgent[];
  /** Why the server refused an agent (409, not signed in), shown under that agent's row. */
  refused: { agent: AgentId; message: string } | null;
  onPick(agent: AgentId): void;
  onSignIn(agent: AgentId): void;
  onFresh(): void;
  onPermissions(permissions: AgentRules["permissions"]): void;
  onRemove(rule: AlwaysRule): void;
}

/** The tick a chosen row carries, in a fixed-width slot so the names line up. */
const Tick = ({ on }: { on: boolean }) => <span class="atick" aria-hidden="true">{on && <Icon name="check" />}</span>;

export function AgentMenu({ menu, status, agents, refused, onPick, onSignIn, onFresh, onPermissions, onRemove }: AgentMenuProps) {
  // Rows in the order the arrows move through them (menuRowCount counts the same ones).
  let i = 0;
  const rules = ruleRows(status);
  return (
    <div class="dmenu amenu" role="menu" aria-label="Send to AI" onKeyDown={menu.onKeyDown}>
      <div class="hd">{MENU_WORDS.sendTo}</div>
      {agents.map((a) => (
        <Fragment key={a.id}>
          <div class="mrow">
            <button ref={menu.row(i++)} type="button" role="menuitemradio" class="mi" tabIndex={-1} aria-checked={a.current} onClick={() => onPick(a.id)}>
              <Tick on={a.current} />
              <span class="nm">{a.name}</span>
              <span class={`c fn${a.signedIn ? "" : " todo"}`}>{a.signedIn ? MENU_WORDS.signedIn : `${MENU_WORDS.notSignedIn} ·`}</span>
            </button>
            {!a.signedIn && (
              <button ref={menu.row(i++)} type="button" role="menuitem" class="mi alink" tabIndex={-1} onClick={() => onSignIn(a.id)}>
                {MENU_WORDS.signIn}
              </button>
            )}
          </div>
          {refused?.agent === a.id && (
            <p class="aerr" role="alert">
              {refused.message}
            </p>
          )}
        </Fragment>
      ))}
      {status.session && (
        <>
          <hr />
          <button ref={menu.row(i++)} type="button" role="menuitem" class="mi" tabIndex={-1} onClick={onFresh}>
            <Icon name="refresh" />
            <span class="nm">{MENU_WORDS.fresh}</span>
          </button>
        </>
      )}
      <hr />
      <div class="hd">{MENU_WORDS.may}</div>
      {PERMISSION_CHOICES.map((p) => (
        <button key={p.value} ref={menu.row(i++)} type="button" role="menuitemradio" class="mi" tabIndex={-1} aria-checked={status.permissions === p.value} onClick={() => onPermissions(p.value)}>
          <Tick on={status.permissions === p.value} />
          <span class="nm">{p.label}</span>
        </button>
      ))}
      <hr />
      <div class="hd">{MENU_WORDS.always}</div>
      {rules.length === 0 && <p class="anote">{MENU_WORDS.noRules}</p>}
      {rules.map(({ rule, label }) => (
        <div class="mrow arule" key={`${rule.kind} ${rule.command ?? ""}`}>
          <span class="nm">{label}</span>
          <button ref={menu.row(i++)} type="button" role="menuitem" class="mi alink" tabIndex={-1} aria-label={`${MENU_WORDS.remove} ${label}`} onClick={() => onRemove(rule)}>
            {MENU_WORDS.remove}
          </button>
        </div>
      ))}
      <hr />
      <p class="anote">{MENU_WORDS.footer}</p>
    </div>
  );
}
